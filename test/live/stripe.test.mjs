/**
 * A genuine Stripe webhook, end to end.
 *
 * The other suites sign payloads themselves, which proves the algorithm but not
 * the integration: a hand-rolled signature cannot catch a header Stripe really
 * sends, a payload shape that differs from the docs, or a scheme change. This
 * one makes Stripe do the sending.
 *
 * Requires the Stripe CLI, logged in against a **test-mode** account:
 *
 *   stripe login
 *   npm run test:live:stripe
 *
 * The endpoint's signing secret is read into this process and handed straight to
 * Hookdeck. It is never printed, never written to disk, and the endpoint is
 * deleted on the way out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { HookdeckEventGatewayTrigger } from '../../dist/nodes/Hookdeck/HookdeckEventGatewayTrigger.node.js';
import {
	PREFIX,
	cleanUpRun,
	connectionForSource,
	liveHookContext,
	requestFor,
	skip as noApiKey,
} from './_harness.mjs';

const run = promisify(execFile);

/** Whether the Stripe CLI is present and authenticated. */
async function stripeReady() {
	try {
		const { stdout } = await run('stripe', ['config', '--list']);
		// An authenticated profile carries a key; a bare profile block does not.
		return /test_mode_api_key|live_mode_api_key|device_name/.test(stdout);
	} catch {
		return false;
	}
}

const skip = noApiKey || ((await stripeReady()) ? false : 'the Stripe CLI is not logged in');

test('a genuine Stripe webhook', { skip, concurrency: false }, async (t) => {
	const sourceName = `${PREFIX}-stripe-real`;
	let endpointId;

	t.after(async () => {
		if (endpointId) {
			// --confirm, or the CLI blocks on an interactive prompt and the suite
			// hangs after the assertions have already passed.
			await run('stripe', ['webhook_endpoints', 'delete', endpointId, '--confirm']).catch(() => {});
		}
		await cleanUpRun();
	});

	await t.test('Stripe delivers a signed event that Hookdeck verifies', async () => {
		// 1. Provision the source unverified, purely to learn its ingest URL.
		const staticData = {};
		const params = {
			source: sourceName,
			sourceType: 'STRIPE',
			verification: 'none',
			options: { verifySignature: true },
		};
		await new HookdeckEventGatewayTrigger().webhookMethods.default.create.call(
			liveHookContext({ webhookUrl: 'https://example.com/webhook/live', staticData, params }),
		);
		const { source } = await connectionForSource(sourceName);

		// 2. Point a real Stripe endpoint at it. The secret Stripe returns stays in
		//    this variable and goes straight back out to Hookdeck.
		const created = await run('stripe', [
			'webhook_endpoints',
			'create',
			`--url=${source.url}`,
			'--enabled-events=payment_intent.succeeded',
		]);
		const endpoint = JSON.parse(created.stdout);
		endpointId = endpoint.id;
		assert.ok(endpoint.secret, 'Stripe did not return a signing secret for the endpoint');

		// Checked before anything is triggered, not after. The CLI defaults to test
		// mode, but an account carrying live keys is one flag away from creating a
		// real endpoint and firing real events at it, and `t.after` deleting it
		// afterwards would not undo that.
		assert.equal(
			endpoint.livemode,
			false,
			'refusing to continue: this created a LIVE Stripe webhook endpoint',
		);

		// 3. Re-provision with that secret, so Hookdeck verifies against the real
		//    endpoint rather than one we invented.
		//
		//    `updateExistingSource` is required: provisioning adopts an existing
		//    source untouched by default, so without it the secret is accepted,
		//    silently discarded, and every genuine Stripe delivery then arrives
		//    unverified.
		await new HookdeckEventGatewayTrigger().webhookMethods.default.create.call(
			liveHookContext({
				webhookUrl: 'https://example.com/webhook/live',
				staticData,
				params: {
					...params,
					platformSecret: endpoint.secret,
					options: { ...params.options, updateExistingSource: true },
				},
			}),
		);

		// 4. Make Stripe fire a real event.
		await run('stripe', ['trigger', 'payment_intent.succeeded'], { timeout: 120000 });

		// 5. Assert on what actually arrived.
		const request = await requestFor(source.id, 'payment_intent.succeeded');
		assert.equal(request.verified, true, 'Stripe’s own signature failed verification');
		assert.equal(request.rejection_cause ?? null, null);

		const body =
			typeof request.data.body === 'string' ? JSON.parse(request.data.body) : request.data.body;
		assert.match(body.id, /^evt_/, 'not a genuine Stripe event id');
		assert.equal(body.object, 'event');
		assert.equal(body.type, 'payment_intent.succeeded');
		assert.equal(body.livemode, false, 'this must only ever run against test mode');
		assert.ok(body.data?.object, 'the event carried no object');

		// The documented example shows `t` and `v1`. Real traffic has been observed
		// carrying `v0` alongside them, so record what this account actually sends
		// rather than assuming either shape.
		const signature = request.data.headers['stripe-signature'];
		assert.match(signature, /(^|,)t=\d+/, 'no timestamp in the Stripe signature');
		assert.match(signature, /(^|,)v1=[a-f0-9]{64}/, 'no v1 signature');
		const schemes = signature.split(',').map((part) => part.split('=')[0].trim());
		assert.ok(schemes.includes('v1'), `unexpected Stripe signature schemes: ${schemes.join(',')}`);
		console.log(`      stripe-signature schemes observed: ${schemes.join(', ')}`);
	});
});
