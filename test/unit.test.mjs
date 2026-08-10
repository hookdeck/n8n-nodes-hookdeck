/**
 * Tests for the logic that is easy to get quietly wrong: resource naming under
 * Hookdeck's constraints, the test/production split, signature verification,
 * and the shape of the node descriptions n8n loads.
 *
 * Uses node:test and imports the compiled output, so the suite needs no
 * dependencies of its own — the package must ship with none, and adding a test
 * framework only to devDependencies would still mean more to keep current.
 *
 *   npm run build && npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
	SIGNATURE_HEADER,
	expectsUtf8,
	extractDeliveryMetadata,
	generateSigningSecret,
	isValidUtf8,
	verifySignature,
} from '../dist/nodes/Hookdeck/Delivery.js';
import {
	buildResourceName,
	describeUnreachableWebhookUrl,
	isTestWebhookUrl,
	sanitizeName,
} from '../dist/nodes/Hookdeck/Naming.js';
import { Hookdeck } from '../dist/nodes/Hookdeck/Hookdeck.node.js';
import { HookdeckTrigger } from '../dist/nodes/Hookdeck/HookdeckTrigger.node.js';
import { SOURCE_TYPE_AUTH_FIELDS, SOURCE_TYPE_OPTIONS } from '../dist/nodes/Hookdeck/SourceTypes.js';

/** Hookdeck's own constraint on source, destination and connection names. */
const HOOKDECK_NAME_PATTERN = /^[A-z0-9-_]+$/;

test('sanitizeName strips characters Hookdeck rejects', () => {
	assert.equal(sanitizeName('my source!'), 'my-source-');
	assert.equal(sanitizeName('a.b/c:d'), 'a-b-c-d');
	assert.equal(sanitizeName('Keeps_Valid-123'), 'Keeps_Valid-123');
});

test('buildResourceName produces names Hookdeck accepts', () => {
	const name = buildResourceName('n8n', 'wf.id/123', 'node:abc', false);
	assert.match(name, HOOKDECK_NAME_PATTERN);
	assert.ok(name.length <= 155);
});

test('buildResourceName keeps test and production connections distinct', () => {
	const prod = buildResourceName('n8n', 'wf1', 'node1', false);
	const testName = buildResourceName('n8n', 'wf1', 'node1', true);
	assert.notEqual(prod, testName);
	assert.ok(testName.endsWith('-test'));
});

test('buildResourceName is deterministic, so re-activation upserts', () => {
	assert.equal(
		buildResourceName('n8n', 'wf1', 'node1', false),
		buildResourceName('n8n', 'wf1', 'node1', false),
	);
});

test('buildResourceName truncates without losing the -test suffix', () => {
	// A long workflow id must not push the suffix off the end: if it did, the
	// test connection would collide with the production one and clobber it.
	const long = 'w'.repeat(300);
	const testName = buildResourceName('n8n', long, 'node1', true);
	assert.ok(testName.length <= 155, `length was ${testName.length}`);
	assert.ok(testName.endsWith('-test'));
	assert.notEqual(testName, buildResourceName('n8n', long, 'node1', false));
});

test('isTestWebhookUrl distinguishes the two n8n webhook URL forms', () => {
	assert.equal(isTestWebhookUrl('https://n8n.example.com/webhook-test/abc'), true);
	assert.equal(isTestWebhookUrl('https://n8n.example.com/webhook/abc'), false);
});

test('generateSigningSecret returns distinct high-entropy secrets', () => {
	const a = generateSigningSecret();
	const b = generateSigningSecret();
	assert.equal(a.length, 64);
	assert.notEqual(a, b);
});

test('verifySignature accepts a correct signature', () => {
	const secret = 'topsecret';
	const body = '{"event":"payment.succeeded"}';
	const signature = createHmac('sha256', secret).update(body, 'utf8').digest('base64');
	assert.equal(verifySignature(body, signature, secret), true);
});

test('verifySignature rejects a wrong signature, secret or body', () => {
	const secret = 'topsecret';
	const body = '{"a":1}';
	const good = createHmac('sha256', secret).update(body, 'utf8').digest('base64');

	assert.equal(verifySignature(body, 'not-a-signature', secret), false);
	assert.equal(verifySignature(body, good, 'wrong-secret'), false);
	assert.equal(verifySignature('{"a":2}', good, secret), false);
	assert.equal(verifySignature(body, undefined, secret), false);
	assert.equal(verifySignature(body, '', secret), false);
});

test('verifySignature hashes raw bytes, not a decoded string', () => {
	// Buffer.toString('utf8') substitutes U+FFFD for invalid bytes, so hashing a
	// decoded string yields a different digest and rejects a genuinely signed
	// payload as forged — which then retries until the event is exhausted.
	// 0xC3 0x28 is not valid UTF-8.
	const secret = 's3cret';
	const raw = Buffer.concat([
		Buffer.from('{"name":"'),
		Buffer.from([0xc3, 0x28]),
		Buffer.from('"}'),
	]);
	const signature = createHmac('sha256', secret).update(raw).digest('base64');

	assert.equal(verifySignature(raw, signature, secret), true);

	// The string route yields a different digest, so the assertion above is real.
	const viaString = createHmac('sha256', secret).update(raw.toString('utf8'), 'utf8').digest('base64');
	assert.notEqual(viaString, signature);
});

test('verifySignature accepts a Buffer and an equivalent string alike', () => {
	const secret = 's3cret';
	const body = '{"a":1}';
	const signature = createHmac('sha256', secret).update(Buffer.from(body)).digest('base64');
	assert.equal(verifySignature(Buffer.from(body), signature, secret), true);
	assert.equal(verifySignature(body, signature, secret), true);
});

test('expectsUtf8 holds text payloads to UTF-8 and lets binary through', () => {
	// The UTF-8 check exists to stop silent U+FFFD corruption inside JSON. Applied
	// to a binary body it would instead make that provider undeliverable.
	for (const ct of [
		'application/json',
		'application/json; charset=utf-8',
		'application/vnd.github+json',
		'text/plain',
		'application/x-www-form-urlencoded',
		'application/xml',
		'application/atom+xml',
	]) {
		assert.equal(expectsUtf8({ 'content-type': ct }), true, ct);
	}

	for (const ct of [
		'application/octet-stream',
		'application/gzip',
		'multipart/form-data; boundary=x',
		'image/png',
		'application/protobuf',
	]) {
		assert.equal(expectsUtf8({ 'content-type': ct }), false, ct);
	}

	// A webhook with no declared type is treated as text, which is what it is.
	assert.equal(expectsUtf8({}), true);
});

test('isValidUtf8 rejects bodies Node would silently corrupt', () => {
	// Invalid byte inside a JSON string value: JSON.parse succeeds and the
	// corruption is invisible downstream, which is why this is checked up front.
	const sneaky = Buffer.concat([
		Buffer.from('{"name":"'),
		Buffer.from([0xc3, 0x28]),
		Buffer.from('"}'),
	]);
	assert.equal(isValidUtf8(sneaky), false);
	assert.doesNotThrow(() => JSON.parse(sneaky.toString('utf8')));

	// A lone surrogate encoded CESU-8 style, and a bare continuation byte.
	assert.equal(isValidUtf8(Buffer.from([0xed, 0xa0, 0x80])), false);
	assert.equal(isValidUtf8(Buffer.from([0x80])), false);
});

test('isValidUtf8 accepts well-formed bodies including multibyte text', () => {
	assert.equal(isValidUtf8(Buffer.from('{"a":1}')), true);
	assert.equal(isValidUtf8(Buffer.from('{"name":"café ☕ 日本語 𝄞"}')), true);
	assert.equal(isValidUtf8(Buffer.from('')), true);
});

test('verifySignature accepts either signature during a secret rotation', () => {
	const body = '{"a":1}';
	const oldSig = createHmac('sha256', 'old').update(body, 'utf8').digest('base64');
	const newSig = createHmac('sha256', 'new').update(body, 'utf8').digest('base64');
	// Hookdeck sends space-separated signatures while a secret is rotating.
	assert.equal(verifySignature(body, `${oldSig} ${newSig}`, 'new'), true);
});

test('verifySignature survives a length-mismatched candidate', () => {
	// timingSafeEqual throws on unequal buffer lengths; the guard must catch it
	// rather than letting an exception escape into the webhook handler.
	const body = '{"a":1}';
	assert.doesNotThrow(() => verifySignature(body, 'short', 'secret'));
	assert.equal(verifySignature(body, 'short', 'secret'), false);
});

test('describeUnreachableWebhookUrl rejects addresses Hookdeck cannot reach', () => {
	// Hookdeck delivers over the public internet, so these fail at the API with
	// an opaque "must be a valid uri". Catching them here explains why.
	for (const url of [
		'http://localhost:5678/webhook/abc',
		'http://127.0.0.1:5678/webhook/abc',
		'http://10.0.0.4:5678/webhook/abc',
		'http://192.168.1.10:5678/webhook/abc',
		'http://172.16.5.4:5678/webhook/abc',
		'http://169.254.1.1/webhook/abc',
		'http://my-mac.local:5678/webhook/abc',
	]) {
		assert.ok(describeUnreachableWebhookUrl(url), `should reject ${url}`);
	}
});

test('describeUnreachableWebhookUrl rejects unroutable and IPv6 private addresses', () => {
	for (const url of [
		'http://0.0.0.0:5678/webhook/abc',
		'http://[::1]:5678/webhook/abc',
		'http://[fc00::1]:5678/webhook/abc',
		'http://[fe80::1]:5678/webhook/abc',
		'http://app.localhost:5678/webhook/abc',
	]) {
		assert.ok(describeUnreachableWebhookUrl(url), `should reject ${url}`);
	}
});

test('describeUnreachableWebhookUrl accepts public addresses', () => {
	for (const url of [
		'https://n8n.example.com/webhook/abc',
		'https://abc-def.trycloudflare.com/webhook/abc',
		'http://203.0.113.5/webhook/abc',
		// 172.32 is outside the private 172.16–172.31 range.
		'http://172.32.0.1/webhook/abc',
		// Hostnames that merely start like an IPv6 private range. Matching the
		// fc00::/7 and fe80::/10 prefixes against names would reject these.
		'https://fc-example.com/webhook/abc',
		'https://fedex-integration.com/webhook/abc',
		'https://feb-reports.io/webhook/abc',
		// A public IPv6 address must still be allowed.
		'http://[2606:4700::1111]/webhook/abc',
	]) {
		assert.equal(describeUnreachableWebhookUrl(url), undefined, `should accept ${url}`);
	}
});

test('describeUnreachableWebhookUrl reports an unparseable URL', () => {
	assert.match(describeUnreachableWebhookUrl('not a url'), /not a valid URL/);
});

test('describeUnreachableWebhookUrl rejects CGNAT addresses', () => {
	// 100.64.0.0/10 is what Tailscale hands out, a common way to reach a
	// self-hosted n8n, and it is not routable from Hookdeck.
	for (const url of [
		'http://100.64.0.1:5678/webhook/abc',
		'http://100.100.50.2:5678/webhook/abc',
		'http://100.127.255.254/webhook/abc',
	]) {
		assert.ok(describeUnreachableWebhookUrl(url), `should reject ${url}`);
	}

	// Public 100.x addresses outside the CGNAT block must still pass.
	assert.equal(describeUnreachableWebhookUrl('http://100.63.0.1/webhook/abc'), undefined);
	assert.equal(describeUnreachableWebhookUrl('http://100.128.0.1/webhook/abc'), undefined);
});

test('platform auth fields cover the source types that need a secret', () => {
	// A secret placed in the wrong field is rejected by the API at activation,
	// so the mapping has to come from the spec rather than be assumed.
	assert.equal(SOURCE_TYPE_AUTH_FIELDS.STRIPE[0], 'webhook_secret_key');
	assert.equal(SOURCE_TYPE_AUTH_FIELDS.GITLAB[0], 'api_key');
	assert.equal(SOURCE_TYPE_AUTH_FIELDS.TWITTER[0], 'api_key');

	// Types needing several values cannot be expressed by one secret input.
	assert.ok(SOURCE_TYPE_AUTH_FIELDS.POSTMARK.length > 1);
	assert.deepEqual([...SOURCE_TYPE_AUTH_FIELDS.POSTMARK].sort(), ['password', 'username']);

	// Every mapped type must name at least one field, or the lookup is useless.
	for (const [type, fields] of Object.entries(SOURCE_TYPE_AUTH_FIELDS)) {
		assert.ok(Array.isArray(fields) && fields.length > 0, `${type} has no auth fields`);
	}
});

test('every source type offered in the UI is a real spec value', () => {
	// The auth map and the dropdown are generated from the same schema; a type in
	// the map that the UI never offers would be dead weight, and the reverse
	// would mean offering something unprovisionable.
	const offered = new Set(SOURCE_TYPE_OPTIONS.map((o) => o.value));
	for (const type of Object.keys(SOURCE_TYPE_AUTH_FIELDS)) {
		assert.ok(offered.has(type), `${type} is mapped but not offered in the UI`);
	}
});

test('searchSources does not cap results when a search term is given', async () => {
	// A cap while searching hides sources the user explicitly asked for.
	const { searchSources } = new HookdeckTrigger().methods.listSearch;
	const seen = [];
	const ctx = {
		getNode: () => ({ name: 'Hookdeck Trigger' }),
		helpers: {
			httpRequestWithAuthentication: (_c, options) => {
				seen.push(options.qs?.limit);
				return Promise.resolve({
					statusCode: 200,
					body: { models: [{ id: 'src_1', name: 'alpha', url: 'https://hkdk.events/a' }], pagination: {} },
				});
			},
		},
	};

	await searchSources.call(ctx, 'alpha');
	const whenSearching = seen.pop();
	await searchSources.call(ctx);
	const whenBrowsing = seen.pop();

	// Browsing is bounded; searching asks for a full page and keeps paging.
	assert.ok(whenBrowsing <= 250);
	assert.ok(whenSearching >= whenBrowsing);
});

test('signature header does not collide with Hookdeck own signature', () => {
	// Two different secrets under one header name would make verification
	// ambiguous, so this node's header must be distinct.
	assert.notEqual(SIGNATURE_HEADER, 'x-hookdeck-signature');
});

test('extractDeliveryMetadata reads Hookdeck delivery headers', () => {
	const meta = extractDeliveryMetadata({
		'x-hookdeck-eventid': 'evt_123',
		'x-hookdeck-requestid': 'req_456',
		'x-hookdeck-attempt-count': '3',
		'x-hookdeck-attempt-trigger': 'AUTOMATIC',
		'x-hookdeck-will-retry-after': '60',
		'x-hookdeck-source-name': 'stripe-prod',
		'x-hookdeck-verified': 'true',
		'idempotency-key': 'evt_123',
	});

	assert.equal(meta.eventId, 'evt_123');
	assert.equal(meta.requestId, 'req_456');
	assert.equal(meta.attemptCount, 3);
	assert.equal(meta.attemptTrigger, 'AUTOMATIC');
	assert.equal(meta.sourceName, 'stripe-prod');
	assert.equal(meta.verified, 'true');
	assert.equal(meta.idempotencyKey, 'evt_123');
	assert.equal(meta.isLastAttempt, false);
});

test('extractDeliveryMetadata flags the final attempt', () => {
	// Hookdeck signals the last automatic attempt by omitting will-retry-after.
	// Getting this backwards would send healthy events down a dead-letter branch.
	assert.equal(extractDeliveryMetadata({ 'x-hookdeck-eventid': 'e' }).isLastAttempt, true);
	assert.equal(
		extractDeliveryMetadata({ 'x-hookdeck-eventid': 'e', 'x-hookdeck-will-retry-after': '' })
			.isLastAttempt,
		true,
	);
});

test('extractDeliveryMetadata honours a white-labelled header prefix', () => {
	const meta = extractDeliveryMetadata(
		{ 'x-acme-eventid': 'evt_9', 'x-acme-attempt-count': '1' },
		'x-acme',
	);
	assert.equal(meta.eventId, 'evt_9');
	assert.equal(meta.attemptCount, 1);
});

test('extractDeliveryMetadata copes with missing headers', () => {
	const meta = extractDeliveryMetadata({});
	assert.equal(meta.eventId, undefined);
	assert.equal(meta.attemptCount, undefined);
	assert.equal(meta.isLastAttempt, true);
});

test('extractDeliveryMetadata never emits NaN for a bad attempt count', () => {
	// NaN serialises to null in the workflow item, which reads as "zero
	// attempts" — worse than the field simply being absent.
	const meta = extractDeliveryMetadata({ 'x-hookdeck-attempt-count': 'not-a-number' });
	assert.equal(meta.attemptCount, undefined);
	assert.equal(JSON.parse(JSON.stringify(meta)).attemptCount, undefined);
});

test('source types include the generic and common platform values', () => {
	const values = SOURCE_TYPE_OPTIONS.map((o) => o.value);
	for (const expected of ['WEBHOOK', 'STRIPE', 'SHOPIFY', 'GITHUB']) {
		assert.ok(values.includes(expected), `missing ${expected}`);
	}
	assert.equal(new Set(values).size, values.length, 'duplicate source type values');
});

test('source type options are sorted by display name', () => {
	const names = SOURCE_TYPE_OPTIONS.map((o) => o.name.toLowerCase());
	assert.deepEqual(names, [...names].sort());
});

/** Walk every property, including nested collection options. */
function eachProperty(properties, visit) {
	for (const property of properties) {
		visit(property);
		if (Array.isArray(property.options)) {
			for (const option of property.options) {
				if (option && typeof option === 'object' && 'name' in option && 'type' in option) {
					visit(option);
				}
			}
		}
	}
}

for (const [label, NodeClass] of [
	['Hookdeck', Hookdeck],
	['HookdeckTrigger', HookdeckTrigger],
]) {
	test(`${label} description is structurally valid`, () => {
		const { description } = new NodeClass();

		assert.ok(description.displayName);
		assert.ok(description.name);
		assert.ok(description.icon);
		assert.equal(description.credentials[0].name, 'hookdeckApi');
		assert.equal(description.credentials[0].required, true);

		eachProperty(description.properties, (property) => {
			assert.ok(property.displayName, `missing displayName on ${property.name}`);
			assert.ok(property.name, `missing name on ${property.displayName}`);
			assert.ok(property.type, `missing type on ${property.name}`);
			assert.ok(
				'default' in property,
				`missing default on ${property.name} — n8n needs one for every property`,
			);
		});
	});
}

test('source is a resource locator offering both list and free-text entry', () => {
	const source = new HookdeckTrigger().description.properties.find((p) => p.name === 'source');

	assert.equal(source.type, 'resourceLocator');
	assert.equal(source.required, true);

	const modes = Object.fromEntries(source.modes.map((m) => [m.name, m]));
	// "From list" is what puts each source's URL on screen; "by name" is what
	// still allows creating one that does not exist yet.
	assert.equal(modes.list.typeOptions.searchListMethod, 'searchSources');
	assert.equal(modes.name.type, 'string');

	// Free text must reject characters Hookdeck would refuse, before the API does.
	const rule = modes.name.validation.find((v) => v.type === 'regex');
	const re = new RegExp(rule.properties.regex);
	assert.ok(re.test('stripe-production'));
	assert.ok(!re.test('my source'));
});

test('searchSources labels each source with its public URL', async () => {
	const { searchSources } = new HookdeckTrigger().methods.listSearch;
	const ctx = {
		getNode: () => ({ name: 'Hookdeck Trigger' }),
		helpers: {
			httpRequestWithAuthentication: () =>
				Promise.resolve({
					statusCode: 200,
					body: {
						models: [
							{ id: 'src_zzz', name: 'zeta', url: 'https://hkdk.events/zzz' },
							{ id: 'src_aaa', name: 'alpha', url: 'https://hkdk.events/aaa' },
						],
						pagination: {},
					},
				}),
		},
	};

	const { results } = await searchSources.call(ctx);

	assert.deepEqual(
		results.map((r) => r.value),
		['alpha', 'zeta'],
		'results should be sorted by source name',
	);

	// The URL must be in the rendered label. n8n's resource locator list shows
	// neither `description` nor `url`, so anywhere else it is invisible to the
	// user — and surfacing it is the reason this parameter is a resource locator.
	assert.equal(results[0].name, 'alpha — https://hkdk.events/aaa');
	// The stored value stays the bare name, since that is what provisioning uses.
	assert.equal(results[0].value, 'alpha');

	// n8n renders `url` as an "open" link. It must point at the dashboard, never
	// the ingest endpoint: a browser GET against that is rejected with 405, and
	// linking to your own webhook endpoint invites firing requests at it.
	assert.equal(results[0].url, 'https://dashboard.hookdeck.com/sources/src_aaa');
	assert.ok(!results.some((r) => r.url.includes('hkdk.events')));

	const filtered = await searchSources.call(ctx, 'zet');
	assert.deepEqual(
		filtered.results.map((r) => r.value),
		['zeta'],
	);
});

test('trigger declares the webhook and its full lifecycle', () => {
	const node = new HookdeckTrigger();
	const [webhook] = node.description.webhooks;

	assert.equal(webhook.name, 'default');
	assert.equal(webhook.httpMethod, 'POST');

	// responseMode is an expression so the acknowledgement mode is switchable:
	// sync holds the response until the run finishes (a failure answers 5xx and
	// Hookdeck retries), async_retry acknowledges on receipt.
	assert.match(webhook.responseMode, /^=/, 'responseMode should be an expression');
	assert.match(webhook.responseMode, /ackMode/);
	assert.match(webhook.responseMode, /lastNode/);
	assert.match(webhook.responseMode, /onReceived/);

	const ackMode = node.description.properties.find((p) => p.name === 'ackMode');
	assert.deepEqual(
		ackMode.options.map((o) => o.value),
		['async_retry', 'sync'],
	);

	// n8n's webhook-lifecycle-complete rule requires all three, and a missing
	// delete would leave connections delivering to deactivated workflows.
	for (const method of ['checkExists', 'create', 'delete']) {
		assert.equal(typeof node.webhookMethods.default[method], 'function', `missing ${method}`);
	}
});

test('trigger has no main input, so it can only start a workflow', () => {
	assert.deepEqual(new HookdeckTrigger().description.inputs, []);
});

/**
 * Minimal stand-in for n8n's IHookFunctions, enough to drive the webhook
 * lifecycle. `calls` records every Hookdeck request so a test can assert which
 * connection a pause or delete actually targeted.
 */
function fakeHookContext({ webhookUrl, staticData, params = {} }) {
	const calls = [];
	return {
		calls,
		staticData,
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => webhookUrl,
		// n8n reports 'manual' for a test listen; provisioning on activation is not.
		getMode: () => 'trigger',
		getWorkflow: () => ({ id: 'wf1' }),
		getNode: () => ({ id: 'node1', name: 'Hookdeck Trigger', type: 'hookdeckTrigger' }),
		getNodeParameter: (name, fallback) => (name in params ? params[name] : fallback),
		logger: { debug() {}, warn() {}, error() {} },
		helpers: {
			httpRequestWithAuthentication(_cred, options) {
				calls.push({ method: options.method, url: options.url });
				return Promise.resolve({
					statusCode: 200,
					body: {
						id: options.url.includes('-test') ? 'web_TEST' : 'web_PROD',
						source: { id: 'src_1', url: 'https://hkdk.events/src_1' },
					},
				});
			},
		},
	};
}

// The connection id is decided by the connection *name* in the upsert body,
// which the stub above cannot see, so resolve it from the recorded call.
async function provision(ctx, connectionId) {
	const { create } = new HookdeckTrigger().webhookMethods.default;
	ctx.helpers.httpRequestWithAuthentication = (_cred, options) => {
		ctx.calls.push({ method: options.method, url: options.url, body: options.body });
		return Promise.resolve({
			statusCode: 200,
			body: { id: connectionId, source: { id: 'src_1', url: 'https://hkdk.events/src_1' } },
		});
	};
	await create.call(ctx);
}

test('test and production registrations are stored separately', async () => {
	// Each mode owns its slot. A shared slot would let a "Listen for test event"
	// run overwrite the production connection id, sending the next deactivation
	// at the production connection instead of the test one.
	const staticData = {};
	const params = { source: 'n8n-verify', sourceType: 'WEBHOOK', verification: 'none' };

	await provision(
		fakeHookContext({ webhookUrl: 'https://n8n.example.com/webhook/abc', staticData, params }),
		'web_PROD',
	);
	await provision(
		fakeHookContext({ webhookUrl: 'https://n8n.example.com/webhook-test/abc', staticData, params }),
		'web_TEST',
	);

	assert.equal(staticData.production.connectionId, 'web_PROD');
	assert.equal(staticData.test.connectionId, 'web_TEST');
	assert.notEqual(staticData.production.signingSecret, staticData.test.signingSecret);
});

test('provisioned destination disables path forwarding and signs deliveries', async () => {
	const staticData = {};
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: { source: 'n8n-verify', sourceType: 'WEBHOOK', verification: 'none' },
	});
	await provision(ctx, 'web_PROD');

	const upsert = ctx.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/connections'));
	const destination = upsert.body.destination.config;

	// Hookdeck appends the source request path to the destination URL by default.
	// n8n matches its webhook path exactly, so forwarding turns a provider that
	// posts to <source-url>/events into a 404 loop.
	assert.equal(destination.path_forwarding_disabled, true);
	assert.equal(destination.url, 'https://n8n.example.com/webhook/abc');

	// auth_type without a companion auth object is rejected by the API.
	assert.equal(destination.auth_type, 'CUSTOM_SIGNATURE');
	assert.ok(destination.auth && typeof destination.auth.signing_secret === 'string');
	assert.equal(destination.auth.key, SIGNATURE_HEADER);

	// Defaults must apply even though the user never opened Options.
	const retry = upsert.body.rules.find((r) => r.type === 'retry');
	assert.deepEqual(retry.response_status_codes, ['500-599', '429']);
	assert.ok(upsert.body.rules.some((r) => r.type === 'deduplicate'));
});

test('deleting a test registration leaves production untouched', async () => {
	const staticData = {
		production: { connectionId: 'web_PROD', signingSecret: 'p' },
		test: { connectionId: 'web_TEST', signingSecret: 't' },
	};
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook-test/abc',
		staticData,
		params: { options: {} },
	});

	await new HookdeckTrigger().webhookMethods.default.delete.call(ctx);

	// A test connection points at a URL that dies after 120s, so it is always
	// deleted outright rather than paused.
	assert.ok(
		ctx.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/connections/web_TEST')),
		`expected DELETE of web_TEST, got ${JSON.stringify(ctx.calls)}`,
	);
	assert.ok(!ctx.calls.some((c) => c.url.includes('web_PROD')), 'production must not be touched');
	assert.equal(staticData.test, undefined);
	assert.equal(staticData.production.connectionId, 'web_PROD');
});

test('deactivating production pauses rather than deletes by default', async () => {
	const staticData = { production: { connectionId: 'web_PROD', signingSecret: 'p' } };
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: { options: {} },
	});

	await new HookdeckTrigger().webhookMethods.default.delete.call(ctx);

	assert.ok(ctx.calls.some((c) => c.url.endsWith('/connections/web_PROD/pause')));
	assert.ok(!ctx.calls.some((c) => c.method === 'DELETE'));
	// Kept, so the next activation unpauses this same connection.
	assert.equal(staticData.production.connectionId, 'web_PROD');
});

test('pre-split static data migrates into the production slot', async () => {
	const staticData = { connectionId: 'web_OLD', signingSecret: 'legacy' };
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: { options: {} },
	});

	await new HookdeckTrigger().webhookMethods.default.delete.call(ctx);

	assert.ok(ctx.calls.some((c) => c.url.endsWith('/connections/web_OLD/pause')));
	assert.equal(staticData.connectionId, undefined, 'flat field should be migrated away');
});

test('status filters match the Hookdeck API enums exactly', () => {
	// Values are sent verbatim as query parameters, so a casing slip makes a
	// filter silently match nothing. Sourced from the 2025-07-01 OpenAPI schema:
	//   EventStatus, /requests status, /issues status.
	// Note requests are lowercase while everything else is upper — that
	// inconsistency is Hookdeck's, and it is easy to "tidy up" by mistake.
	const expected = {
		event: ['CANCELLED', 'FAILED', 'HOLD', 'QUEUED', 'SCHEDULED', 'SUCCESSFUL'],
		request: ['accepted', 'rejected'],
		issue: ['ACKNOWLEDGED', 'IGNORED', 'OPENED', 'RESOLVED'],
	};

	const { properties } = new Hookdeck().description;

	for (const [resource, values] of Object.entries(expected)) {
		const filters = properties.find(
			(p) => p.name === 'filters' && p.displayOptions?.show?.resource?.includes(resource),
		);
		const status = filters.options.find((o) => o.name === 'status');
		assert.deepEqual(
			status.options.map((o) => o.value).sort(),
			[...values].sort(),
			`${resource} status filter drifted from the API enum`,
		);
		assert.ok(
			values.includes(status.default),
			`${resource} status default "${status.default}" is not a valid value`,
		);
	}
});

test('action node covers the documented resources and operations', () => {
	const { properties } = new Hookdeck().description;
	const resources = properties.find((p) => p.name === 'resource').options.map((o) => o.value);

	assert.deepEqual(resources.sort(), [
		'attempt',
		'connection',
		'destination',
		'event',
		'issue',
		'request',
		'source',
	]);

	// Every resource must expose an Operation parameter, or it is unreachable.
	for (const resource of resources) {
		const operations = properties.find(
			(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(resource),
		);
		assert.ok(operations, `no operations declared for ${resource}`);
		assert.ok(operations.options.length > 0, `no operations listed for ${resource}`);
	}
});
