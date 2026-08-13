/**
 * Live tests for how Hookdeck treats a signature at the edge.
 *
 * No local endpoint is involved: the question is what Hookdeck did with the
 * request, which the request record answers. Delivery into the node lives in
 * `delivery.test.mjs`.
 *
 * Vendor secrets are generated per run. Hookdeck verifies with the same
 * algorithm whether a secret came from Stripe or from `randomBytes`, so a live
 * credential proves nothing extra here — `stripe.test.mjs` covers the genuine
 * Stripe path, including the `t,v1,v0` header real traffic carries.
 *
 *   npm run test:live
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import { HookdeckEventGatewayTrigger } from '../../dist/nodes/Hookdeck/HookdeckEventGatewayTrigger.node.js';
import {
	cleanUpRun,
	connectionForSource,
	ingest,
	liveHookContext,
	liveWebhookContext,
	PREFIX,
	requestFor,
	skip,
	wasVerified,
} from './_harness.mjs';

/** Provision a source through the node's own `create()`. */
async function provision(sourceName, params) {
	const staticData = {};
	const ctx = liveHookContext({
		webhookUrl: 'https://example.com/webhook/live',
		staticData,
		params: {
			source: sourceName,
			sourceType: 'WEBHOOK',
			verification: 'none',
			options: { verifySignature: true },
			...params,
		},
	});
	await new HookdeckEventGatewayTrigger().webhookMethods.default.create.call(ctx);
	const connection = await connectionForSource(sourceName);
	return { connection, staticData, ingestUrl: connection.source.url };
}

test('vendor signature verification at the edge', { skip, concurrency: false }, async (t) => {
	t.after(cleanUpRun);

	await t.test('a Stripe-typed source verifies a correctly signed payload', async () => {
		const secret = `whsec_${randomBytes(16).toString('hex')}`;
		const { connection, ingestUrl } = await provision(`${PREFIX}-stripe`, {
			sourceType: 'STRIPE',
			platformSecret: secret,
		});

		const marker = `stripe-ok-${PREFIX}`;
		const body = JSON.stringify({ id: 'evt_live', type: 'payment_intent.succeeded', marker });
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

		const accepted = await ingest(ingestUrl, body, {
			'Stripe-Signature': `t=${timestamp},v1=${signature}`,
		});
		assert.ok(accepted.ok, `a correctly signed Stripe payload was refused: ${accepted.status}`);
		assert.equal(
			await wasVerified(connection.source.id, marker),
			true,
			'a correctly signed Stripe payload was not marked verified',
		);
	});

	await t.test('a Stripe-typed source marks a forged payload unverified', async () => {
		const secret = `whsec_${randomBytes(16).toString('hex')}`;
		const { connection, ingestUrl } = await provision(`${PREFIX}-stripe-forge`, {
			sourceType: 'STRIPE',
			platformSecret: secret,
		});

		const marker = `stripe-forged-${PREFIX}`;
		const timestamp = Math.floor(Date.now() / 1000);
		const forged = await ingest(ingestUrl, JSON.stringify({ id: 'evt_forged', marker }), {
			'Stripe-Signature': `t=${timestamp},v1=${'0'.repeat(64)}`,
		});

		// A Stripe-typed source answers 200 to a forged payload and records the
		// verdict on the request instead. This is the README's "the status code is
		// not the verdict" warning, asserted rather than assumed — and it is not
		// uniform across source types, since GitHub refuses outright below.
		assert.equal(forged.status, 200, 'Stripe verification failures are answered at the edge');

		const request = await requestFor(connection.source.id, marker);
		assert.equal(request.verified, false, 'a forged Stripe signature was marked verified');
		assert.equal(
			request.rejection_cause,
			'VERIFICATION_FAILED',
			'the refusal reason is the only machine-readable signal a 200 leaves behind',
		);
	});

	await t.test('a GitHub-typed source verifies its own, differently shaped scheme', async () => {
		const secret = randomBytes(20).toString('hex');
		const { connection, ingestUrl } = await provision(`${PREFIX}-github`, {
			sourceType: 'GITHUB',
			platformSecret: secret,
		});

		const marker = `github-ok-${PREFIX}`;
		const body = JSON.stringify({ action: 'opened', marker });
		const signature = createHmac('sha256', secret).update(body).digest('hex');

		const accepted = await ingest(ingestUrl, body, {
			'X-Hub-Signature-256': `sha256=${signature}`,
			'X-GitHub-Event': 'pull_request',
		});
		assert.ok(accepted.ok, `a correctly signed GitHub payload was refused: ${accepted.status}`);
		assert.equal(await wasVerified(connection.source.id, marker), true);

		const forged = await ingest(ingestUrl, JSON.stringify({ action: 'forged' }), {
			'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
		});
		assert.equal(forged.ok, false, 'a forged GitHub signature was accepted at the edge');
	});

	await t.test('a platform source with no secret accepts an unsigned payload', async () => {
		// The trap the README describes. If this ever starts failing, that section
		// is out of date and should be rewritten.
		const { connection, ingestUrl } = await provision(`${PREFIX}-bare`, { sourceType: 'STRIPE' });

		const marker = `bare-${PREFIX}`;
		const accepted = await ingest(ingestUrl, JSON.stringify({ forged: true, marker }));

		assert.ok(accepted.ok, 'an unconfigured platform source rejected traffic');
		assert.equal(
			await wasVerified(connection.source.id, marker),
			false,
			'an unsigned payload was reported verified',
		);
	});

	await t.test('the node rejects a forged Hookdeck-to-n8n signature with 401', async () => {
		const { staticData } = await provision(`${PREFIX}-forged`, {});
		const ctx = liveWebhookContext({
			rawBody: Buffer.from('{"forged":true}'),
			headers: {
				'content-type': 'application/json',
				'x-hookdeck-n8n-signature': 'not-a-real-signature',
			},
			staticData,
			options: { verifySignature: true },
		});

		const outcome = await new HookdeckEventGatewayTrigger().webhook.call(ctx);
		assert.equal(outcome.noWebhookResponse, true, 'a forged delivery was accepted');
		assert.equal(ctx.sent.status, 401);
	});

	await t.test('the node rejects a body that is not valid UTF-8 with 400', async () => {
		const { staticData } = await provision(`${PREFIX}-malformed`, {});
		const ctx = liveWebhookContext({
			rawBody: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
			headers: { 'content-type': 'application/json' },
			staticData,
			options: { verifySignature: false },
		});

		const outcome = await new HookdeckEventGatewayTrigger().webhook.call(ctx);
		assert.equal(outcome.noWebhookResponse, true, 'invalid UTF-8 was accepted');
		assert.equal(ctx.sent.status, 400, 'README specifies 400, outside the retryable range');
	});
});
