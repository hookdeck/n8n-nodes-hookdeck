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
	buildDestination,
	buildRules,
	buildSourceConfig,
	optionsUnsupportedOverCli,
} from '../dist/nodes/Hookdeck/ConnectionPayload.js';
import {
	hookdeckApiRequest,
	hookdeckApiRequestAllItems,
} from '../dist/nodes/Hookdeck/GenericFunctions.js';
import {
	buildDeviceName,
	buildResourceName,
	describeUnreachableWebhookUrl,
	isTestWebhookUrl,
	localPortFor,
	sanitizeName,
	webhookPathFor,
} from '../dist/nodes/Hookdeck/Naming.js';
import { HookdeckEventGateway } from '../dist/nodes/Hookdeck/HookdeckEventGateway.node.js';
import { HookdeckEventGatewayTrigger } from '../dist/nodes/Hookdeck/HookdeckEventGatewayTrigger.node.js';
import { registrationFor } from '../dist/nodes/Hookdeck/Registration.js';
import { SOURCE_TYPE_AUTH, SOURCE_TYPE_OPTIONS } from '../dist/nodes/Hookdeck/SourceTypes.js';

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

test('platform auth shapes come from the spec, not assumption', () => {
	// A secret placed in the wrong field is rejected by the API at activation.
	assert.deepEqual(SOURCE_TYPE_AUTH.STRIPE, { kind: 'fields', fields: ['webhook_secret_key'] });
	assert.deepEqual(SOURCE_TYPE_AUTH.GITLAB, { kind: 'fields', fields: ['api_key'] });
	assert.deepEqual(SOURCE_TYPE_AUTH.POSTMARK, { kind: 'fields', fields: ['password', 'username'] });

	// The three non-field cases must stay distinguishable: they need different
	// answers, and an array alone cannot tell "no secret" from "several schemes".
	assert.equal(SOURCE_TYPE_AUTH.HTTP.kind, 'choice');
	assert.equal(SOURCE_TYPE_AUTH.AWS_SNS.kind, 'none');
	assert.equal(SOURCE_TYPE_AUTH.MONDAY.kind, 'none');

	for (const [type, shape] of Object.entries(SOURCE_TYPE_AUTH)) {
		assert.ok(['fields', 'choice', 'none'].includes(shape.kind), `${type} has an unknown kind`);
		if (shape.kind === 'fields') {
			assert.ok(shape.fields.length > 0, `${type} claims fields but names none`);
		}
	}
});

test('every mapped source type is one the UI actually offers', () => {
	// Both are generated from the same schema; a mapped type the UI never offers
	// is dead weight, and the reverse would mean offering something unprovisionable.
	const offered = new Set(SOURCE_TYPE_OPTIONS.map((o) => o.value));
	for (const type of Object.keys(SOURCE_TYPE_AUTH)) {
		assert.ok(offered.has(type), `${type} is mapped but not offered in the UI`);
	}
});

test('searchSources does not cap results when a search term is given', async () => {
	// A cap while searching hides sources the user explicitly asked for.
	const { searchSources } = new HookdeckEventGatewayTrigger().methods.listSearch;
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
	['HookdeckEventGateway', HookdeckEventGateway],
	['HookdeckEventGatewayTrigger', HookdeckEventGatewayTrigger],
]) {
	test(`${label} description is structurally valid`, () => {
		const { description } = new NodeClass();

		assert.ok(description.displayName);
		assert.ok(description.name);
		assert.ok(description.icon);
		assert.equal(description.credentials[0].name, 'hookdeckEventGatewayApi');
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
	const source = new HookdeckEventGatewayTrigger().description.properties.find((p) => p.name === 'source');

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
	const { searchSources } = new HookdeckEventGatewayTrigger().methods.listSearch;
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
	const node = new HookdeckEventGatewayTrigger();
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
	assert.deepEqual(new HookdeckEventGatewayTrigger().description.inputs, []);
});

/**
 * Minimal stand-in for n8n's IHookFunctions, enough to drive the webhook
 * lifecycle. `calls` records every Hookdeck request so a test can assert which
 * connection a pause or delete actually targeted.
 */
function fakeHookContext({ webhookUrl, staticData, params = {}, mode = 'trigger' }) {
	const calls = [];
	return {
		calls,
		staticData,
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => webhookUrl,
		getMode: () => mode,
		getWorkflow: () => ({ id: 'wf1' }),
		getNode: () => ({ id: 'node1', name: 'Hookdeck Trigger', type: 'hookdeckEventGatewayTrigger' }),
		getNodeParameter: (name, fallback) => (name in params ? params[name] : fallback),
		getInstanceId: () => 'inst12345678abcdef',
		logger: { debug() {}, warn() {}, error() {}, info() {} },
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
//
// `existingSources` is what the project already has: provisioning looks a source
// up by name before deciding whether to describe one or bind to it.
async function provision(ctx, connectionId, existingSources = []) {
	const { create } = new HookdeckEventGatewayTrigger().webhookMethods.default;
	ctx.helpers.httpRequestWithAuthentication = (_cred, options) => {
		ctx.calls.push({ method: options.method, url: options.url, body: options.body, qs: options.qs });
		if (options.method === 'GET' && options.url.endsWith('/sources')) {
			const name = options.qs?.name;
			return Promise.resolve({
				statusCode: 200,
				body: { models: existingSources.filter((s) => s.name === name) },
			});
		}
		return Promise.resolve({
			statusCode: 200,
			body: { id: connectionId, source: { id: 'src_1', url: 'https://hkdk.events/src_1' } },
		});
	};
	await create.call(ctx);
}

const upsertOf = (ctx) =>
	ctx.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/connections'));

test('an existing source is adopted by ID, never rewritten', async () => {
	// The upsert is keyed on source name, so an inline `source` block would apply
	// this node's Source Type and Verification to a source that is already there —
	// and to every other connection fed by it. Since Source Type defaults to
	// WEBHOOK and Verification to none, picking a verified Stripe source from the
	// list would otherwise strip its verification on publish.
	const staticData = {};
	const warnings = [];
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: { source: 'stripe-production', sourceType: 'WEBHOOK', verification: 'none' },
	});
	ctx.logger.warn = (message) => warnings.push(message);

	await provision(ctx, 'web_PROD', [
		{ id: 'src_existing', name: 'stripe-production', type: 'STRIPE' },
	]);

	const upsert = upsertOf(ctx);
	assert.equal(upsert.body.source_id, 'src_existing');
	// `source_id` cannot carry a type or a config, so there is nothing to overwrite.
	assert.equal(upsert.body.source, undefined);

	// Silently ignoring the node's own settings would be its own trap, so say so.
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /rather than WEBHOOK/);
	assert.match(warnings[0], /Update Existing Source/);
});

test('a source that does not exist yet is created from the node settings', async () => {
	const staticData = {};
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: { source: 'brand-new', sourceType: 'WEBHOOK', verification: 'none' },
	});

	await provision(ctx, 'web_PROD', []);

	const upsert = upsertOf(ctx);
	assert.equal(upsert.body.source_id, undefined);
	assert.equal(upsert.body.source.name, 'brand-new');
	assert.equal(upsert.body.source.type, 'WEBHOOK');

	// The lookup must be an exact-name query, not a scan of every source.
	const lookup = ctx.calls.find((c) => c.method === 'GET' && c.url.endsWith('/sources'));
	assert.equal(lookup.qs.name, 'brand-new');
});

test('Update Existing Source opts back in to rewriting the source', async () => {
	// The escape hatch matters: without it there is no way to change verification
	// on a source this node created, short of editing it in the dashboard.
	const staticData = {};
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: {
			source: 'stripe-production',
			sourceType: 'STRIPE',
			platformSecret: 'whsec_123',
			options: { updateExistingSource: true },
		},
	});

	await provision(ctx, 'web_PROD', [
		{ id: 'src_existing', name: 'stripe-production', type: 'STRIPE' },
	]);

	const upsert = upsertOf(ctx);
	assert.equal(upsert.body.source_id, undefined);
	assert.equal(upsert.body.source.type, 'STRIPE');
	assert.equal(upsert.body.source.config.auth.webhook_secret_key, 'whsec_123');
});

test('adopting a source that needs nothing said says nothing', async () => {
	// The warning exists to flag settings that did not apply. When the node agrees
	// with the source and configures nothing, nothing was ignored and a warning
	// would be noise.
	const staticData = {};
	const warnings = [];
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: { source: 'generic', sourceType: 'WEBHOOK', verification: 'none' },
	});
	ctx.logger.warn = (message) => warnings.push(message);

	await provision(ctx, 'web_PROD', [{ id: 'src_existing', name: 'generic', type: 'WEBHOOK' }]);

	assert.equal(upsertOf(ctx).body.source_id, 'src_existing');
	assert.deepEqual(warnings, []);
});

test('verification entered against a same-type source is reported as ignored', async () => {
	// The easiest case to miss: nothing about it looks unusual, the types agree,
	// and the secret simply never reaches Hookdeck. Warning only on a type
	// mismatch would leave this silent.
	const staticData = {};
	const warnings = [];
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: {
			source: 'generic',
			sourceType: 'WEBHOOK',
			verification: 'HMAC',
			hmacSecret: 'shhh',
			hmacHeaderKey: 'x-signature',
			hmacAlgorithm: 'sha256',
			hmacEncoding: 'base64',
		},
	});
	ctx.logger.warn = (message) => warnings.push(message);

	await provision(ctx, 'web_PROD', [{ id: 'src_existing', name: 'generic', type: 'WEBHOOK' }]);

	assert.equal(upsertOf(ctx).body.source_id, 'src_existing');
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /verification stays as configured in Hookdeck/);
});

test('a platform secret entered against a same-type source is reported too', async () => {
	const staticData = {};
	const warnings = [];
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: { source: 'stripe-prod', sourceType: 'STRIPE', platformSecret: 'whsec_123' },
	});
	ctx.logger.warn = (message) => warnings.push(message);

	await provision(ctx, 'web_PROD', [{ id: 'src_existing', name: 'stripe-prod', type: 'STRIPE' }]);

	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /verification stays as configured in Hookdeck/);
	// The types agree, so that must not be given as a reason.
	assert.doesNotMatch(warnings[0], /rather than/);
});

test('Source Config JSON that cannot apply is reported as ignored', async () => {
	const staticData = {};
	const warnings = [];
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc',
		staticData,
		params: {
			source: 'generic',
			sourceType: 'WEBHOOK',
			verification: 'none',
			options: { sourceConfigJson: '{"auth_type":"HMAC"}' },
		},
	});
	ctx.logger.warn = (message) => warnings.push(message);

	await provision(ctx, 'web_PROD', [{ id: 'src_existing', name: 'generic', type: 'WEBHOOK' }]);

	assert.match(warnings[0], /Source Config \(JSON\) was not applied/);
});

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

test('an unreachable n8n gets a CLI destination rather than a failed activation', async () => {
	// Previously this threw. Hookdeck cannot reach localhost, but `hookdeck listen`
	// can carry events to it, so the connection is provisioned against a CLI
	// destination instead of refusing to activate at all.
	const staticData = {};
	const ctx = fakeHookContext({
		webhookUrl: 'http://localhost:5678/webhook/abc/webhook',
		staticData,
		params: { source: 'local-src', sourceType: 'WEBHOOK', verification: 'none' },
	});

	await provision(ctx, 'web_PROD', []);

	const destination = upsertOf(ctx).body.destination;
	assert.equal(destination.type, 'CLI');
	assert.equal(destination.config.path, '/webhook/abc/webhook');
	assert.equal(destination.config.url, undefined);
	// Same signing secret handling as the HTTP route, so webhook() is unchanged.
	assert.equal(destination.config.auth_type, 'CUSTOM_SIGNATURE');
	assert.equal(staticData.production.signingSecret.length, 64);
});

test('a reachable n8n still gets an HTTP destination', async () => {
	const staticData = {};
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/webhook/abc/webhook',
		staticData,
		params: { source: 'public-src', sourceType: 'WEBHOOK', verification: 'none' },
	});

	await provision(ctx, 'web_PROD', []);

	const destination = upsertOf(ctx).body.destination;
	assert.equal(destination.type, 'HTTP');
	assert.equal(destination.config.url, 'https://n8n.example.com/webhook/abc/webhook');
	assert.equal(destination.config.path, undefined);
});

test('the CLI route logs the exact commands to run', async () => {
	// The node cannot start the CLI, so the command is the whole deliverable.
	// A wrong port or a missing project would look like the node is broken.
	const logs = [];
	const ctx = fakeHookContext({
		webhookUrl: 'http://localhost:5678/webhook/abc/webhook',
		staticData: {},
		params: { source: 'local-src', sourceType: 'WEBHOOK', verification: 'none' },
	});
	ctx.logger.info = (message) => logs.push(message);

	await provision(ctx, 'web_PROD', []);

	const setup = logs.join('\n');
	assert.match(setup, /hookdeck ci --api-key/);
	// The connection is deliberately not named: naming it would cover only the
	// live connection, and "Listen for test event" uses a second one.
	assert.match(setup, /hookdeck listen 5678 local-src --device-name n8n-localhost-inst1234/);
	assert.doesNotMatch(setup, /hookdeck listen 5678 local-src n8n-/);
	// Say what actually happens when nothing is listening: no event is recorded
	// against the connection at all, so there is nothing to retry later.
	assert.match(setup, /not recorded against that connection/);
});

test('rate limiting set against a CLI route is reported as not applied', async () => {
	const logs = [];
	const ctx = fakeHookContext({
		webhookUrl: 'http://localhost:5678/webhook/abc/webhook',
		staticData: {},
		params: {
			source: 'local-src',
			sourceType: 'WEBHOOK',
			verification: 'none',
			options: { rateLimit: 10, deliveryGroupKey: 'body.id' },
		},
	});
	ctx.logger.info = (message) => logs.push(message);

	await provision(ctx, 'web_PROD', []);

	const reported = logs.find((l) => l.includes('Delivery Rate Limit'));
	assert.ok(reported, 'expected the unsupported options to be named');
	assert.match(reported, /Delivery Rate Limit and Delivery Group Key are not applied/);
});

test('CLI setup helpers read the port, path and a distinct device name', () => {
	assert.equal(localPortFor('http://localhost:5678/webhook/abc'), '5678');
	// No explicit port means a proxy on 80/443, so fall back to what n8n serves.
	assert.equal(localPortFor('https://n8n.example.com/webhook/abc'), '5678');
	assert.equal(webhookPathFor('http://localhost:5678/webhook/abc/webhook'), '/webhook/abc/webhook');

	// Two instances on the same host must not look like one listener restarting,
	// or Hookdeck's session dedup would let them take each other's place.
	const a = buildDeviceName('http://localhost:5678/webhook/x', 'aaaaaaaabbbb');
	const b = buildDeviceName('http://localhost:5678/webhook/x', 'ccccccccdddd');
	assert.notEqual(a, b);
	assert.match(a, /^n8n-localhost-aaaaaaaa$/);
	assert.match(buildDeviceName('https://n8n.example.com/webhook/x', 'zzzzzzzz'), /^n8n-n8n-example-com-zzzzzzzz$/);
});

test('registrationFor identifies a slot by the URL it was provisioned with', () => {
	// The recorded destination is the only signal that survives an instance
	// renaming its test endpoint, and it is the one teardown must rely on.
	const staticData = {
		production: { connectionId: 'web_PROD', destinationUrl: 'https://n8n.example.com/hooks/abc' },
		test: { connectionId: 'web_TEST', destinationUrl: 'https://n8n.example.com/try/abc' },
	};

	// Mode says 'internal' — what n8n reports when closing a test listen — and the
	// path is unrecognisable, yet the test slot is still identified correctly.
	const closing = registrationFor(staticData, 'https://n8n.example.com/try/abc', 'internal');
	assert.equal(closing.isTest, true);
	assert.equal(closing.registration.connectionId, 'web_TEST');

	const production = registrationFor(staticData, 'https://n8n.example.com/hooks/abc', 'internal');
	assert.equal(production.isTest, false);
	assert.equal(production.registration.connectionId, 'web_PROD');
});

test('registrationFor falls back to mode, then to the webhook path', () => {
	// Nothing recorded yet: a first-time test listen is known only by its mode.
	assert.equal(registrationFor({}, 'https://n8n.example.com/try/abc', 'manual').isTest, true);

	// Mode is unhelpful on teardown, so the path carries it on a stock instance.
	assert.equal(
		registrationFor({}, 'https://n8n.example.com/webhook-test/abc', 'internal').isTest,
		true,
	);
	assert.equal(
		registrationFor({}, 'https://n8n.example.com/webhook/abc', 'internal').isTest,
		false,
	);
});

test('closing a test listen never touches the production connection', async () => {
	// The failure this prevents: on an instance with a renamed test endpoint,
	// teardown classified as production pauses the live connection while the
	// workflow is still running, and abandons the dead test connection.
	const staticData = {
		production: {
			connectionId: 'web_PROD',
			signingSecret: 'p',
			destinationUrl: 'https://n8n.example.com/hooks/abc',
		},
		test: {
			connectionId: 'web_TEST',
			signingSecret: 't',
			destinationUrl: 'https://n8n.example.com/try/abc',
		},
	};
	const ctx = fakeHookContext({
		webhookUrl: 'https://n8n.example.com/try/abc',
		staticData,
		params: { options: {} },
		mode: 'internal',
	});

	await new HookdeckEventGatewayTrigger().webhookMethods.default.delete.call(ctx);

	assert.ok(ctx.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/connections/web_TEST')));
	assert.ok(!ctx.calls.some((c) => c.url.includes('web_PROD')), 'production must not be touched');
	assert.equal(staticData.production.connectionId, 'web_PROD');
});

test('platform auth covers inline, choice-of-scheme and no-secret types', () => {
	// MANAGED declares its auth inline rather than by $ref.
	assert.deepEqual(SOURCE_TYPE_AUTH.MANAGED, { kind: 'fields', fields: ['token'] });
	const managed = buildSourceConfig.call(
		fakeSourceConfigContext({ platformSecret: 'tok' }),
		'MANAGED',
		{},
	);
	assert.deepEqual(managed.auth, { token: 'tok' });

	// A choice of schemes cannot be picked from one secret.
	assert.throws(
		() => buildSourceConfig.call(fakeSourceConfigContext({ platformSecret: 'x' }), 'HTTP', {}),
		/choice of verification schemes/,
	);

	// Types taking no secret need their own answer: telling someone to use
	// Source Config (JSON) here would send them after a secret that does not exist.
	assert.throws(
		() => buildSourceConfig.call(fakeSourceConfigContext({ platformSecret: 'x' }), 'AWS_SNS', {}),
		(error) => {
			assert.match(error.message, /does not take a verification secret/);
			assert.match(error.description ?? '', /Leave Webhook Secret empty/);
			return true;
		},
	);

	// And leaving it empty provisions cleanly.
	const none = buildSourceConfig.call(fakeSourceConfigContext({ platformSecret: '' }), 'AWS_SNS', {});
	assert.deepEqual(none, {});
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
		// n8n tears a test listen down with mode 'internal', not 'manual'.
		mode: 'internal',
	});

	await new HookdeckEventGatewayTrigger().webhookMethods.default.delete.call(ctx);

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

	await new HookdeckEventGatewayTrigger().webhookMethods.default.delete.call(ctx);

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

	await new HookdeckEventGatewayTrigger().webhookMethods.default.delete.call(ctx);

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

	const { properties } = new HookdeckEventGateway().description;

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
	const { properties } = new HookdeckEventGateway().description;
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

// ─── HTTP transport ───────────────────────────────────────────────────────────

/** Stand-in for an n8n execution context, recording every request made. */
function fakeApiContext(responses) {
	const calls = [];
	const queue = Array.isArray(responses) ? [...responses] : [responses];
	return {
		calls,
		getNode: () => ({ name: 'Hookdeck' }),
		logger: { debug() {}, warn() {}, error() {} },
		helpers: {
			httpRequestWithAuthentication(_cred, options) {
				calls.push(options);
				const next = queue.shift();
				if (next instanceof Error) return Promise.reject(next);
				return Promise.resolve(next);
			},
		},
	};
}

test('hookdeckApiRequest returns the response body on success', async () => {
	const ctx = fakeApiContext({ statusCode: 200, body: { id: 'src_1' } });
	const result = await hookdeckApiRequest.call(ctx, 'GET', '/sources');

	assert.deepEqual(result, { id: 'src_1' });
	assert.equal(ctx.calls[0].url, 'https://api.hookdeck.com/2025-07-01/sources');
	// Status handling is ours, so the helper must not throw on non-2xx itself.
	assert.equal(ctx.calls[0].ignoreHttpStatusErrors, true);
	assert.equal(ctx.calls[0].returnFullResponse, true);
});

test('hookdeckApiRequest normalises an empty body to an object', async () => {
	// A 204 yields '' rather than an object; callers index the result regardless.
	const ctx = fakeApiContext({ statusCode: 204, body: '' });
	assert.deepEqual(await hookdeckApiRequest.call(ctx, 'DELETE', '/connections/web_1'), {});
});

test('hookdeckApiRequest omits empty body and query', async () => {
	const ctx = fakeApiContext({ statusCode: 200, body: {} });
	await hookdeckApiRequest.call(ctx, 'GET', '/sources');
	assert.equal('body' in ctx.calls[0], false);
	assert.equal('qs' in ctx.calls[0], false);
});

test('hookdeckApiRequest puts the API reason in the error message', async () => {
	// n8n's activation path surfaces only error.message, so the detail has to be
	// there rather than in the description alone.
	const ctx = fakeApiContext({
		statusCode: 422,
		body: { message: 'Unprocessable', data: ['destination.config.url must be a valid uri'] },
	});

	await assert.rejects(
		() => hookdeckApiRequest.call(ctx, 'PUT', '/connections'),
		(error) => {
			assert.match(error.message, /HTTP 422/);
			assert.match(error.message, /PUT \/connections/);
			assert.match(error.message, /Unprocessable/);
			assert.equal(error.httpCode, '422');
			return true;
		},
	);
});

test('hookdeckApiRequest reports per-field validation errors', async () => {
	const ctx = fakeApiContext({
		statusCode: 400,
		body: { message: 'Invalid', errors: { name: 'must match pattern' } },
	});
	await assert.rejects(
		() => hookdeckApiRequest.call(ctx, 'POST', '/sources'),
		(error) => {
			assert.match(error.message, /name: must match pattern/);
			return true;
		},
	);
});

test('hookdeckApiRequest surfaces a transport failure', async () => {
	const ctx = fakeApiContext(new Error('getaddrinfo ENOTFOUND api.hookdeck.com'));
	await assert.rejects(
		() => hookdeckApiRequest.call(ctx, 'GET', '/sources'),
		(error) => {
			// For transport-level failures NodeApiError substitutes its own wording
			// and discards the message built here, so only the description carries
			// the underlying cause. Asserted so a future change to that mapping is
			// visible rather than silently swallowing the reason.
			assert.match(error.message, /connection cannot be established/i);
			assert.match(error.description ?? '', /ENOTFOUND/);
			return true;
		},
	);
});

test('hookdeckApiRequestAllItems follows the pagination cursor', async () => {
	const ctx = fakeApiContext([
		{ statusCode: 200, body: { models: [{ id: 1 }, { id: 2 }], pagination: { next: 'cur_2' } } },
		{ statusCode: 200, body: { models: [{ id: 3 }], pagination: {} } },
	]);

	const all = await hookdeckApiRequestAllItems.call(ctx, '/events');

	assert.deepEqual(all.map((m) => m.id), [1, 2, 3]);
	assert.equal(ctx.calls.length, 2);
	assert.equal(ctx.calls[0].qs.next, undefined);
	assert.equal(ctx.calls[1].qs.next, 'cur_2');
});

test('hookdeckApiRequestAllItems asks only for what the caller can use', async () => {
	// "Get URL" wants one source; fetching a full page to discard the rest is waste.
	const ctx = fakeApiContext({ statusCode: 200, body: { models: [{ id: 1 }], pagination: {} } });
	await hookdeckApiRequestAllItems.call(ctx, '/sources', {}, 1);
	assert.equal(ctx.calls[0].qs.limit, 1);

	const unbounded = fakeApiContext({ statusCode: 200, body: { models: [], pagination: {} } });
	await hookdeckApiRequestAllItems.call(unbounded, '/sources');
	assert.equal(unbounded.calls[0].qs.limit, 250);
});

test('hookdeckApiRequestAllItems stops at the limit and does not over-return', async () => {
	const ctx = fakeApiContext([
		{ statusCode: 200, body: { models: [{ id: 1 }, { id: 2 }, { id: 3 }], pagination: { next: 'c' } } },
	]);
	const all = await hookdeckApiRequestAllItems.call(ctx, '/events', {}, 2);
	assert.equal(all.length, 2);
	// The cursor is not followed once the limit is met.
	assert.equal(ctx.calls.length, 1);
});

// ─── Connection payload ───────────────────────────────────────────────────────

function fakeSourceConfigContext(params) {
	return {
		getNode: () => ({ name: 'Hookdeck Trigger' }),
		getNodeParameter: (name, fallback) => (name in params ? params[name] : fallback),
	};
}

test('buildSourceConfig emits the HMAC verification shape', () => {
	const config = buildSourceConfig.call(
		fakeSourceConfigContext({
			verification: 'HMAC',
			hmacSecret: 'shh',
			hmacHeaderKey: 'x-signature',
			hmacAlgorithm: 'sha256',
			hmacEncoding: 'hex',
		}),
		'WEBHOOK',
		{},
	);

	assert.equal(config.auth_type, 'HMAC');
	// auth_type without a companion auth object is rejected by the API.
	assert.deepEqual(config.auth, {
		webhook_secret_key: 'shh',
		header_key: 'x-signature',
		algorithm: 'sha256',
		encoding: 'hex',
	});
});

test('buildSourceConfig emits API key and basic auth shapes', () => {
	const apiKey = buildSourceConfig.call(
		fakeSourceConfigContext({ verification: 'API_KEY', authHeaderName: 'x-api-key', apiKeyValue: 'k' }),
		'WEBHOOK',
		{},
	);
	assert.equal(apiKey.auth_type, 'API_KEY');
	assert.deepEqual(apiKey.auth, { header_key: 'x-api-key', api_key: 'k' });

	const basic = buildSourceConfig.call(
		fakeSourceConfigContext({ verification: 'BASIC_AUTH', basicAuthUsername: 'u', basicAuthPassword: 'p' }),
		'WEBHOOK',
		{},
	);
	assert.equal(basic.auth_type, 'BASIC_AUTH');
	assert.deepEqual(basic.auth, { username: 'u', password: 'p' });
});

test('buildSourceConfig sends no auth when verification is off', () => {
	const config = buildSourceConfig.call(
		fakeSourceConfigContext({ verification: 'none' }),
		'WEBHOOK',
		{},
	);
	assert.deepEqual(config, {});
});

test('buildSourceConfig puts a platform secret in that platform field', () => {
	const stripe = buildSourceConfig.call(
		fakeSourceConfigContext({ platformSecret: 'whsec_123' }),
		'STRIPE',
		{},
	);
	assert.deepEqual(stripe, { auth_type: 'STRIPE', auth: { webhook_secret_key: 'whsec_123' } });

	// GitLab names it api_key; the same secret in webhook_secret_key is rejected.
	const gitlab = buildSourceConfig.call(
		fakeSourceConfigContext({ platformSecret: 'tok' }),
		'GITLAB',
		{},
	);
	assert.deepEqual(gitlab, { auth_type: 'GITLAB', auth: { api_key: 'tok' } });
});

test('buildSourceConfig refuses platforms needing more than one value', () => {
	assert.throws(
		() =>
			buildSourceConfig.call(fakeSourceConfigContext({ platformSecret: 'x' }), 'POSTMARK', {}),
		(error) => {
			assert.match(error.message, /more than one value/);
			// The message has to name the fields, or it is not actionable.
			assert.match(error.description ?? '', /username/);
			assert.match(error.description ?? '', /password/);
			return true;
		},
	);
});

test('buildSourceConfig lets Source Config JSON override the fields above', () => {
	const config = buildSourceConfig.call(
		fakeSourceConfigContext({ platformSecret: 'ignored' }),
		'STRIPE',
		{ sourceConfigJson: '{"auth_type":"STRIPE","auth":{"webhook_secret_key":"override"}}' },
	);
	assert.deepEqual(config.auth, { webhook_secret_key: 'override' });
});

test('buildSourceConfig rejects malformed Source Config JSON', () => {
	assert.throws(
		() =>
			buildSourceConfig.call(fakeSourceConfigContext({ verification: 'none' }), 'WEBHOOK', {
				sourceConfigJson: '{not json',
			}),
		/not valid JSON/,
	);
});

test('buildRules applies retry and dedup defaults without any options set', () => {
	const rules = buildRules({});
	const retry = rules.find((r) => r.type === 'retry');
	assert.equal(retry.count, 5);
	assert.equal(retry.strategy, 'exponential');
	// Server errors and rate limiting must stay retryable.
	assert.deepEqual(retry.response_status_codes, ['500-599', '429']);
	assert.ok(rules.some((r) => r.type === 'deduplicate'));
});

test('buildRules honours explicit options, including turning rules off', () => {
	const rules = buildRules({ retryCount: 0, deduplicateWindow: 0 });
	assert.equal(rules.length, 0);

	const custom = buildRules({ retryCount: 12, retryStrategy: 'linear', retryInterval: 5000 });
	const retry = custom.find((r) => r.type === 'retry');
	assert.equal(retry.count, 12);
	assert.equal(retry.strategy, 'linear');
	assert.equal(retry.interval, 5000);
});

test('an HTTP destination disables path forwarding and signs deliveries', () => {
	const { type, config } = buildDestination('https://n8n.example.com/webhook/abc', 'sekret', {}, false);
	assert.equal(type, 'HTTP');
	assert.equal(config.url, 'https://n8n.example.com/webhook/abc');
	assert.equal(config.path_forwarding_disabled, true);
	assert.equal(config.auth_type, 'CUSTOM_SIGNATURE');
	assert.deepEqual(config.auth, { key: SIGNATURE_HEADER, signing_secret: 'sekret' });
});

test('an HTTP destination maps rate limiting and delivery groups', () => {
	const { config } = buildDestination('https://n8n.example.com/webhook/abc', 's', {
		rateLimit: 10,
		rateLimitPeriod: 'concurrent',
		deliveryGroupKey: 'body.customer_id',
	}, false);
	assert.equal(config.rate_limit, 10);
	assert.equal(config.rate_limit_period, 'concurrent');
	// delivery_groups is a single object, not an array, and cannot use 'concurrent'.
	assert.equal(Array.isArray(config.delivery_groups), false);
	assert.equal(config.delivery_groups.key, 'body.customer_id');
	assert.notEqual(config.delivery_groups.rate_limit_period, 'concurrent');
});

test('a CLI destination carries only the path, and the same signature', () => {
	// The signature is the point: a CLI destination accepts CUSTOM_SIGNATURE
	// exactly as an HTTP one does, so nothing in webhook() has to know which
	// route an event arrived by.
	const { type, config } = buildDestination(
		'http://localhost:5678/webhook/abc/webhook',
		'sekret',
		{},
		true,
	);
	assert.equal(type, 'CLI');
	assert.equal(config.path, '/webhook/abc/webhook');
	assert.equal(config.url, undefined);
	assert.equal(config.auth_type, 'CUSTOM_SIGNATURE');
	assert.deepEqual(config.auth, { key: SIGNATURE_HEADER, signing_secret: 'sekret' });
});

test('a CLI destination never carries rate limiting Hookdeck would reject', () => {
	// CLI destinations have CUSTOM_CLI_PATH and nothing else — no
	// MAX_DELIVERY_RATE, no delivery_groups.
	const { config } = buildDestination('http://localhost:5678/webhook/abc', 's', {
		rateLimit: 10,
		rateLimitPeriod: 'concurrent',
		deliveryGroupKey: 'body.customer_id',
		deliveryGroupRateLimit: 2,
	}, true);
	assert.equal(config.rate_limit, undefined);
	assert.equal(config.rate_limit_period, undefined);
	assert.equal(config.delivery_groups, undefined);
});

test('options that cannot apply over the CLI are named, not silently dropped', () => {
	assert.deepEqual(optionsUnsupportedOverCli({}), []);
	assert.deepEqual(optionsUnsupportedOverCli({ rateLimit: 5 }), ['Delivery Rate Limit']);
	assert.deepEqual(
		optionsUnsupportedOverCli({ rateLimit: 5, deliveryGroupKey: 'body.id' }),
		['Delivery Rate Limit', 'Delivery Group Key'],
	);
	// Options an HTTP destination also ignores are not this function's business.
	assert.deepEqual(optionsUnsupportedOverCli({ retryCount: 3, headerPrefix: 'x-hd' }), []);
});

// ─── Action node routing ──────────────────────────────────────────────────────

/** Drive the action node's execute() and record the HTTP calls it makes. */
async function runAction(params, responseBody = { ok: true }) {
	const calls = [];
	const ctx = {
		getInputData: () => [{ json: {} }],
		continueOnFail: () => false,
		getNode: () => ({ name: 'Hookdeck' }),
		logger: { debug() {}, warn() {}, error() {} },
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		helpers: {
			httpRequestWithAuthentication(_cred, options) {
				calls.push({ method: options.method, url: options.url, body: options.body });
				return Promise.resolve({ statusCode: 200, body: responseBody });
			},
		},
	};
	const output = await new HookdeckEventGateway().execute.call(ctx);
	return { calls, output };
}

test('action node routes each operation to the right method and path', async () => {
	const get = await runAction({ resource: 'event', operation: 'get', id: 'evt_1' });
	assert.equal(get.calls[0].method, 'GET');
	assert.match(get.calls[0].url, /\/events\/evt_1$/);

	// Events retry via POST; connection state changes are PUT.
	const retry = await runAction({ resource: 'event', operation: 'retry', id: 'evt_1' });
	assert.equal(retry.calls[0].method, 'POST');
	assert.match(retry.calls[0].url, /\/events\/evt_1\/retry$/);

	const pause = await runAction({ resource: 'connection', operation: 'pause', id: 'web_1' });
	assert.equal(pause.calls[0].method, 'PUT');
	assert.match(pause.calls[0].url, /\/connections\/web_1\/pause$/);

	const del = await runAction({ resource: 'connection', operation: 'delete', id: 'web_1' });
	assert.equal(del.calls[0].method, 'DELETE');
	assert.match(del.calls[0].url, /\/connections\/web_1$/);
});

test('action node sends issue status changes as a PUT body', async () => {
	const update = await runAction({
		resource: 'issue',
		operation: 'update',
		id: 'iss_1',
		status: 'ACKNOWLEDGED',
	});
	assert.equal(update.calls[0].method, 'PUT');
	assert.deepEqual(update.calls[0].body, { status: 'ACKNOWLEDGED' });

	// Hookdeck models "dismissed" as the IGNORED status.
	const dismiss = await runAction({ resource: 'issue', operation: 'dismiss', id: 'iss_1' });
	assert.deepEqual(dismiss.calls[0].body, { status: 'IGNORED' });
});

test('action node returns list items rather than the envelope', async () => {
	const { output } = await runAction(
		{ resource: 'event', operation: 'getAll', returnAll: true, filters: {} },
		{ models: [{ id: 'evt_1' }, { id: 'evt_2' }], pagination: {} },
	);
	assert.deepEqual(output[0].map((item) => item.json.id), ['evt_1', 'evt_2']);
	// Lineage back to the input item must survive.
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
});

test('action node explains a Get URL miss instead of returning nothing', async () => {
	await assert.rejects(
		() =>
			runAction({ resource: 'source', operation: 'getUrl', name: 'My Source' }, {
				models: [],
				pagination: {},
			}),
		(error) => {
			assert.match(error.message, /No Hookdeck source named "My Source"/);
			// The name is normalised before lookup, so say what was actually searched.
			assert.match(error.message, /My-Source/);
			return true;
		},
	);
});

test('action node returns the source URL for Get URL', async () => {
	const { output } = await runAction(
		{ resource: 'source', operation: 'getUrl', name: 'n8n-verify' },
		{ models: [{ id: 'src_1', name: 'n8n-verify', url: 'https://hkdk.events/abc' }], pagination: {} },
	);
	assert.equal(output[0][0].json.url, 'https://hkdk.events/abc');
});

test('action node rejects an unknown resource', async () => {
	await assert.rejects(
		() => runAction({ resource: 'nonsense', operation: 'get', id: 'x' }),
		/Unknown resource/,
	);
});

// ─── Webhook handler ──────────────────────────────────────────────────────────

/** Drive webhook() and capture whatever response it writes directly. */
function fakeWebhookContext({ body, headers = {}, staticData, options = {} }) {
	const sent = {};
	return {
		sent,
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, fallback) => (name === 'options' ? options : fallback),
		getRequestObject: () => ({ rawBody: body }),
		getHeaderData: () => headers,
		getQueryData: () => ({ foo: 'bar' }),
		getBodyData: () => JSON.parse(body.toString('utf8')),
		getResponseObject: () => ({
			status(code) {
				sent.status = code;
				return { json: (payload) => { sent.body = payload; } };
			},
		}),
		getNode: () => ({ name: 'Hookdeck Trigger' }),
		logger: { debug() {}, warn(message) { sent.warned = message; }, error() {} },
		helpers: { returnJsonArray: (items) => [].concat(items).map((json) => ({ json })) },
	};
}

const WEBHOOK_SECRET = 'sekret';
function sign(body) {
	return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');
}

test('webhook accepts a signed delivery and exposes body, query and metadata', async () => {
	const body = Buffer.from('{"event":"payment.succeeded"}');
	const ctx = fakeWebhookContext({
		body,
		headers: {
			'content-type': 'application/json',
			[SIGNATURE_HEADER]: sign(body),
			'x-hookdeck-eventid': 'evt_1',
			'x-hookdeck-attempt-count': '2',
		},
		staticData: { production: { signingSecret: WEBHOOK_SECRET } },
	});

	const result = await new HookdeckEventGatewayTrigger().webhook.call(ctx);
	const item = result.workflowData[0][0].json;

	assert.equal(item.body.event, 'payment.succeeded');
	assert.deepEqual(item.query, { foo: 'bar' });
	assert.equal(item.hookdeck.eventId, 'evt_1');
	assert.equal(item.hookdeck.attemptCount, 2);
	// No will-retry-after means Hookdeck is done trying: the dead-letter signal.
	assert.equal(item.hookdeck.isLastAttempt, true);
});

test('webhook rejects an unsigned or mis-signed delivery with 401', async () => {
	const body = Buffer.from('{"forged":true}');
	for (const headers of [
		{ 'content-type': 'application/json' },
		{ 'content-type': 'application/json', [SIGNATURE_HEADER]: 'AAAAdeadbeef' },
	]) {
		const ctx = fakeWebhookContext({
			body,
			headers,
			staticData: { production: { signingSecret: WEBHOOK_SECRET } },
		});
		const result = await new HookdeckEventGatewayTrigger().webhook.call(ctx);

		assert.equal(ctx.sent.status, 401);
		// The workflow must not run.
		assert.equal(result.noWebhookResponse, true);
		assert.equal(result.workflowData, undefined);
	}
});

test('webhook accepts either the test or production secret', async () => {
	// A delivery does not say which registration it belongs to, and both are ours.
	const body = Buffer.from('{"a":1}');
	const ctx = fakeWebhookContext({
		body,
		headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(body) },
		staticData: { production: { signingSecret: 'other' }, test: { signingSecret: WEBHOOK_SECRET } },
	});
	const result = await new HookdeckEventGatewayTrigger().webhook.call(ctx);
	assert.ok(result.workflowData);
});

test('webhook says why it is rejecting when no secret is stored', async () => {
	// Static data does not survive an export/import; without this the cause of a
	// permanent 401 is invisible.
	const body = Buffer.from('{"a":1}');
	const ctx = fakeWebhookContext({
		body,
		headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(body) },
		staticData: {},
	});

	await new HookdeckEventGatewayTrigger().webhook.call(ctx);
	assert.equal(ctx.sent.status, 401);
	assert.match(ctx.sent.warned ?? '', /no signing secret is stored/);
});

test('webhook rejects a malformed text body with 400, not 401', async () => {
	// 400 sits outside the retry rule, so a malformed body fails once rather than
	// consuming every attempt.
	const body = Buffer.concat([Buffer.from('{"n":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
	const ctx = fakeWebhookContext({
		body,
		headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(body) },
		staticData: { production: { signingSecret: WEBHOOK_SECRET } },
	});

	const result = await new HookdeckEventGatewayTrigger().webhook.call(ctx);
	assert.equal(ctx.sent.status, 400);
	assert.match(ctx.sent.body.message, /not valid UTF-8/);
	assert.equal(result.noWebhookResponse, true);
});

test('webhook lets a binary body through untouched', async () => {
	// A binary payload is legitimately not UTF-8; rejecting it would make that
	// provider permanently undeliverable.
	const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xc3, 0x28]);
	const ctx = fakeWebhookContext({
		body,
		headers: { 'content-type': 'application/gzip', [SIGNATURE_HEADER]: sign(body) },
		staticData: { production: { signingSecret: WEBHOOK_SECRET } },
	});
	ctx.getBodyData = () => ({ binary: true });

	const result = await new HookdeckEventGatewayTrigger().webhook.call(ctx);
	assert.equal(ctx.sent.status, undefined, 'should not have written a rejection');
	assert.ok(result.workflowData);
});

test('webhook can be run with verification turned off', async () => {
	const body = Buffer.from('{"a":1}');
	const ctx = fakeWebhookContext({
		body,
		headers: { 'content-type': 'application/json' },
		staticData: {},
		options: { verifySignature: false },
	});
	const result = await new HookdeckEventGatewayTrigger().webhook.call(ctx);
	assert.ok(result.workflowData);
	assert.equal(ctx.sent.status, undefined);
});
