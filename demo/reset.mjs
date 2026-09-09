#!/usr/bin/env node
/**
 * Demo stage manager for the Hookdeck n8n node launch demo.
 *
 *   node demo/reset.mjs status   read-only. Run this first.
 *   node demo/reset.mjs reset    put the stage back to its starting state
 *   node demo/reset.mjs prime    fire one failing Stripe event
 *
 * Two things here are not obvious and cost a rehearsal each if you get them
 * wrong.
 *
 * A delivery issue aggregates on (webhook_id, error_code, response_status), and
 * `webhook_id` is the FAILING connection - the Stripe one - not the agent's.
 * Once an issue exists for that connection, later failures join it and no
 * `issue.opened` fires. Setting the issue to IGNORED does NOT reset this;
 * measured directly, a second failure after dismissing produced no new issue in
 * 84 seconds. A new connection id does reset it, and deleting a connection also
 * removes its issues, so `reset` deletes both connections and lets republishing
 * re-provision them. That single act clears the issues and resets aggregation.
 *
 * The n8n Public API is unavailable on a Cloud trial, so this drives n8n through
 * the instance MCP server instead - `unpublish_workflow` and `publish_workflow`.
 *
 * Reads demo/.env. Never logs a key.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- config -----------------------------------------------------------------
const INGEST_WF = 'Stripe ingestion';
const INCIDENT_WF = 'Ingestion incident';
const STRIPE_SRC = 'demo-stripe';
const ISSUES_SRC = 'demo-hookdeck-issues';
const HD = 'https://api.hookdeck.com/2025-07-01';

const HD_KEY = process.env.HOOKDECK_DEMO_API_KEY;
const MCP_TOKEN = process.env.N8N_MCP_TOKEN;
const N8N_URL = (process.env.N8N_URL || '').replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => { console.error(`\nFAILED: ${msg}`); process.exit(1); };

// --- Hookdeck ---------------------------------------------------------------
async function hd(path, init = {}) {
	const res = await fetch(`${HD}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${HD_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
	});
	const text = await res.text();
	if (!res.ok) die(`Hookdeck ${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}
/** Walk Hookdeck's cursor pagination so a big project does not silently truncate. */
async function hdAll(resource) {
	const out = [];
	let next = null;
	do {
		const qs = new URLSearchParams({ limit: '100', ...(next ? { next } : {}) });
		const page = await hd(`/${resource}?${qs}`);
		out.push(...(page.models || []));
		next = page.pagination?.next || null;
	} while (next);
	return out;
}

// --- n8n, over the instance MCP server --------------------------------------
let rpcId = 1;
let mcpReady = false;
async function rpc(method, params, notify = false) {
	const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
	if (!notify) body.id = rpcId++;
	const res = await fetch(`${N8N_URL}/mcp-server/http`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${MCP_TOKEN}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2025-06-18',
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (notify) return null;
	if (res.status === 401) die('n8n rejected N8N_MCP_TOKEN. Regenerate it in Settings -> Instance-level MCP.');
	// Streamable HTTP is allowed to answer a POST with an SSE frame instead of JSON.
	const payload = text.startsWith('event:') || text.startsWith('data:')
		? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
		: text;
	try { return JSON.parse(payload); } catch { die(`n8n MCP returned unparseable body: ${text.slice(0, 200)}`); }
}
async function mcp(name, args = {}) {
	if (!mcpReady) {
		await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-reset', version: '1' } });
		await rpc('notifications/initialized', undefined, true);
		mcpReady = true;
	}
	const r = await rpc('tools/call', { name, arguments: args });
	if (r.error) die(`n8n MCP ${name}: ${JSON.stringify(r.error)}`);
	const text = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
	if (r.result?.isError) die(`n8n MCP ${name}: ${text.slice(0, 300)}`);
	try { return JSON.parse(text); } catch { return text; }
}

async function findWorkflows() {
	const { data = [] } = await mcp('search_workflows', { limit: 100 });
	const found = {};
	for (const name of [INGEST_WF, INCIDENT_WF]) {
		const matches = data.filter((w) => w.name === name);
		if (!matches.length) die(`no n8n workflow named "${name}". Build it first, or fix the name at the top of this script.`);
		// Refuse rather than pick. A failed import leaves a second workflow with
		// the same name and no nodes, and silently resetting that one instead
		// looks like the demo simply stopped working.
		if (matches.length > 1) {
			die(`${matches.length} workflows are named "${name}": ${matches.map((w) => `${w.id}(${w.active ? 'published' : 'draft'})`).join(', ')}.
     Delete the duplicates in n8n, or rename the one you want. This script will
     not guess which is the real one.`);
		}
		found[name] = matches[0];
	}
	return found;
}

function need() {
	if (!HD_KEY) die('HOOKDECK_DEMO_API_KEY is not set. Copy demo/.env.example to demo/.env.');
	if (!MCP_TOKEN) die('N8N_MCP_TOKEN is not set. Settings -> Instance-level MCP, then put it in demo/.env.');
	if (!N8N_URL) die('N8N_URL is not set. Put your n8n instance URL in demo/.env.');
}

// --- status -----------------------------------------------------------------
async function status() {
	need();
	const [sources, destinations, connections, issues, triggers] = await Promise.all([
		hdAll('sources'), hdAll('destinations'), hdAll('connections'), hdAll('issues'), hdAll('issue-triggers'),
	]);
	const wfs = await findWorkflows();

	console.log('n8n');
	for (const [name, wf] of Object.entries(wfs)) {
		console.log(`  ${name.padEnd(20)} ${wf.active ? 'PUBLISHED' : 'draft    '}  ${wf.id}`);
	}
	console.log('\nHookdeck');
	console.log(`  sources      ${sources.length}   ${sources.map((s) => s.name).join(', ')}`);
	console.log(`  destinations ${destinations.length}`);
	console.log(`  connections  ${connections.length}`);
	for (const c of connections) console.log(`     ${c.paused_at ? 'PAUSED ' : '       '}${c.full_name}`);
	console.log(`  open issues  ${issues.filter((i) => i.status === 'OPENED').length} of ${issues.length}`);

	const delivery = triggers.find((t) => t.type === 'delivery');
	const stripeConn = connections.find((c) => c.source?.name === STRIPE_SRC);
	const watched = delivery?.configs?.connections;
	console.log(`  issue trigger ${delivery ? delivery.id : 'MISSING'} strategy=${delivery?.configs?.strategy} watching=${JSON.stringify(watched)}`);

	// The checks that decide whether a take will work.
	const problems = [];
	if (!delivery) problems.push('no delivery issue trigger in this project');
	else if (watched === '*') problems.push('issue trigger watches "*", so the agent workflow can raise an issue that notifies itself - a loop on camera');
	else if (stripeConn && !(watched || []).includes(stripeConn.id)) problems.push('issue trigger does not watch the current Stripe connection, so a failure will raise nothing');
	if (issues.some((i) => i.status === 'OPENED')) problems.push('an issue is already OPENED, so the next failure will join it and fire no notification');
	if (connections.some((c) => c.paused_at)) problems.push('a connection is paused from a previous run');
	// /notifications/webhooks is PUT-only - there is no GET - so this script
	// cannot read back where issue.opened points. reset always rewrites it.
	console.log('\n  note: the issue.opened notification target cannot be read back (the API is PUT-only). `reset` always rewrites it.');
	if (problems.length) {
		console.log('\nNOT READY:');
		for (const p of problems) console.log(`  - ${p}`);
		process.exitCode = 1;
	} else {
		console.log('\nREADY');
	}
}

// --- reset ------------------------------------------------------------------
async function reset() {
	need();
	const wfs = await findWorkflows();

	console.log('1/6  unpublish both workflows');
	for (const [name, wf] of Object.entries(wfs)) {
		if (wf.active) { await mcp('unpublish_workflow', { workflowId: wf.id }); console.log(`     unpublished ${name}`); }
		else console.log(`     ${name} already a draft`);
	}

	console.log('2/6  delete every connection');
	// Both of them, not just the agent's. The Stripe connection is the one a
	// delivery issue aggregates on, so leaving it in place is what made the old
	// script work exactly once.
	for (const c of await hdAll('connections')) {
		await hd(`/connections/${c.id}`, { method: 'DELETE' });
		console.log(`     deleted ${c.full_name}`);
	}

	console.log('3/6  sweep destinations the trigger orphaned');
	// The trigger never deletes the destinations it provisions (issue #13), so
	// they accumulate one per publish cycle.
	const live = new Set((await hdAll('connections')).map((c) => c.destination?.id));
	let swept = 0;
	for (const d of await hdAll('destinations')) {
		if (/^n8n-/.test(d.name || '') && !live.has(d.id)) { await hd(`/destinations/${d.id}`, { method: 'DELETE' }); swept++; }
	}
	console.log(`     removed ${swept}`);

	console.log('4/6  republish both workflows');
	// Incident first: its source must exist before the notification can point at
	// it. Publishing returns before Hookdeck provisioning finishes, so poll.
	for (const name of [INCIDENT_WF, INGEST_WF]) {
		await mcp('publish_workflow', { workflowId: wfs[name].id });
		console.log(`     published ${name}`);
	}
	let sources = [];
	let connections = [];
	for (let i = 0; i < 60; i++) {
		[sources, connections] = await Promise.all([hdAll('sources'), hdAll('connections')]);
		if (connections.length >= 2) break;
		await sleep(1000);
	}
	if (connections.length < 2) die(`only ${connections.length} connection(s) provisioned after 60s. Check the n8n executions list.`);

	const issuesSrc = sources.find((s) => s.name === ISSUES_SRC);
	const stripeConn = connections.find((c) => c.source?.name === STRIPE_SRC);
	if (!issuesSrc) die(`publishing did not provision a source named ${ISSUES_SRC}.`);
	if (!stripeConn) die(`publishing did not provision a connection on ${STRIPE_SRC}.`);

	console.log('5/6  point issue.opened at the agent source');
	// Project-level, not a channel on the issue trigger: adding channels.webhook
	// to a trigger returns 200 and silently discards it.
	await hd('/notifications/webhooks', { method: 'PUT', body: JSON.stringify({ enabled: true, topics: ['issue.opened'], source_id: issuesSrc.id }) });
	console.log(`     -> ${issuesSrc.id}`);

	console.log('6/6  scope the issue trigger to the Stripe connection only');
	// Excluding the agent's own connection is what stops a failure in the agent
	// workflow opening an issue that notifies the agent workflow.
	const delivery = (await hdAll('issue-triggers')).find((t) => t.type === 'delivery');
	if (!delivery) die('this project has no delivery issue trigger. Create one in the Hookdeck dashboard (Issues -> Issue triggers).');
	await hd(`/issue-triggers/${delivery.id}`, { method: 'PUT', body: JSON.stringify({ configs: { strategy: 'first_attempt', connections: [stripeConn.id] } }) });
	console.log(`     watching ${stripeConn.id} (${stripeConn.full_name})`);

	console.log('\n--- verify ---');
	await status();
}

// --- warmup -----------------------------------------------------------------
/**
 * Fire a few events that SUCCEED, so the connection list has traffic on it
 * before anything breaks.
 *
 * Without this the "before" frame reads 0 events and NO DATA, which looks like
 * an empty project rather than a system that was working until it wasn't. The
 * ingestion workflow posts to Hookdeck's mock API with the status taken from
 * the payload, so the same connection carries both.
 */
async function warmup() {
	need();
	const src = (await hdAll('sources')).find((s) => s.name === STRIPE_SRC);
	if (!src) die(`no source named ${STRIPE_SRC}. Run reset first.`);
	const n = Number(process.argv[3] || 6);
	for (let i = 0; i < n; i++) {
		const res = await fetch(src.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				id: `evt_ok_${Date.now().toString(36)}_${i}`,
				type: 'payment_intent.succeeded',
				demo_fail: false,
				data: { object: { id: `pi_3Qx${i}`, amount: 1200 + i * 350, currency: 'gbp' } },
			}),
		});
		process.stdout.write(`  ${i + 1}/${n} -> ${res.status}\n`);
		await sleep(700);
	}
	console.log(`\n${n} events delivered successfully. The connection list now has traffic on it.`);
	console.log('Capture the "before" frame now, then run prime.');
}

// --- prime ------------------------------------------------------------------
async function prime() {
	need();
	const src = (await hdAll('sources')).find((s) => s.name === STRIPE_SRC);
	if (!src) die(`no source named ${STRIPE_SRC}. Run reset first.`);

	// Several failures, not one. The agent is asked to distinguish a transient
	// blip from a destination that is actually down, and it makes that call by
	// counting failed events on the destination. One failure is a blip, and an
	// agent that paused a whole connection over it would be wrong - so the
	// scenario has to show a pattern.
	//
	// Timing: the issue opens on the FIRST failure and the agent starts about
	// 4.5s later, reaching "List failed events" a second or two after that. At
	// 700ms apart, the rest of these have landed by then.
	// Fired concurrently, not in sequence. The agent starts about 4.5s after the
	// FIRST failure and counts a second or two later; spacing these 700ms apart
	// meant only one had reached FAILED by then, so the agent correctly judged a
	// single failure transient and did not pause. A burst puts all of them in
	// FAILED before anyone looks.
	const n = Number(process.argv[3] || 6);
	const codes = await Promise.all(
		Array.from({ length: n }, (_, i) =>
			fetch(src.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: `evt_${Date.now().toString(36)}_${i}`,
					type: 'payment_intent.succeeded',
					// The ingestion workflow reads this to pick the mock's status code.
					demo_fail: true,
					data: { object: { id: `pi_3QxFail${i}`, amount: 2400 + i * 110, currency: 'gbp' } },
				}),
			}).then((r) => r.status),
		),
	);
	console.log(`  ${n} fired -> ${codes.join(' ')}`);
	console.log(`\n${n} failing events fired. The first opens the issue; the agent should see`);
	console.log('all of them when it counts, and pause on the pattern rather than on one blip.');
	console.log('Watch: ' + N8N_URL + '/home/executions');
}

const commands = { status, reset, warmup, prime };
const cmd = process.argv[2] || 'status';
if (!commands[cmd]) die(`unknown command "${cmd}". Use: ${Object.keys(commands).join(' | ')}`);
await commands[cmd]();
