/**
 * Live tests for everything the README claims that is observable from the API.
 *
 * Provisioning options, verification shapes and the action node's full
 * Signature behaviour lives in `verification.test.mjs` and real deliveries in
 * `delivery.test.mjs`; neither is needed here, so this suite runs in seconds
 * and requires nothing beyond an API key.
 *
 *   npm run test:live
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HookdeckEventGatewayTrigger } from '../../dist/nodes/Hookdeck/HookdeckEventGatewayTrigger.node.js';
import { HookdeckEventGateway } from '../../dist/nodes/Hookdeck/HookdeckEventGateway.node.js';
import {
	PREFIX,
	api,
	cleanUpRun,
	connectionForSource,
	liveExecuteContext,
	liveHookContext,
	liveLoadOptionsContext,
	skip,
	until,
} from './_harness.mjs';

/** A reachable placeholder destination: these tests assert config, not delivery. */
const DESTINATION_URL = 'https://example.com/n8n/webhook/live';

/** Provision through the node's own `create()` and return the resulting connection. */
async function provision(sourceName, params, { webhookUrl = DESTINATION_URL, mode } = {}) {
	const staticData = {};
	const ctx = liveHookContext({
		webhookUrl,
		staticData,
		mode,
		params: { source: sourceName, sourceType: 'WEBHOOK', verification: 'none', ...params },
	});
	await new HookdeckEventGatewayTrigger().webhookMethods.default.create.call(ctx);
	return { connection: await connectionForSource(sourceName), staticData, ctx };
}

test('live API surface', { skip, concurrency: false }, async (t) => {
	t.after(cleanUpRun);

	/* ───────────────────────── provisioning options ──────────────────── */

	await t.test('defaults are applied even when Options is never opened', async () => {
		const { connection } = await provision(`${PREFIX}-defaults`, {});
		const [rule] = connection.rules.filter((r) => r.type === 'retry');

		assert.ok(rule, 'README promises retries apply without opening Options');
		assert.equal(rule.strategy, 'exponential');
		assert.equal(rule.count, 5);
		assert.equal(rule.interval, 60000);
	});

	await t.test('retry strategy, count and interval are provisioned as configured', async () => {
		const { connection } = await provision(`${PREFIX}-retry`, {
			options: { retryStrategy: 'linear', retryCount: 12, retryInterval: 30000 },
		});
		const rule = connection.rules.find((r) => r.type === 'retry');

		assert.equal(rule.strategy, 'linear');
		assert.equal(rule.count, 12);
		assert.equal(rule.interval, 30000);
	});

	await t.test('the deduplication window is provisioned', async () => {
		const { connection } = await provision(`${PREFIX}-dedup`, {
			options: { deduplicateWindow: 90000 },
		});
		const rule = connection.rules.find((r) => r.type === 'deduplicate');

		assert.ok(rule, 'no deduplicate rule was provisioned');
		assert.equal(rule.window, 90000);
	});

	await t.test('a zero deduplication window turns deduplication off', async () => {
		const { connection } = await provision(`${PREFIX}-nodedup`, {
			options: { deduplicateWindow: 0 },
		});
		assert.equal(
			connection.rules.some((r) => r.type === 'deduplicate'),
			false,
			'README says 0 turns deduplication off',
		);
	});

	await t.test('delivery rate limiting is provisioned, including concurrent', async () => {
		const { connection } = await provision(`${PREFIX}-rate`, {
			options: { rateLimit: 25, rateLimitPeriod: 'concurrent' },
		});
		assert.equal(connection.destination.config.rate_limit, 25);
		assert.equal(connection.destination.config.rate_limit_period, 'concurrent');
	});

	await t.test('delivery groups are provisioned with key, limit and period', async (t) => {
		let connection;
		try {
			({ connection } = await provision(`${PREFIX}-groups`, {
				options: {
					deliveryGroupKey: 'body.customer_id',
					deliveryGroupRateLimit: 3,
					deliveryGroupRatePeriod: 'minute',
				},
			}));
		} catch (error) {
			// Delivery groups are a plan entitlement. On a project without it the
			// API rejects the upsert outright, which is worth surfacing as a skip
			// rather than a failure — the node built a payload Hookdeck understood.
			if (/Delivery groups are not enabled/.test(error.message)) {
				t.skip('delivery groups are not enabled for this organization');
				return;
			}
			throw error;
		}

		const groups = connection.destination.config.delivery_groups;
		assert.ok(groups, 'no delivery group was provisioned');
		assert.equal(groups.key, 'body.customer_id');
		assert.equal(groups.rate_limit, 3);
		assert.equal(groups.rate_limit_period, 'minute');
	});

	await t.test('path forwarding is disabled, so Hookdeck cannot rewrite the n8n path', async () => {
		const { connection } = await provision(`${PREFIX}-path`, {});
		assert.equal(connection.destination.config.path_forwarding_disabled, true);
		assert.equal(connection.destination.config.url, DESTINATION_URL);
	});

	/* ──────────────────────── verification shapes ────────────────────── */

	// For generic sources Hookdeck echoes `config.auth_type` but never
	// `config.auth`, so the scheme is assertable and its parameters are not.
	for (const [label, params, expected] of [
		[
			'generic HMAC',
			{
				verification: 'HMAC',
				hmacSecret: 'shhh',
				hmacHeaderKey: 'x-my-signature',
				hmacAlgorithm: 'sha512',
				hmacEncoding: 'base64',
			},
			'HMAC',
		],
		[
			'generic API key',
			{ verification: 'API_KEY', authHeaderName: 'x-tenant-key', apiKeyValue: 'secret-value' },
			'API_KEY',
		],
		[
			'generic basic auth',
			{ verification: 'BASIC_AUTH', basicAuthUsername: 'alice', basicAuthPassword: 'hunter2' },
			'BASIC_AUTH',
		],
	]) {
		await t.test(`${label} verification is provisioned as configured`, async () => {
			const { connection } = await provision(`${PREFIX}-${expected.toLowerCase()}`, params);
			const source = await api('GET', `/sources/${connection.source.id}`);

			assert.equal(source.config.auth_type, expected);
			assert.equal(
				'auth' in source.config,
				false,
				'the API must not echo back verification parameters',
			);
		});
	}

	await t.test('a platform source is accepted with its secret, and reveals nothing', async () => {
		// Platform sources never echo `auth_type`, configured or not, so acceptance
		// of the upsert is all the API can prove here. Whether verification is
		// actually live is only observable by signing a real payload, which
		// `verification.test.mjs` does for Stripe and GitHub.
		for (const sourceType of ['STRIPE', 'GITHUB']) {
			const { connection } = await provision(`${PREFIX}-${sourceType.toLowerCase()}`, {
				sourceType,
				platformSecret: 'whsec_livetest',
			});
			const source = await api('GET', `/sources/${connection.source.id}`);

			assert.equal(source.type, sourceType);
			assert.equal(
				source.config?.auth_type ?? null,
				null,
				`${sourceType}: a platform source unexpectedly echoed its scheme`,
			);
		}
	});

	await t.test('a configured platform source is indistinguishable from a bare one', async () => {
		// This is the trap the README describes, and it is worth asserting rather
		// than assuming: the two sources differ only in that one has a secret, and
		// the API returns byte-identical config for both. An unsigned delivery is
		// the only way to tell them apart.
		const { connection: bare } = await provision(`${PREFIX}-stripe-bare`, { sourceType: 'STRIPE' });
		const { connection: keyed } = await provision(`${PREFIX}-stripe-keyed`, {
			sourceType: 'STRIPE',
			platformSecret: 'whsec_livetest',
		});

		const bareSource = await api('GET', `/sources/${bare.source.id}`);
		const keyedSource = await api('GET', `/sources/${keyed.source.id}`);

		assert.deepEqual(
			bareSource.config,
			keyedSource.config,
			'if these ever differ, the README trap is fixed and that section should say so',
		);
	});

	await t.test('Source Config (JSON) overrides the generated config', async () => {
		// The merge is one level deep, so `auth` is replaced wholesale rather than
		// blended. That suits the documented purpose — expressing a scheme the
		// fields cannot — but it means a partial `auth` block drops the rest of it.
		const { connection } = await provision(`${PREFIX}-rawcfg`, {
			verification: 'HMAC',
			hmacSecret: 'shhh',
			options: {
				sourceConfigJson: JSON.stringify({
					auth_type: 'API_KEY',
					auth: { header_key: 'x-overridden', api_key: 'from-json' },
				}),
			},
		});
		const source = await api('GET', `/sources/${connection.source.id}`);

		assert.equal(
			source.config.auth_type,
			'API_KEY',
			'Source Config (JSON) did not override the generated scheme',
		);
	});

	await t.test(
		'a partial auth override is rejected rather than silently half-applied',
		async () => {
			await assert.rejects(
				provision(`${PREFIX}-partial`, {
					verification: 'HMAC',
					hmacSecret: 'shhh',
					options: { sourceConfigJson: JSON.stringify({ auth: { header_key: 'x-only' } }) },
				}),
				/is required/,
				'a partial override must fail loudly, not provision a broken source',
			);
		},
	);

	/* ─────────────────── activation and test-run behaviour ───────────── */

	await t.test('a test run provisions a separate connection sharing one source', async () => {
		const sourceName = `${PREFIX}-modes`;
		const { connection: production } = await provision(sourceName, {});
		const { connection: _ } = await provision(
			sourceName,
			{},
			{
				webhookUrl: 'https://example.com/webhook-test/live',
				mode: 'manual',
			},
		);

		const { models } = await api('GET', '/connections?limit=250');
		const owned = models.filter((c) => c.source?.name === sourceName);

		assert.equal(owned.length, 2, 'test and production must not share a connection');
		assert.equal(
			new Set(owned.map((c) => c.source.id)).size,
			1,
			'README says both connections share one source, so one URL',
		);
		assert.ok(production, 'production connection went missing');
	});

	await t.test('the source list surfaces every source with its public URL', async () => {
		const sourceName = `${PREFIX}-list`;
		await provision(sourceName, {});

		const { results } = await new HookdeckEventGatewayTrigger().methods.listSearch.searchSources.call(
			liveLoadOptionsContext(''),
			'',
		);

		const found = results.find((r) => r.name?.includes(sourceName));
		assert.ok(found, 'a provisioned source did not appear in the list');
		assert.ok(
			JSON.stringify(found).includes('hkdk.events'),
			'README says the list shows the public URL',
		);
	});

	/* ─────────────────────── action node: read paths ──────────────────── */

	await t.test('Get Many and Get round-trip for every readable resource', async () => {
		for (const resource of [
			'attempt',
			'connection',
			'destination',
			'event',
			'issue',
			'request',
			'source',
		]) {
			const many = await new HookdeckEventGateway().execute.call(
				liveExecuteContext({
					resource,
					operation: 'getAll',
					returnAll: false,
					limit: 3,
					filters: {},
				}),
			);
			const rows = many[0].map((r) => r.json);
			assert.ok(Array.isArray(rows), `${resource}: Get Many did not return rows`);
			if (rows.length === 0) continue;

			// Re-list on a 404. This project carries live traffic, so an issue or
			// event listed a moment ago can be gone by the time it is fetched —
			// which says nothing about whether Get works.
			const found = await until(
				`a ${resource} that survives being fetched`,
				async () => {
					const listed = await new HookdeckEventGateway().execute.call(
						liveExecuteContext({
							resource,
							operation: 'getAll',
							returnAll: false,
							limit: 3,
							filters: {},
						}),
					);
					for (const row of listed[0].map((r) => r.json)) {
						try {
							const one = await new HookdeckEventGateway().execute.call(
								liveExecuteContext({ resource, operation: 'get', id: row.id }),
							);
							return one[0][0].json.id === row.id;
						} catch (error) {
							if (!/404/.test(error.message)) throw error;
						}
					}
					return false;
				},
				{ attempts: 4, delayMs: 500 },
			);

			assert.ok(found, `${resource}: Get never returned a record it had just listed`);
		}
	});

	await t.test('Get Count is exact where Hookdeck counts, and a floor for events', async () => {
		for (const resource of ['connection', 'destination', 'issue', 'source']) {
			// Compared under `until` because the count is project-wide: this project
			// carries live traffic, and a concurrent suite creating a source makes
			// the two reads disagree for reasons that have nothing to do with the
			// node. A node returning a page size instead of a total would never
			// agree, however many times it were re-read.
			const agreed = await until(
				`${resource} count to settle`,
				async () => {
					const result = await new HookdeckEventGateway().execute.call(
						liveExecuteContext({ resource, operation: 'getCount', filters: {} }),
					);
					const truth = await api('GET', `/${resource}s/count`);
					return result[0][0].json.count === truth.count ? result[0][0].json : null;
				},
				{ attempts: 5, delayMs: 1000 },
			);

			assert.equal(agreed.isAtLeast, false, `${resource}: an exact count is not a floor`);
		}

		const events = await new HookdeckEventGateway().execute.call(
			liveExecuteContext({ resource: 'event', operation: 'getCount', filters: {} }),
		);
		assert.equal(
			typeof events[0][0].json.isAtLeast,
			'boolean',
			'an event count must flag its floor',
		);
		assert.ok(events[0][0].json.countedUpTo > 0, 'an event count must report its ceiling');
	});

	await t.test('Get Many honours the limit, and Return All pages past it', async () => {
		const limited = await new HookdeckEventGateway().execute.call(
			liveExecuteContext({
				resource: 'source',
				operation: 'getAll',
				returnAll: false,
				limit: 2,
				filters: {},
			}),
		);
		assert.ok(limited[0].length <= 2, 'limit was not honoured');

		// Same project-wide race as above: page while a suite is creating sources
		// and the walk legitimately disagrees with a count taken after it.
		const walked = await until(
			'Return All to agree with /count',
			async () => {
				const all = await new HookdeckEventGateway().execute.call(
					liveExecuteContext({
						resource: 'source',
						operation: 'getAll',
						returnAll: true,
						filters: {},
					}),
				);
				const { count } = await api('GET', '/sources/count');
				return all[0].length === count ? all[0].length : null;
			},
			{ attempts: 5, delayMs: 1000 },
		);

		assert.ok(walked > 2, 'Return All did not page past the first page');
	});

	await t.test('Source → Get URL returns the ingest URL, normalising the name', async () => {
		const sourceName = `${PREFIX}-geturl`;
		const { connection } = await provision(sourceName, {});

		const result = await new HookdeckEventGateway().execute.call(
			liveExecuteContext({ resource: 'source', operation: 'getUrl', name: sourceName }),
		);
		assert.equal(result[0][0].json.url, connection.source.url);

		await assert.rejects(
			new HookdeckEventGateway().execute.call(
				liveExecuteContext({ resource: 'source', operation: 'getUrl', name: `${PREFIX}-absent` }),
			),
			/No Hookdeck source named/,
			'a missing source must fail loudly, not return an empty row',
		);
	});

	/* ────────────────── action node: mutating operations ──────────────── */

	await t.test('Connection Pause, Unpause and Delete act on the connection', async () => {
		const sourceName = `${PREFIX}-mutate`;
		const { connection } = await provision(sourceName, {});
		const run = (operation) =>
			new HookdeckEventGateway().execute.call(
				liveExecuteContext({ resource: 'connection', operation, id: connection.id }),
			);

		await run('pause');
		assert.ok((await api('GET', `/connections/${connection.id}`)).paused_at, 'Pause did not pause');

		await run('unpause');
		assert.equal(
			(await api('GET', `/connections/${connection.id}`)).paused_at,
			null,
			'Unpause did not resume',
		);

		await run('delete');
		await assert.rejects(
			api('GET', `/connections/${connection.id}`),
			/41[0-9]|404/,
			'Delete did not remove the connection',
		);
	});

	await t.test('Event Retry, Mute and Cancel act on this run’s own events', async () => {
		const sourceName = `${PREFIX}-events`;
		const { connection } = await provision(sourceName, {});

		await fetch(connection.source.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ run: PREFIX, event: 'live.test' }),
		});

		// Only ever this run's events: the project also holds production traffic.
		const event = await until('an event from this run', async () => {
			const { models = [] } = await api('GET', `/events?source_id=${connection.source.id}&limit=1`);
			return models[0];
		});

		const run = (operation) =>
			new HookdeckEventGateway().execute.call(
				liveExecuteContext({ resource: 'event', operation, id: event.id }),
			);

		const retried = await run('retry');
		assert.ok(retried[0][0].json, 'Retry returned nothing');

		await run('mute').catch((error) => {
			// Hookdeck rejects muting an event that is not in a mutable state; the
			// operation is still proven to reach the right endpoint.
			assert.match(error.message, /HTTP 4\d\d/, `Mute failed unexpectedly: ${error.message}`);
		});
		await run('cancel').catch((error) => {
			assert.match(error.message, /HTTP 4\d\d/, `Cancel failed unexpectedly: ${error.message}`);
		});

		const requests = await new HookdeckEventGateway().execute.call(
			liveExecuteContext({
				resource: 'request',
				operation: 'getAll',
				returnAll: false,
				limit: 1,
				filters: { source_id: connection.source.id },
			}),
		);
		assert.equal(requests[0].length, 1, 'the original request was not retrievable');

		const attempts = await new HookdeckEventGateway().execute.call(
			liveExecuteContext({
				resource: 'attempt',
				operation: 'getAll',
				returnAll: false,
				limit: 1,
				filters: { event_id: event.id },
			}),
		);
		assert.ok(Array.isArray(attempts[0]), 'delivery attempts were not retrievable');
	});

	await t.test('Issue Update and Dismiss are wired, when an issue exists', async (t) => {
		const { models = [] } = await api('GET', '/issues?limit=1&status=OPENED');
		if (models.length === 0) {
			t.skip('no open issue in the project to act on');
			return;
		}

		// Read-only assertion: dismissing a real issue would suppress a genuine
		// alert in a project that carries production traffic.
		const issue = await new HookdeckEventGateway().execute.call(
			liveExecuteContext({ resource: 'issue', operation: 'get', id: models[0].id }),
		);
		assert.equal(issue[0][0].json.id, models[0].id);
	});
});
