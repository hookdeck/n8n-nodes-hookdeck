/**
 * Live tests for what provisioning does to a source that already exists, and
 * which destination shape it picks.
 *
 * The unit suite can prove the trigger *sends* `source_id` when a source
 * already exists, but not that Hookdeck leaves that source alone in response —
 * and the whole reason for binding by ID is that it does. Likewise it proves the
 * node sends a CLI destination for an unreachable n8n, but only the API can
 * confirm Hookdeck accepts that shape.
 *
 * Options and the action-node operation table are covered by `api.test.mjs`;
 * signatures by `verification.test.mjs`.
 *
 *   npm run test:live
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { HookdeckEventGatewayTrigger } from '../../dist/nodes/Hookdeck/HookdeckEventGatewayTrigger.node.js';
import { HookdeckEventGateway } from '../../dist/nodes/Hookdeck/HookdeckEventGateway.node.js';
import {
	PREFIX,
	RUN_ID,
	api,
	cleanUpRun,
	connectionForSource,
	liveExecuteContext,
	liveHookContext,
	ingest,
	skip,
	wasVerified,
} from './_harness.mjs';

const { create } = new HookdeckEventGatewayTrigger().webhookMethods.default;

/** Create a verified STRIPE source, standing in for one a user already had. */
async function seedStripeSource(sourceName) {
	await api('PUT', '/connections', {
		name: `${PREFIX}-seed`,
		source: {
			name: sourceName,
			type: 'STRIPE',
			config: { auth: { webhook_secret_key: `whsec_${RUN_ID}` } },
		},
		destination: {
			name: `${PREFIX}-seed-dest`,
			type: 'HTTP',
			config: { url: 'https://example.com/seed' },
		},
	});

	const { models } = await api('GET', `/sources?name=${sourceName}`);
	assert.equal(models.length, 1, 'seed source was not created');
	assert.equal(models[0].type, 'STRIPE');
	return models[0];
}

/** The secret, wherever this API version chose to put it. */
const secretOf = (source) =>
	source.config?.auth?.webhook_secret_key ?? source.verification?.webhook_secret_key;

test('provisioning against an existing source', { skip, concurrency: false }, async (t) => {
	t.after(cleanUpRun);

	await t.test('an existing source survives provisioning untouched', async () => {
		const sourceName = `${PREFIX}-adopt`;
		const before = await seedStripeSource(sourceName);

		// The trigger's defaults — generic WEBHOOK, no verification. Before binding
		// by ID these were sent inline and rewrote the source, silently dropping
		// Stripe signature verification for every connection fed by it.
		const ctx = liveHookContext({
			webhookUrl: `https://example.com/webhook/${RUN_ID}`,
			staticData: {},
			params: { source: sourceName, sourceType: 'WEBHOOK', verification: 'none' },
		});
		await create.call(ctx);

		const { models } = await api('GET', `/sources?name=${sourceName}`);
		assert.equal(models.length, 1, 'a second source was created instead of adopting the first');

		const after = models[0];
		assert.equal(after.id, before.id, 'bound to a different source');
		assert.equal(after.type, 'STRIPE', 'source type was rewritten');
		assert.equal(secretOf(after), secretOf(before), 'verification secret was rewritten');

		assert.equal(ctx.warnings.length, 1);
		assert.match(ctx.warnings[0], /rather than WEBHOOK/);
	});

	await t.test('Update Existing Source does rewrite it, on purpose', async () => {
		// The counterpart to the test above. It also pins down that the API really
		// does overwrite on an inline source, so the default path is guarding
		// against something real rather than a behaviour fixed upstream.
		const sourceName = `${PREFIX}-update`;
		await seedStripeSource(sourceName);

		await create.call(
			liveHookContext({
				webhookUrl: `https://example.com/webhook/${RUN_ID}`,
				staticData: {},
				params: {
					source: sourceName,
					sourceType: 'WEBHOOK',
					verification: 'none',
					options: { updateExistingSource: true },
				},
			}),
		);

		const { models } = await api('GET', `/sources?name=${sourceName}`);
		assert.equal(models[0].type, 'WEBHOOK', 'opting in did not apply the node settings');
	});

	await t.test('a secret is only applied to an existing source on request', async () => {
		// The failure this guards is quiet and total: the secret is accepted, the
		// activation succeeds, and every delivery then arrives unverified. Found
		// by the Stripe suite against a real endpoint, so it is pinned here too.
		const sourceName = `${PREFIX}-latesecret`;
		await create.call(
			liveHookContext({
				webhookUrl: `https://example.com/webhook/${RUN_ID}`,
				staticData: {},
				params: { source: sourceName, sourceType: 'STRIPE', verification: 'none' },
			}),
		);

		const params = {
			source: sourceName,
			sourceType: 'STRIPE',
			verification: 'none',
			platformSecret: `whsec_${RUN_ID}`,
		};

		await create.call(
			liveHookContext({
				webhookUrl: `https://example.com/webhook/${RUN_ID}`,
				staticData: {},
				params,
			}),
		);
		const { models: adopted } = await api('GET', `/sources?name=${sourceName}`);
		assert.equal(
			adopted[0].config?.auth_type ?? null,
			null,
			'a secret was applied to an adopted source without Update Existing Source',
		);

		await create.call(
			liveHookContext({
				webhookUrl: `https://example.com/webhook/${RUN_ID}`,
				staticData: {},
				params: { ...params, options: { updateExistingSource: true } },
			}),
		);
		const { models: updated } = await api('GET', `/sources?name=${sourceName}`);
		assert.equal(updated[0].type, 'STRIPE');
	});

	await t.test('provisioning a new source creates it as configured', async () => {
		const sourceName = `${PREFIX}-create`;
		const ctx = liveHookContext({
			webhookUrl: `https://example.com/webhook/${RUN_ID}`,
			staticData: {},
			params: { source: sourceName, sourceType: 'STRIPE', platformSecret: `whsec_${RUN_ID}` },
		});
		await create.call(ctx);

		const { models } = await api('GET', `/sources?name=${sourceName}`);
		assert.equal(models.length, 1);
		assert.equal(models[0].type, 'STRIPE');

		// The public URL is the whole point of the node, and it only exists once
		// the source does.
		assert.match(models[0].url, /^https:\/\/hkdk\.events\//);
		assert.deepEqual(ctx.warnings, []);
	});

	await t.test('an unreachable n8n provisions a CLI destination Hookdeck accepts', async () => {
		// A CLI destination rejects the rate limiting fields an HTTP one takes, so
		// getting this wrong fails activation outright.
		const sourceName = `${PREFIX}-cli-dest`;
		const ctx = liveHookContext({
			// Deliberately unreachable, which is the whole point.
			webhookUrl: `http://localhost:5678/webhook/${RUN_ID}/webhook`,
			staticData: {},
			params: {
				source: sourceName,
				sourceType: 'WEBHOOK',
				verification: 'none',
				// Options a CLI destination cannot honour, to prove they are dropped
				// rather than sent and rejected.
				options: { rateLimit: 10, deliveryGroupKey: 'body.id' },
			},
		});
		await create.call(ctx);

		const connection = await connectionForSource(sourceName);
		assert.ok(connection, 'connection was not created');

		assert.equal(connection.destination.type, 'CLI');
		assert.equal(connection.destination.config.path, `/webhook/${RUN_ID}/webhook`);
		assert.equal(connection.destination.config.auth_type, 'CUSTOM_SIGNATURE');
		assert.equal(connection.destination.config.url, undefined);
		assert.equal(connection.destination.config.rate_limit, undefined);
		assert.equal(connection.destination.config.delivery_groups, undefined);

		// Retries are the only thing that recovers an event delivered while the CLI
		// was down, so they must be on this connection too.
		assert.ok(
			connection.rules.some((r) => r.type === 'retry'),
			'no retry rule on the CLI connection',
		);

		const setup = ctx.warnings.join('\n');
		assert.match(setup, /hookdeck listen 5678/);
		assert.match(setup, /Delivery Rate Limit and Delivery Group Key are not applied/);
	});

	await t.test('Source Get or Create applies verification, not just a type', async () => {
		// The API cannot answer this: a platform source never echoes `auth_type`,
		// configured or not, so a source with a secret and one without look
		// identical. An inbound request's `verified` field is the only signal, so
		// the check is a real signed payload and a forged one.
		const sourceName = `${PREFIX}-goc-verified`;
		const secret = `whsec_${RUN_ID}`;
		const created = (
			await new HookdeckEventGateway().execute.call(
				liveExecuteContext({
					resource: 'source',
					operation: 'getOrCreate',
					sourceName,
					sourceType: 'STRIPE',
					platformSecret: secret,
					sourceConfigJson: '',
				}),
			)
		)[0][0].json;

		const signed = `goc-signed-${RUN_ID}`;
		const body = JSON.stringify({ type: 'payment_intent.succeeded', marker: signed });
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

		const accepted = await ingest(created.url, body, {
			'Stripe-Signature': `t=${timestamp},v1=${signature}`,
		});
		assert.ok(accepted.ok, `the edge refused a correctly signed payload: ${accepted.status}`);
		assert.equal(
			await wasVerified(created.id, signed),
			true,
			'the secret was accepted and then not applied to the source',
		);

		const unsigned = `goc-unsigned-${RUN_ID}`;
		await ingest(created.url, JSON.stringify({ marker: unsigned }));
		assert.equal(
			await wasVerified(created.id, unsigned),
			false,
			'an unsigned payload was reported verified',
		);
	});

	await t.test('Source Get or Create returns the public URL the provider needs', async () => {
		// The point of the operation: the URL only exists once the source does, so
		// creating it from a workflow is the one way to get it as data.
		const sourceName = `${PREFIX}-create-op`;
		const ctx = liveExecuteContext({
			resource: 'source',
			operation: 'getOrCreate',
			sourceName,
			sourceType: 'STRIPE',
		});

		const created = (await new HookdeckEventGateway().execute.call(ctx))[0][0].json;
		assert.equal(created.name, sourceName);
		assert.equal(created.type, 'STRIPE');
		assert.match(created.url, /^https:\/\/hkdk\.events\//);

		// Source names are unique per project, so POST answers 409 the second time.
		// Running again must adopt the existing source, not fail, and must not
		// rewrite it the way an upsert would.
		const again = (await new HookdeckEventGateway().execute.call(ctx))[0][0].json;
		assert.equal(again.id, created.id, 're-running created a different source');
		assert.equal(again.type, 'STRIPE');
		assert.equal(again.url, created.url);
	});
});
