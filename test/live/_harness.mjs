/**
 * Shared plumbing for the live suites.
 *
 * These tests exercise the built `dist/` nodes against a real Hookdeck project.
 * Nothing here reimplements node behaviour — the contexts below are the minimum
 * n8n surface the nodes touch, wired to real HTTP.
 *
 * SAFETY: every resource a run creates carries that run's id, and `destroy()`
 * refuses to delete anything that does not — see `ownedByThisRun` for the three
 * naming forms involved. The project this was written against also holds
 * production sources, so the guard is load bearing: do not relax it into a
 * broader name match.
 *
 * Each test file gets its own run id, so suites can run concurrently without one
 * cleanup deleting a resource another is still using.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

export const API_KEY = process.env.HOOKDECK_EG_API_KEY;
export const BASE_URL = 'https://api.hookdeck.com/2025-07-01';
export const skip = API_KEY ? false : 'HOOKDECK_EG_API_KEY is not set';

export const RUN_ID = randomBytes(4).toString('hex');
export const PREFIX = `n8n-live-${RUN_ID}`;

/** Call the Hookdeck API directly, to arrange fixtures and assert real state. */
export async function api(method, path, body) {
	const response = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
	return text ? JSON.parse(text) : {};
}

/**
 * Whether a name belongs to this run.
 *
 * Three forms, because three things do the naming:
 *   - `n8n-live-<run>-…`     resources these tests create directly
 *   - `cli-n8n-live-<run>-…` what `hookdeck listen` derives from those
 *   - `n8n-<run>-<node>`     what the *node* names a connection, from the
 *                            workflow id — which the live contexts set to the
 *                            run id precisely so it lands in this net
 *
 * The third was missing at first, so every node-provisioned connection survived
 * cleanup and then blocked its source from being deleted. Widening this any
 * further starts deleting real resources: the project under test also holds
 * production sources.
 */
function ownedByThisRun(name) {
	if (typeof name !== 'string') return false;
	return (
		name.startsWith(PREFIX) || name.startsWith(`cli-${PREFIX}`) || name.startsWith(`n8n-${RUN_ID}-`)
	);
}

/** Delete a resource, but only one this run created. */
export async function destroy(kind, resource) {
	if (!ownedByThisRun(resource?.name)) {
		throw new Error(`refusing to delete ${kind} "${resource?.name}" — not owned by ${PREFIX}`);
	}
	await api('DELETE', `/${kind}/${resource.id}`);
}

/**
 * Remove every resource this run created, dependants first.
 *
 * Failures are reported rather than swallowed. A silent catch here hides leaked
 * resources in a shared project, which is how they accumulated unnoticed.
 */
export async function cleanUpRun() {
	const leaked = [];
	const sweep = async (kind, models) => {
		for (const model of models.filter((m) => ownedByThisRun(m.name))) {
			try {
				await destroy(kind, model);
			} catch (error) {
				leaked.push(`${kind}/${model.id} (${model.name}): ${error.message}`);
			}
		}
	};

	const { models: connections = [] } = await api('GET', '/connections?limit=250');
	await sweep('connections', connections);
	for (const kind of ['sources', 'destinations']) {
		const { models = [] } = await api('GET', `/${kind}?limit=250`);
		await sweep(kind, models);
	}

	if (leaked.length) {
		console.error(`\n  LEAKED ${leaked.length} resource(s) in the project:`);
		for (const entry of leaked) console.error(`    ${entry}`);
	}
}

/**
 * Whether Hookdeck considered an inbound request verified.
 *
 * Only the request *detail* carries the field — the list omits it, which is the
 * trap the README calls out, and the reason this fetches each candidate.
 */
export async function requestFor(sourceId, marker) {
	return await until(`a request containing "${marker}"`, async () => {
		const { models = [] } = await api('GET', `/requests?source_id=${sourceId}&limit=10`);
		for (const candidate of models) {
			const detail = await api('GET', `/requests/${candidate.id}`);
			if (JSON.stringify(detail.data?.body ?? '').includes(marker)) return detail;
		}
		return null;
	});
}

export async function wasVerified(sourceId, marker) {
	return (await requestFor(sourceId, marker)).verified;
}

/** Poll until `check` returns something truthy, or give up. */
export async function until(label, check, { attempts = 40, delayMs = 1000 } = {}) {
	let lastError;
	for (let i = 0; i < attempts; i++) {
		try {
			const result = await check();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

/**
 * The connection the *node* provisioned for a source.
 *
 * A source can carry more than one: `hookdeck listen` adds its own `cli-…`
 * connection alongside. Excluding those keeps this unambiguous, so a caller
 * asking for the node's work never silently gets the CLI's.
 */
export async function connectionForSource(sourceName) {
	const { models = [] } = await api('GET', '/connections?limit=250');
	return models.find((c) => c.source?.name === sourceName && !c.name?.startsWith('cli-'));
}

/** The `hookdeck listen` connection for a source. */
export async function cliConnectionForSource(sourceName) {
	return await until(`the CLI connection for ${sourceName}`, async () => {
		const { models = [] } = await api('GET', '/connections?limit=250');
		return models.find((c) => c.name === `cli-${sourceName}`);
	});
}

/** Post a payload to a Hookdeck ingest URL and report what the edge answered. */
export async function ingest(url, body, headers = {}) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body,
	});
	return { status: response.status, ok: response.ok };
}

/* ───────────────────────────── node contexts ─────────────────────────── */

export async function liveHttpHelper(_credentialType, options) {
	const url = new URL(options.url);
	for (const [key, value] of Object.entries(options.qs ?? {})) {
		if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
	}
	const response = await fetch(url, {
		method: options.method,
		headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	const parsed = text ? JSON.parse(text) : '';
	if (options.returnFullResponse || options.ignoreHttpStatusErrors) {
		return { statusCode: response.status, body: parsed };
	}
	if (!response.ok) {
		const error = new Error(`HTTP ${response.status}: ${text}`);
		error.httpCode = String(response.status);
		throw error;
	}
	return { statusCode: response.status, body: parsed };
}

/** An IHookFunctions whose HTTP helper reaches the real API. */
export function liveHookContext({ webhookUrl, staticData, params, mode = 'trigger' }) {
	const logs = [];
	return {
		logs,
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => webhookUrl,
		getMode: () => mode,
		getWorkflow: () => ({ id: RUN_ID }),
		getNode: () => ({ id: 'node1', name: 'Hookdeck Event Gateway Trigger', type: 'hookdeckEventGatewayTrigger' }),
		getNodeParameter: (name, fallback) => (name in params ? params[name] : fallback),
		getInstanceId: () => `live${RUN_ID}`,
		logger: {
			debug() {},
			info: (m) => logs.push(m),
			warn: (m) => logs.push(m),
			error: (m) => logs.push(m),
		},
		helpers: { httpRequestWithAuthentication: liveHttpHelper },
	};
}

/** An IWebhookFunctions over a real inbound request. */
export function liveWebhookContext({ rawBody, headers, staticData, options = {}, params = {} }) {
	const sent = {};
	return {
		sent,
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, fallback) => {
			if (name === 'options') return options;
			return name in params ? params[name] : fallback;
		},
		getRequestObject: () => ({ rawBody }),
		getHeaderData: () => headers,
		getQueryData: () => ({}),
		getBodyData: () => {
			try {
				return JSON.parse(rawBody.toString('utf8'));
			} catch {
				return {};
			}
		},
		getResponseObject: () => ({
			status(code) {
				sent.status = code;
				return {
					json: (payload) => void (sent.body = payload),
					end: () => {},
					send: () => {},
				};
			},
		}),
		getNode: () => ({ name: 'Hookdeck Event Gateway Trigger' }),
		logger: { debug() {}, warn: (m) => void (sent.warned = m), error() {} },
		helpers: { returnJsonArray: (items) => [].concat(items).map((json) => ({ json })) },
	};
}

/** An IExecuteFunctions for the action node, over the real API. */
export function liveExecuteContext(params) {
	return {
		getInputData: () => [{ json: {} }],
		continueOnFail: () => false,
		getNode: () => ({ name: 'Hookdeck Event Gateway' }),
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		helpers: { httpRequestWithAuthentication: liveHttpHelper },
	};
}

/** An ILoadOptionsFunctions, for the Source resource locator's list mode. */
export function liveLoadOptionsContext(filter) {
	return {
		getNodeParameter: (_name, fallback) => fallback,
		getNode: () => ({ name: 'Hookdeck Event Gateway Trigger' }),
		getCurrentNodeParameter: () => filter,
		helpers: { httpRequestWithAuthentication: liveHttpHelper },
	};
}

/* ────────────────── local receiver fed by the Hookdeck CLI ───────────── */

/**
 * A local endpoint fed by `hookdeck listen`, handing each request to the node's
 * `webhook()`.
 *
 * Hookdeck will not accept a localhost destination, so events have to come back
 * over something. The CLI is used rather than a third-party tunnel because it
 * is Hookdeck's own transport: the request that arrives carries the real
 * metadata headers (`x-hookdeck-eventid`, `-attempt-count`, `-will-retry-after`
 * and the rest), which is exactly what the node parses.
 *
 * One consequence: a CLI destination is signed with the project's own secret,
 * not the per-connection secret the node provisions for an HTTP destination, so
 * callers must run these with `verifySignature: false`. That hop is covered
 * separately by the forged-signature test and the unit suite.
 */
export async function startCliReceiver(HookdeckEventGatewayTrigger, sourceName) {
	const deliveries = [];
	let staticData = {};
	let options = {};
	let handler = null;

	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const rawBody = Buffer.concat(chunks);

		if (handler) {
			const outcome = await handler({ rawBody, headers: req.headers, url: req.url, res });
			if (outcome?.handled) return;
		}

		const ctx = liveWebhookContext({ rawBody, headers: req.headers, staticData, options });
		let outcome;
		try {
			outcome = await new HookdeckEventGatewayTrigger().webhook.call(ctx);
		} catch (error) {
			outcome = { error: error.message };
		}
		deliveries.push({ rawBody, headers: req.headers, url: req.url, outcome, sent: ctx.sent });

		// Mirror what n8n does with the return value, so Hookdeck sees the status
		// a real deployment would produce.
		if (outcome?.noWebhookResponse) res.writeHead(ctx.sent.status ?? 401).end();
		else res.writeHead(200).end('ok');
	});

	server.listen(0);
	await once(server, 'listening');
	const port = server.address().port;

	// detached, so the child leads its own process group. The `hookdeck` on PATH
	// is an npm wrapper that spawns the platform binary as a child; signalling
	// only the wrapper leaves that binary running, holding its CLI connection
	// open and this process alive.
	const cli = spawn('hookdeck', ['listen', String(port), sourceName, '--output', 'compact'], {
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
	});
	const ingestUrl = await new Promise((resolve, reject) => {
		let buffer = '';
		const onData = (chunk) => {
			buffer += chunk.toString();
			const match = buffer.match(/https:\/\/hkdk\.events\/[a-z0-9]+/);
			if (match) resolve(match[0]);
		};
		cli.stdout.on('data', onData);
		cli.stderr.on('data', onData);
		cli.on('exit', (code) => reject(new Error(`hookdeck listen exited (${code})`)));
		setTimeout(() => reject(new Error('hookdeck listen did not report a source URL')), 60000);
	});

	// The CLI reports its URL a moment before the connection is ready to carry
	// traffic. Hookdeck retries a delivery that arrives too early, but settling
	// here keeps the first assertion from paying for it.
	await new Promise((resolve) => setTimeout(resolve, 6000));

	return {
		ingestUrl,
		deliveries,
		/** Wait for a delivery whose body contains `marker`. */
		waitFor: (marker, opts) =>
			until(
				`a delivery containing "${marker}"`,
				() => deliveries.find((d) => d.rawBody.toString().includes(marker)),
				opts,
			),
		/** Deliveries seen so far containing `marker`. */
		matching: (marker) => deliveries.filter((d) => d.rawBody.toString().includes(marker)),
		setStaticData: (value) => void (staticData = value),
		setOptions: (value) => void (options = value),
		/** Take over request handling, for tests that need a raw response. */
		setHandler: (value) => void (handler = value),
		async stop() {
			// Signal the whole group, and never await `exit` unconditionally: if the
			// child is already gone that event has fired and will not fire again, so
			// the await would hang for the rest of the run.
			const gone = () => cli.exitCode !== null || cli.signalCode !== null;
			const settle = async (ms) =>
				gone() ||
				(await Promise.race([
					once(cli, 'exit').then(() => true),
					new Promise((resolve) => setTimeout(() => resolve(false), ms)),
				]));

			const signal = (name) => {
				try {
					process.kill(-cli.pid, name);
				} catch {
					// Already reaped, or the group is gone.
				}
			};

			signal('SIGTERM');
			if (!(await settle(3000))) {
				signal('SIGKILL');
				await settle(3000);
			}
			cli.unref();

			server.close();
			await once(server, 'close').catch(() => {});
		},
	};
}
