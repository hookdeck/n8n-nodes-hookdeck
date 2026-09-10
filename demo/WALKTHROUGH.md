# Recording walkthrough

Everything below was run end to end against the live instance on 8 Sep 2026.
Timings and quotes are measured or copied, not estimated. Where something is
unverified it says so.

**You need two terminals and one browser.** The browser is the only thing on
camera. Anything in a terminal is a cut point — stop recording, run it, start
again. Nothing in a terminal should ever be in shot.

## The cut

| Scene | Length | Content | Frame |
| --- | --- | --- | --- |
| 01-A | 0:14 | The hook: the agent working, no explanation | `01-A-cold-open.png` |
| 02-B | 0:16 | What it is: the verified Hookdeck n8n node | `02-B-node-panel.png` |
| 03-C1 | 0:12 | Setup: the Stripe ingestion workflow | `03-C1-ingestion-workflow.png` |
| 04-C2 | 0:14 | Setup: the Ingestion incident workflow | `04-C2-incident-workflow.png` |
| 05-D1 | 0:11 | Steady state: two connections, traffic flowing | `05-D1-steady-state.png` |
| 06-D2 | 0:16 | The break: Sync ack answers 5xx | `06-D2-failed-run.png` |
| 07-D3 | 0:10 | The issue, and the notification back | `07-D3-issue.png` |
| 08-D4 | 0:10 | The pause the agent applied | `08-D4-paused.png` |
| 09-E | 0:10 | End card | none, static |

Setup comes **before** the failure. Showing a break in a system the viewer has
not been introduced to was what stopped the earlier cut flowing.

About 113 seconds. One image per scene; the filenames in [stills/](stills/) are
the scene identifiers, so nothing has to be cross-referenced.

Narration is in [NARRATION.md](NARRATION.md) — **nothing quoted in this file is
spoken.** The quotes here are what appears on screen.

---

## Part 1 — before you record

### 1.1 Prerequisites, once

- `demo/.env` exists, from `demo/.env.example`, holding `HOOKDECK_DEMO_API_KEY`,
  `N8N_MCP_TOKEN` and `N8N_URL`.
- n8n Cloud has the **Anthropic account** credential and the **Hookdeck Event
  Gateway account** credential.
- Workflows **Stripe ingestion** and **Ingestion incident** exist and are the
  only workflows with those names. See 1.2.
- Hookdeck project `Demos -> n8n` is the one `HOOKDECK_DEMO_API_KEY` points at.

### 1.2 Clear the decks

`reset` refuses to run if two workflows share a name, because a failed import
leaves an empty duplicate and resetting *that* one looks exactly like the demo
quietly breaking. Delete any duplicates in n8n first.

The n8n workflow list should show exactly two, both Published: `Stripe
ingestion` and `Ingestion incident`. If a failed import has left duplicates,
clear them first — the row menu offers **Archive** rather than delete, and
`search_workflows` excludes archived workflows, so archiving is enough.

### 1.3 Pre-flight

```bash
node --env-file-if-exists=demo/.env demo/reset.mjs status
```

Read-only. Ends in `READY` or lists what is wrong and exits non-zero. It checks
the things that actually decide whether a take works: no open issue, no paused
connection, the issue trigger scoped to the current Stripe connection and not to
`"*"`.

It cannot check where `issue.opened` points, because Hookdeck's
`/notifications/webhooks` is PUT-only with no GET. `reset` rewrites it every
time, so the way to be sure is to run `reset`, not to read `status`.

`status` also refuses when two workflows share a name, rather than guessing
which is the real one.

### 1.4 Framing, learned by capturing every shot

**Set the theme to Light.** n8n → Settings → Personal → Personalisation → Theme →
Light theme, **then press Save** — the dropdown alone does nothing, which is easy
to miss. Light wins for this material: the tool subtitles (`get: issue`,
`getAll: event`, `pause: connection`) are mid-grey on near-black in dark mode and
disappear at embed size, and those three labels are the point of segment A.

**Press "fit to view" on every canvas before capturing.** Not just once. On the
`Stripe ingestion` execution the two nodes sit under the execution header, so
`Sep 8, 09:22:27 | Error in 321ms | ID#5` renders straight over them. Fit to view
moves them clear. It is the single most common way one of these frames comes out
looking broken.

**Use the Table view for the Hookdeck connection list**, not Structured. Table
has an explicit **Status** column showing `Paused` and `Active` as coloured
badges; Structured only shows a small amber icon that reads as nothing at video
size.

**Dismiss the Hookdeck changelog popover** bottom-left of the dashboard
("Delivery timeouts", with a View changelog button) before capturing.

**The agent's sub-nodes need 208px of horizontal spacing.** At the SDK's default
128px, the "List failed events" and "Pause connection" labels render on top of
each other as `List failed eventsPause connection`, in every canvas shot,
including the hero one. Positions are set explicitly in the workflow now; if you
ever rebuild it from the SDK, respace them or the defect comes back.

**Capture width follows the browser window, and the window is capped by the
display it is on.** Same page captured at 1372, 1506 and 1568px wide as the
window grew. To get a genuine 1920px-wide frame, move Chrome to the 2560x1440
external display first; the built-in panel will not reach it.

### 1.5 Screen hygiene

**The trial banner is in every frame.** A bar across the top reads
`14 days left  ·  N/1000 Executions` with a green **Upgrade Now** button top
right. It cannot be dismissed. Either crop it in the edit, or upgrade the
instance before recording. Decide before you set the capture region, not after.

The execution counter in it also increments visibly between takes, which will
not match across cuts.

Otherwise: separate browser profile, no bookmarks bar, no extensions, menu bar
hidden, 1920x1080 at 30 or 60fps.

**Always press "fit to view" before recording a canvas.** Nodes render partly
off-viewport on load — the first canvas I captured had the trigger node's label
cut off at the left edge.

---

## Part 2 — the capture sequence

**Per-scene detail lives in [NARRATION.md](NARRATION.md)**, which names the frame
against every spoken line. This section is only the order things have to happen
in, because that order is not obvious and two steps of it are irreversible.

### Capture before you break anything

```bash
node --env-file-if-exists=demo/.env demo/reset.mjs reset
node --env-file-if-exists=demo/.env demo/reset.mjs warmup
```

`reset` takes about 20 seconds and ends in `READY`. `warmup` fires six events
that **succeed**, so the connection list has real traffic on it.

Now capture, in any order:

| Scene | Where |
| --- | --- |
| 05-D1 | Hookdeck → Connections, **Table** view. Both `Active`, six events on `demo-stripe`. **This is the shot that cannot be retaken later.** |
| 02-B | n8n canvas → node panel → search `hookdeck` |
| 03-C1 | `Stripe ingestion` → Editor |
| 04-C2 | `Ingestion incident` → Editor |

### Then break it

```bash
node --env-file-if-exists=demo/.env demo/reset.mjs prime
```

`prime` fires six failing events concurrently. Concurrently matters: the issue
opens on the first failure and the agent counts about six seconds later, so
spacing them out means only one has reached `FAILED` when it looks — and the
agent then correctly refuses to pause over a single blip.

**Wait about 15 seconds**, then capture:

| Scene | Where |
| --- | --- |
| 01-A | `Ingestion incident` → Executions → newest, **Logs** open |
| 06-D2 | `Stripe ingestion` → Executions → newest, **Logs** open |
| 07-D3 | Hookdeck → Issues |
| 08-D4 | Hookdeck → Connections, **Table** view. `demo-stripe` now `Paused`. |

09-E has no frame; the deck draws the end card.

**Do not try to record the chain live.** It completes in 10–12 seconds and most
of that is a spinner. Let it finish and record the result.

### Between takes

`reset` again. It is the only way to get a second `issue.opened` — see Part 4.

## Part 3 — measured timings

Two runs, from a cleared project, with a `reset` between them. Seconds from the
event being fired.

| Beat | Run 1 | Run 2 |
| --- | --- | --- |
| Event accepted by Hookdeck (HTTP 200) | 0.43 | 0.38 |
| Ingestion delivery recorded FAILED, `response_status=500`, `attempts=1` | 4.41 | 4.30 |
| Delivery issue opened | 4.52 | 4.42 |
| Agent execution appears | 4.68 | 4.57 |
| Agent execution finishes | 11.29 | 10.15 |
| Stripe connection observed paused | 11.46 | 10.34 |

**Whole chain: 10-12 seconds.** Agent node alone: 2.4s and 2.3s. Whole agent
execution: 8.06s and 6.93s. Token use: 10,063 and 10,359.

The ~4s before the delivery is recorded is Hookdeck's own ingestion and
delivery, not n8n being slow.

The old README claimed 6-8 seconds. That was a local n8n behind `hookdeck
listen`, and the runs that produced it cleared the project by hand. 10-12s on
Cloud is the number to plan against.

---

## Part 4 — what is verified, and what is not

### 4.1 Verified by running it

- **Sync acknowledgement returns 5xx and opens an issue.** `response_status=500`
  on `attempts=1`. This is the load-bearing claim of the whole demo and it holds.
- **`Connection -> Pause` works when the agent calls it**, twice, and the pause
  is visible in Hookdeck within ~200ms of the agent finishing.
- **The issue trigger's default strategy is `first_attempt`**, so the issue opens
  about 100ms after the failed attempt rather than after a retry schedule. The
  brief guessed the value was called `first_attempt_failure`; it is not.
- **Dismissing an issue does not reset aggregation.** After setting an issue to
  `IGNORED`, a second failure on the same connection produced no new issue in 84
  seconds. Deleting and recreating the connection produced one in 1.2s.
- **`reset` is repeatable.** Run twice; the second run produced an issue and a
  full agent run where the previous script's approach would have produced
  nothing.
- **The node installs and runs on a Cloud trial.** All three node types resolve.
  The claim that trials cannot install community nodes is false.
- **Cloud needs no CLI.** The trigger provisioned an HTTP destination pointing at
  the public n8n webhook URL.
- **The agent tells a transient failure from a persistent one.** Told to pause
  only for the second, it refused to pause on a single failure and said so:
  *"only one event failing against this destination. This is a transient
  failure."* With six failures it paused and explained why: *"Five events have
  failed with the same response status, indicating the destination is down and
  not flaky."* This is why `prime` fires several events, and fires them
  concurrently.

### 4.2 The JSON exports are still UNVERIFIED

`demo/workflows/*.json` could not be verified by automation, and the reason
turned out not to be the files.

Uploading a workflow file through automated browser tooling produces a workflow
with the right **name** and **zero nodes**, silently. That happens for:

- the generated export in `demo/workflows/ingestion-incident.json`
- **n8n's own export of the same workflow, byte for byte**
- a hand-written file containing a single `manualTrigger` node

Three files with nothing in common behave identically, including one n8n
produced itself. So this is an artefact of driving the file input
programmatically - n8n reads the file, applies the name, and never applies the
nodes - and says nothing about whether the exports are correct.

Supporting evidence that the exports are fine: diffed against n8n's own export
of the same workflow, they are identical at node level, including node ids,
`webhookId`, positions, credentials by name, and all three `ai_tool`
connections. The only top-level difference was a `meta` block, which has since
been added.

**Still worth 30 seconds of your time before you rely on them.** Workflows ->
Import from File, pick `demo/workflows/ingestion-incident.json`, and check the
three actions are attached under the agent. A real file picker is the one path
that has not been tried, and these files are now linked from the video
description — so if the import is broken, that is where people will find out.

### 4.3 Workflows built in the UI are invisible to MCP

`get_workflow_details` and `archive_workflow` both refuse with *"Workflow is not
available in MCP. Enable MCP access from the workflow card in the workflows
list, or from the workflow settings."*

Only workflows created *through* MCP are reachable by default. If you build or
import anything in the UI and want me to touch it, enable MCP access on it
first. This is why the two junk workflows in 1.2 need deleting by hand.

### 4.4 Things worth changing in the node, not in the demo

Not changed — the brief says write them up rather than touch the package.

- **Provisioned destination names are machine noise.** `n8n-<workflowId>-<nodeId>`
  is unreadable, and it surfaces in the Hookdeck dashboard and in anything an
  agent says about the connection. The agent's first run put
  `n8n-lYWnz7ZrAjWTfp0w-7f71ba73-3829-4d6b-8a81-d4f11cdfdafa` in the middle of
  its incident note. Worked around in the prompt by telling the agent to name
  the connection by its source only. A friendlier default, or a name the user
  can set, would be better.
- **Destinations are still orphaned on unpublish** (issue #13). `reset` sweeps
  them; without that they accumulate one per publish cycle.

### 4.5 Decisions taken that you may want to overrule

- **Source type is `WEBHOOK`, not `STRIPE`.** A `STRIPE` source enforces
  signature verification, which would reject the unsigned JSON `prime` posts.
  Cost: no Stripe badge in the Hookdeck dashboard.
- **The failure is `mock.hookdeck.com?status=500`**, not `httpstat.us`.
  httpstat.us failed 2 of 3 probes with connection resets and a 502. Since an
  issue aggregates on `(webhook_id, error_code, response_status)`, a flaky
  failure silently changes which issue a failure joins.
- **The agent runs on your Anthropic key, not n8n gateway credits.** ~10k tokens
  of Haiku per run.
