# Demo setup

One script, `reset-demo.sh`, which puts
[`examples/ai-incident-agent.json`](../examples/ai-incident-agent.json) back
into a state where it will fire again. Nothing here is part of the published
package — `package.json` ships `dist/nodes` and `dist/credentials` only.

## What the demo shows

A delivery fails somewhere in your Hookdeck project. Hookdeck opens a delivery
issue on the first failed attempt, a project notification posts `issue.opened`
to the agent workflow's source, and the workflow runs **on its own**: an AI
agent reads the issue, counts how many events are failing on that destination,
and pauses the connection so retries stop piling up against something that is
already broken.

Measured over three consecutive runs from a cleared project, the failure to the
agent's incident note took **6–8 seconds**. The most legible moment is the
Hookdeck dashboard's connection list before and after — it is the external
system that changed, not an n8n panel.

## Prerequisites

- **Node 20 or newer** and **curl**. The script parses JSON with `node`, so
  there is no `jq` or `python3` dependency.
- **A running n8n** with this node installed, at `http://localhost:5678` or
  wherever `N8N_URL` points.
- **The agent workflow imported and published once**, under its exported name
  `Hookdeck — AI incident agent`. The script finds it by that name — publishing
  it once is what provisions the Hookdeck source it needs.
- **`N8N_API_KEY`** (n8n → Settings → API) and **`HOOKDECK_EG_API_KEY`** (a
  Hookdeck project API key), exported or in `.env` in the repo root. An exported
  value wins over `.env`.
- **A throwaway Hookdeck project.** The script deletes resources; do not point
  it at a project carrying live traffic.
- **A delivery issue trigger** in that project (Hookdeck dashboard → Issues).
  Without one, no failure ever becomes an issue and the demo has no first half.
  The script stops with that message rather than half-running.
- **The Hookdeck CLI**, logged in, unless you pass `--no-listen`. Pass it when
  n8n is reachable from the internet (`WEBHOOK_URL` set) — the trigger then
  provisions an HTTP destination and the CLI is not involved.
- **Something that fails.** The agent reacts to *another* connection's delivery
  failing. Either an n8n workflow on **Sync** acknowledgement that errors, or a
  plain Hookdeck connection pointing at a URL that returns 500. Sync is the part
  that matters and it is explained in
  [`examples/README.md`](../examples/README.md#ai-incident-agentjson): on Async
  Retry the delivery succeeds the moment Hookdeck hands the event over, so a
  downstream failure never bounces back and no issue is ever raised.

## What it deletes and overwrites

In the Hookdeck project the API key points at:

| Deleted | Scope |
| --- | --- |
| Connections on the source `n8n-example-hookdeck-issues` | that source only |
| Destinations named `n8n-*` that no connection references | orphans only |

| Overwritten | Effect |
| --- | --- |
| Every `OPENED` issue | set to `IGNORED` — project-wide |
| The project webhook notification config | `issue.opened` → the agent's source |
| The delivery issue trigger's `configs` | `first_attempt`, watching every connection except the agent's own |

It does **not** delete sources, workflows, credentials, or connections on any
other source. In n8n it only deactivates and reactivates the one workflow.

The connection deletion is the load-bearing part. Hookdeck aggregates delivery
issues by `(webhook_id, error_code, response_status)`, so once an issue exists
for a connection, later failures **join** it and no `issue.opened` fires.
Dismissing the issue does not reset that — verified directly: after dismissing,
three further failures produced no new issue. A new connection id is the only
reliable reset, which is why the script deletes the connection and lets
activation re-provision it.

## Running it

```bash
./demo-setup/reset-demo.sh              # ~30s, ends with READY
./demo-setup/reset-demo.sh --no-listen  # n8n is publicly reachable; no CLI
N8N_URL=http://localhost:5679 ./demo-setup/reset-demo.sh
```

It runs from any working directory — it resolves the repo root from its own
location — and every prerequisite is checked before anything is deleted, so a
missing key or a stopped n8n fails with a sentence about what to fix rather than
half a reset.

Then make a delivery fail on one of the watched connections and watch the
executions list. Re-running the script is the way to get a second run: without
it the second failure joins the existing issue and nothing fires.

## Things that will bite you

- **`hookdeck listen` attaches to the connections that exist when it starts.**
  Start it before activating the workflow and it forwards nothing. The script
  starts it last and aborts if it attached to nothing, because an unattached CLI
  means Hookdeck accepts events that never reach n8n — which looks like a broken
  demo for the wrong reason.
- **Deactivating a workflow orphans the destination it provisioned** rather than
  deleting it (#13), so a project accumulates `n8n-*` destinations across
  resets. The script sweeps the unreferenced ones.
- **Webhook notifications are project-level.** Adding `channels.webhook` to an
  issue trigger returns HTTP 200 and silently discards it; the real setting is
  `PUT /notifications/webhooks` with a `source_id`.
- **The agent's own connection must be excluded from the issue trigger.**
  Otherwise a failure in the agent workflow opens an issue, which notifies the
  agent workflow. The workflow's Async Retry acknowledgement already makes that
  unlikely; the scoping makes it impossible.
- **Uninstalling the package through n8n's Public API is a one-way door** until
  the package is verified — the API will not install it back. See
  [CONTRIBUTING.md](../CONTRIBUTING.md#trying-the-nodes-in-a-real-n8n).
