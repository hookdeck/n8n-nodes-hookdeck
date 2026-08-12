/**
 * Live tests against the Hookdeck API.
 *
 * The unit suite drives the trigger against a stub, which can prove the node
 * *sends* `source_id` but not that Hookdeck *treats* it the way the node
 * assumes. The whole point of binding by ID is that the API leaves an existing
 * source alone, and only the API can confirm that.
 *
 * Skipped unless HOOKDECK_EG_API_KEY is set, so the default `npm test` needs no
 * credentials and forks are unaffected. Point it at a throwaway Event Gateway
 * project: every run creates and deletes real sources, destinations and
 * connections.
 *
 *   HOOKDECK_EG_API_KEY=... npm run test:integration
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { HookdeckEventGatewayTrigger } from '../dist/nodes/Hookdeck/HookdeckEventGatewayTrigger.node.js';
import { HookdeckEventGateway } from '../dist/nodes/Hookdeck/HookdeckEventGateway.node.js';

const API_KEY = process.env.HOOKDECK_EG_API_KEY;
const BASE_URL = 'https://api.hookdeck.com/2025-07-01';

// One suffix per run, so concurrent runs on different branches cannot collide
// on a source name — which, given the behaviour under test, is exactly the kind
// of collision that would make a result meaningless.
const RUN_ID = randomBytes(4).toString('hex');

const skip = API_KEY ? false : 'HOOKDECK_EG_API_KEY is not set';

/** Call the Hookdeck API directly, for arranging fixtures and asserting state. */
async function api(method, path, body) {
	const response = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await response.text();
	const parsed = text ? JSON.parse(text) : {};
	if (!response.ok) {
		throw new Error(`${method} ${path} → HTTP ${response.status}: ${text}`);
	}
	return parsed;
}

/**
 * An IHookFunctions whose HTTP helper reaches the real API.
 *
 * Everything else is the same shape the unit suite uses, so the code under test
 * is the node's own `create()` rather than a reimplementation of it.
 */
function liveHookContext({ webhookUrl, staticData, params }) {
	const warnings = [];
	return {
		warnings,
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => webhookUrl,
		getMode: () => 'trigger',
		getWorkflow: () => ({ id: `it${RUN_ID}` }),
		getNode: () => ({ id: 'node1', name: 'Hookdeck Event Gateway Trigger' }),
		getNodeParameter: (name, fallback) => (name in params ? params[name] : fallback),
		getInstanceId: () => 'inst12345678abcdef',
		logger: {
			debug() {},
			warn: (message) => warnings.push(message),
			error() {},
			info: (message) => warnings.push(message),
		},
		helpers: {
			async httpRequestWithAuthentication(_credentialType, options) {
				const url = new URL(options.url);
				for (const [key, value] of Object.entries(options.qs ?? {})) {
					if (value !== undefined) url.searchParams.set(key, String(value));
				}

				const response = await fetch(url, {
					method: options.method,
					headers: {
						Authorization: `Bearer ${API_KEY}`,
						'Content-Type': 'application/json',
					},
					body: options.body === undefined ? undefined : JSON.stringify(options.body),
				});

				const text = await response.text();
				return { statusCode: response.status, body: text ? JSON.parse(text) : '' };
			},
		},
	};
}

/** Remove everything a test created, newest dependency first. */
async function cleanUp(sourceName) {
	const { models: connections = [] } = await api('GET', `/connections?limit=100`);
	for (const connection of connections) {
		if (connection.source?.name === sourceName) {
			await api('DELETE', `/connections/${connection.id}`);
			if (connection.destination?.id) {
				await api('DELETE', `/destinations/${connection.destination.id}`);
			}
		}
	}

	const { models: sources = [] } = await api('GET', `/sources?name=${sourceName}`);
	for (const source of sources) await api('DELETE', `/sources/${source.id}`);
}

/** Create a verified STRIPE source, standing in for one a user already had. */
async function seedStripeSource(sourceName) {
	await api('PUT', '/connections', {
		name: `seed-${RUN_ID}`,
		source: {
			name: sourceName,
			type: 'STRIPE',
			config: { auth: { webhook_secret_key: `whsec_${RUN_ID}` } },
		},
		destination: {
			name: `seed-dest-${RUN_ID}`,
			type: 'HTTP',
			config: { url: 'https://example.com/seed' },
		},
	});

	const { models } = await api('GET', `/sources?name=${sourceName}`);
	assert.equal(models.length, 1, 'seed source was not created');
	assert.equal(models[0].type, 'STRIPE');
	return models[0];
}

test('an existing source survives provisioning untouched', { skip }, async (t) => {
	const sourceName = `n8n-it-adopt-${RUN_ID}`;
	t.after(() => cleanUp(sourceName));

	const before = await seedStripeSource(sourceName);

	// The trigger's defaults — generic WEBHOOK, no verification. Before binding by
	// ID, these were sent inline and rewrote the source, silently dropping Stripe
	// signature verification for every connection fed by it.
	const ctx = liveHookContext({
		webhookUrl: `https://example.com/webhook/${RUN_ID}`,
		staticData: {},
		params: { source: sourceName, sourceType: 'WEBHOOK', verification: 'none' },
	});

	const { create } = new HookdeckEventGatewayTrigger().webhookMethods.default;
	await create.call(ctx);

	const { models } = await api('GET', `/sources?name=${sourceName}`);
	assert.equal(models.length, 1, 'a second source was created instead of adopting the first');

	const after = models[0];
	assert.equal(after.id, before.id, 'bound to a different source');
	assert.equal(after.type, 'STRIPE', 'source type was rewritten');
	assert.equal(
		after.config?.auth?.webhook_secret_key ?? after.verification?.webhook_secret_key,
		before.config?.auth?.webhook_secret_key ?? before.verification?.webhook_secret_key,
		'verification secret was rewritten',
	);

	assert.equal(ctx.warnings.length, 1);
	assert.match(ctx.warnings[0], /rather than WEBHOOK/);
});

test('Update Existing Source does rewrite it, on purpose', { skip }, async (t) => {
	// The counterpart to the test above. It also pins down that the API really
	// does overwrite on an inline source — so the default path is guarding against
	// something real, not a behaviour that was fixed upstream.
	const sourceName = `n8n-it-update-${RUN_ID}`;
	t.after(() => cleanUp(sourceName));

	await seedStripeSource(sourceName);

	const ctx = liveHookContext({
		webhookUrl: `https://example.com/webhook/${RUN_ID}`,
		staticData: {},
		params: {
			source: sourceName,
			sourceType: 'WEBHOOK',
			verification: 'none',
			options: { updateExistingSource: true },
		},
	});

	const { create } = new HookdeckEventGatewayTrigger().webhookMethods.default;
	await create.call(ctx);

	const { models } = await api('GET', `/sources?name=${sourceName}`);
	assert.equal(models[0].type, 'WEBHOOK', 'opting in did not apply the node settings');
});

test('provisioning a new source creates it as configured', { skip }, async (t) => {
	const sourceName = `n8n-it-create-${RUN_ID}`;
	t.after(() => cleanUp(sourceName));

	const ctx = liveHookContext({
		webhookUrl: `https://example.com/webhook/${RUN_ID}`,
		staticData: {},
		params: { source: sourceName, sourceType: 'STRIPE', platformSecret: `whsec_${RUN_ID}` },
	});

	const { create } = new HookdeckEventGatewayTrigger().webhookMethods.default;
	await create.call(ctx);

	const { models } = await api('GET', `/sources?name=${sourceName}`);
	assert.equal(models.length, 1);
	assert.equal(models[0].type, 'STRIPE');

	// The public URL is the whole point of the node, and it only exists once the
	// source does.
	assert.match(models[0].url, /^https:\/\/hkdk\.events\//);
	assert.deepEqual(ctx.warnings, []);
});

test('an unreachable n8n provisions a CLI destination Hookdeck accepts', { skip }, async (t) => {
	// The unit suite proves the node *sends* a CLI destination. Only the API can
	// confirm Hookdeck accepts that shape — a CLI destination rejects the rate
	// limiting fields an HTTP one takes, so getting this wrong fails activation.
	const sourceName = `n8n-it-cli-${RUN_ID}`;
	t.after(() => cleanUp(sourceName));

	const ctx = liveHookContext({
		// Deliberately unreachable, which is the whole point.
		webhookUrl: `http://localhost:5678/webhook/${RUN_ID}/webhook`,
		staticData: {},
		params: {
			source: sourceName,
			sourceType: 'WEBHOOK',
			verification: 'none',
			// Set the options a CLI destination cannot honour, to prove they are
			// dropped rather than sent and rejected.
			options: { rateLimit: 10, deliveryGroupKey: 'body.id' },
		},
	});

	const { create } = new HookdeckEventGatewayTrigger().webhookMethods.default;
	await create.call(ctx);

	const { models } = await api('GET', `/connections?limit=100`);
	const connection = models.find((c) => c.source?.name === sourceName);
	assert.ok(connection, 'connection was not created');

	assert.equal(connection.destination.type, 'CLI');
	assert.equal(connection.destination.config.path, `/webhook/${RUN_ID}/webhook`);
	assert.equal(connection.destination.config.auth_type, 'CUSTOM_SIGNATURE');
	assert.equal(connection.destination.config.url, undefined);
	assert.equal(connection.destination.config.rate_limit, undefined);
	assert.equal(connection.destination.config.delivery_groups, undefined);

	// Retries are the only thing that recovers an event delivered while the CLI
	// was down, so they must be on this connection too.
	assert.ok(connection.rules.some((r) => r.type === 'retry'), 'no retry rule on the CLI connection');

	const setup = ctx.warnings.join('\n');
	assert.match(setup, /hookdeck listen 5678/);
	assert.match(setup, /Delivery Rate Limit and Delivery Group Key are not applied/);
});

test('Source Create returns the public URL the provider needs', { skip }, async (t) => {
	// The point of the operation: the URL only exists once the source does, so
	// creating it from a workflow is the one way to get it as data.
	const sourceName = `n8n-it-create-op-${RUN_ID}`;
	t.after(() => cleanUp(sourceName));

	const ctx = {
		getInputData: () => [{ json: {} }],
		continueOnFail: () => false,
		getNode: () => ({ name: 'Hookdeck Event Gateway' }),
		logger: { debug() {}, warn() {}, error() {}, info() {} },
		getNodeParameter: (name, _i, fallback) =>
			({ resource: 'source', operation: 'create', sourceName, sourceType: 'STRIPE' }[name] ??
			fallback),
		helpers: {
			async httpRequestWithAuthentication(_c, options) {
				const url = new URL(options.url);
				for (const [k, v] of Object.entries(options.qs ?? {})) url.searchParams.set(k, String(v));
				const res = await fetch(url, {
					method: options.method,
					headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
					body: options.body === undefined ? undefined : JSON.stringify(options.body),
				});
				const text = await res.text();
				return { statusCode: res.status, body: text ? JSON.parse(text) : '' };
			},
		},
	};

	const output = await new HookdeckEventGateway().execute.call(ctx);
	const created = output[0][0].json;

	assert.equal(created.name, sourceName);
	assert.equal(created.type, 'STRIPE');
	assert.match(created.url, /^https:\/\/hkdk\.events\//);

	// Source names are unique per project, so POST answers 409 the second time.
	// Running the operation again must adopt the existing source, not fail, and
	// must not rewrite it the way an upsert would.
	const again = await new HookdeckEventGateway().execute.call(ctx);
	assert.equal(again[0][0].json.id, created.id, 're-running created a different source');
	assert.equal(again[0][0].json.type, 'STRIPE');
	assert.equal(again[0][0].json.url, created.url);
});
