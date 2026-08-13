/**
 * Live tests for a real event arriving at the node.
 *
 * Deliveries come back over `hookdeck listen`, so the request the node parses is
 * one Hookdeck genuinely sent, metadata headers and all. The CLI destination is
 * re-pointed at the node's own signing secret, so verification is exercised for
 * real rather than switched off.
 *
 * Kept apart from `verification.test.mjs` so the two get separate run ids: a
 * shared prefix means one suite's cleanup deletes the connection the other is
 * still delivering over.
 *
 *   npm run test:live
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HookdeckEventGatewayTrigger } from '../../dist/nodes/Hookdeck/HookdeckEventGatewayTrigger.node.js';
import {
	api,
	cleanUpRun,
	cliConnectionForSource,
	connectionForSource,
	ingest,
	liveHookContext,
	PREFIX,
	hasCommand,
	skip as noApiKey,
	startCliReceiver,
	until,
} from './_harness.mjs';

// Deliveries come back over `hookdeck listen`, so without the CLI this suite
// cannot run at all. Skipping states why; spawning it anyway fails with ENOENT
// and reads like the node is broken.
const skip = noApiKey || (hasCommand('hookdeck') ? false : 'the Hookdeck CLI is not installed');

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

test('real deliveries into the node', { skip, concurrency: false }, async (t) => {
	const sourceName = `${PREFIX}-cli`;
	let receiver;

	t.after(async () => {
		await receiver?.stop();
		await cleanUpRun();
	});

	await t.test('the CLI forwards this source, signed with the node’s own secret', async () => {
		receiver = await startCliReceiver(HookdeckEventGatewayTrigger, sourceName);
		assert.match(receiver.ingestUrl, /^https:\/\/hkdk\.events\//);

		// A CLI destination is signed with the project secret by default, which
		// the node cannot know — so deliveries would have to be trusted unverified.
		// It also accepts CUSTOM_SIGNATURE, so give it the secret the node
		// generated and every assertion below runs through real verification.
		const { staticData } = await provision(sourceName, {});
		const signingSecret = staticData.production?.signingSecret ?? staticData.signingSecret;
		assert.ok(signingSecret, 'the node did not store a signing secret to verify against');

		const connection = await cliConnectionForSource(sourceName);
		await api('PUT', `/destinations/${connection.destination.id}`, {
			config: {
				...connection.destination.config,
				auth_type: 'CUSTOM_SIGNATURE',
				auth: { key: 'x-hookdeck-n8n-signature', signing_secret: signingSecret },
			},
		});

		receiver.setStaticData(staticData);
		receiver.setOptions({ verifySignature: true });
	});

	await t.test('a real event arrives with the documented output shape', async () => {
		const marker = `deliver-${PREFIX}`;
		const payload = { event: 'payment.succeeded', amount: 4200, marker };
		assert.ok((await ingest(receiver.ingestUrl, JSON.stringify(payload))).ok);

		const delivery = await receiver.waitFor(marker);
		assert.ok(!delivery.outcome.noWebhookResponse, 'a genuine delivery was rejected');

		const [item] = delivery.outcome.workflowData[0];
		assert.deepEqual(item.json.body, payload, 'the payload did not survive the round trip');
		assert.ok(item.json.headers, 'headers were not exposed');
		assert.ok(item.json.query, 'query was not exposed');

		// Every field the README's Output block promises.
		const meta = item.json.hookdeck;
		assert.ok(meta, 'no hookdeck metadata block');
		for (const field of [
			'eventId',
			'requestId',
			'attemptCount',
			'attemptTrigger',
			'isLastAttempt',
			'sourceName',
			'idempotencyKey',
		]) {
			assert.ok(field in meta, `README promises hookdeck.${field}`);
		}
		assert.match(meta.eventId, /^evt_/, 'eventId was not parsed from the real header');
		assert.match(meta.requestId, /^req_/, 'requestId was not parsed from the real header');
		assert.equal(meta.sourceName, sourceName);
		assert.equal(meta.attemptTrigger, 'INITIAL');
		assert.equal(typeof meta.isLastAttempt, 'boolean');
		assert.equal(meta.idempotencyKey, meta.eventId, 'README calls this stable across retries');
	});

	await t.test('a refused delivery is retried, and the retry is marked as one', async () => {
		// A CLI connection is created with no rules at all, so without this it
		// would never retry. That the *node* provisions a retry rule is asserted
		// in `api.test.mjs`; what is under test here is that the node reads a real
		// retry's metadata correctly.
		const connection = await cliConnectionForSource(sourceName);
		await api('PUT', `/connections/${connection.id}`, {
			rules: [{ type: 'retry', strategy: 'linear', count: 3, interval: 10000 }],
		});

		const marker = `retry-${PREFIX}`;
		let refusals = 0;
		receiver.setHandler(({ rawBody, res }) => {
			if (!rawBody.toString().includes(marker) || refusals >= 1) return { handled: false };
			refusals++;
			res.writeHead(503).end('receiver down');
			return { handled: true };
		});

		// Asserted, not fired and forgotten: an ingest the edge refused produces no
		// event at all, and the wait below would then blame a retry that was never
		// going to happen.
		const accepted = await ingest(
			receiver.ingestUrl,
			JSON.stringify({ marker, event: 'survives.the.outage' }),
		);
		assert.ok(accepted.ok, `the edge refused the event: ${accepted.status}`);

		const delivered = await receiver.waitFor(marker, { attempts: 150 });
		receiver.setHandler(null);

		assert.equal(refusals, 1, 'the outage was never exercised');
		assert.ok(!delivered.outcome.noWebhookResponse, 'the retried delivery was rejected');

		const meta = delivered.outcome.workflowData[0][0].json.hookdeck;
		assert.ok(
			meta.attemptCount >= 2,
			`the delivery that landed was not a retry (${meta.attemptCount})`,
		);
		// Hookdeck reports an automatic retry as AUTOMATIC, reserving INITIAL for
		// the first attempt. Branching on `attemptTrigger === 'RETRY'` would
		// therefore never fire.
		assert.equal(meta.attemptTrigger, 'AUTOMATIC', 'an automatic retry was not reported as one');
		assert.equal(
			meta.idempotencyKey,
			meta.eventId,
			'the idempotency key must survive a retry, or it is not a deduplication key',
		);
	});

	await t.test('deduplication collapses a repeat event at ingest', async () => {
		// Applied to the CLI connection because that is the one carrying traffic;
		// that the *node* provisions this rule is asserted in `api.test.mjs`.
		const connection = await cliConnectionForSource(sourceName);
		await api('PUT', `/connections/${connection.id}`, {
			rules: [{ type: 'deduplicate', window: 600000, include_fields: ['body'] }],
		});

		const marker = `dedup-${PREFIX}`;
		const body = JSON.stringify({ marker, event: 'charge.succeeded' });
		assert.ok((await ingest(receiver.ingestUrl, body)).ok, 'the edge refused the first event');
		await receiver.waitFor(marker);

		assert.ok((await ingest(receiver.ingestUrl, body)).ok, 'the edge refused the duplicate');
		// Give the duplicate the grace the first delivery needed, so a pass here
		// means suppressed rather than merely slower.
		await new Promise((resolve) => setTimeout(resolve, 20000));

		assert.equal(
			receiver.matching(marker).length,
			1,
			'a duplicate inside the window reached the workflow',
		);
	});

	await t.test('events sent while paused are delivered once resumed', async () => {
		const connection = await cliConnectionForSource(sourceName);
		await api('PUT', `/connections/${connection.id}/pause`);
		await until(
			'the connection to report paused',
			async () => (await api('GET', `/connections/${connection.id}`)).paused_at,
		);

		const marker = `queued-${PREFIX}`;
		const sent = await ingest(
			receiver.ingestUrl,
			JSON.stringify({ marker, event: 'sent.during.downtime' }),
		);
		assert.ok(sent.ok, `the edge refused the event: ${sent.status}`);

		await new Promise((resolve) => setTimeout(resolve, 8000));
		assert.equal(receiver.matching(marker).length, 0, 'a paused connection delivered anyway');

		await api('PUT', `/connections/${connection.id}/unpause`);
		await receiver.waitFor(marker, { attempts: 90 });
	});
});
