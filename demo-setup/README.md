# n8n demo setup — build report

For the Creator Portal verification video, steps 4 and 5 (functionality + AI tool use).
Package under review: `@hookdeck/n8n-nodes-hookdeck@0.2.0`. Nothing in the package was
changed.

**Status: working, run three consecutive times from a cleared project with identical
outcomes.** Full chain, event to agent notification: **6–8 seconds**.

---

## 1. Files

| File | What it is |
| --- | --- |
| `flow1-stripe-ingestion.json` | Flow 1. Trigger on `demo-stripe`, **Sync** ack, IF on event type, deliberate failure branch. 4 nodes. |
| `flow2-ingestion-incident.json` | Flow 2. Trigger on `demo-issues`, AI Agent, 3 Hookdeck tool nodes, Claude Haiku 4.5. 7 nodes. |
| `reset-demo.sh` | Empty project → ready to record. Run before every take. |
| `run-demo.sh` | Fires the chain and prints a timing table. For rehearsal, not for the take. |
| `issue-opened-payload.json` | A real captured `issue.opened` body (Q2). |

Both JSONs were exported from the live, working workflows — not hand-written — and
re-imported into a fresh workflow to confirm the round trip.

## 2. The six questions

### Q1 — Tool node type string, and does it survive export/import?

**`@hookdeck/n8n-nodes-hookdeck.hookdeckEventGatewayTool`**, `typeVersion: 1`.

Round trip verified: exported Flow 2, re-imported as a new workflow, read it back. All
three tool nodes and all four `ai_*` links intact:

```
Claude Haiku 4.5   -- ai_languageModel -> On-call agent
Get issue          -- ai_tool          -> On-call agent
List failed events -- ai_tool          -> On-call agent
Pause connection   -- ai_tool          -> On-call agent
```

**Design consequence worth knowing:** `resource` and `operation` are both
`noDataExpression: true`, so the agent **cannot** choose them. One tool node = one
operation. Parameters (`id`, `filters`) are filled by the model via `$fromAI()`. This is
why there are three tool nodes rather than one — and it looks better on camera for it.

### Q2 — The `issue.opened` payload

Captured in full in `issue-opened-payload.json`. It is **much richer than expected** —
roughly 200 lines. Fields the agent prompt uses:

| Field | Use |
| --- | --- |
| `body.issue.id` | Issue → Get |
| `body.issue.aggregation_keys.webhook_id[0]` | the **connection** id, for Pause |
| `body.issue.data.trigger_event.destination_id` | filtering events |
| `body.issue.data.trigger_attempt.response_status` | `500` |
| `body.trigger_webhook.full_name` | `demo-stripe -> n8n-...` |
| `body.issue.reference.event_id` / `attempt_id` | the failing event and attempt |

**This changes the tool design.** The payload already embeds the full failing event *and*
the failing attempt, so `Attempt → Get Many` — one of the four operations suggested — is
entirely redundant. I dropped it. `Issue → Get` is partly redundant too but earns its place
by confirming the issue is still `OPENED` at the time the agent looks, and it is a good
first beat on camera. The genuinely necessary lookup is **`Event → Get Many`**: the blast
radius is not in the payload.

### Q3 — Does a Sync-mode failure open a delivery issue, and how fast?

**Yes, in about one second.** Measured repeatedly.

Sync is doing exactly what the brief says. Flow 1's `Stop and Error` makes the run fail,
Sync returns 5xx to Hookdeck, the attempt fails, and `strategy: first_attempt` opens the
issue immediately with no retry wait. The issue carries `response_status: [500]`.

For contrast, an earlier probe against `https://httpstat.us/500` produced
`error_code: CONNECTION_RESET` with `response_status: []`. The n8n Sync failure gives the
cleaner signal, which is what the agent reads.

### Q4 — Can the issue trigger be scoped to one connection?

**Yes.** The delivery issue trigger takes an explicit array:

```json
{ "configs": { "strategy": "first_attempt", "connections": ["web_XlUl3b7U47Y6"] } }
```

`reset-demo.sh` sets this to Flow 1's connection on every reset, so source B's own delivery
into n8n cannot raise an issue and the runaway loop is structurally impossible rather than
merely unlikely.

Flow 2's trigger is also on **Async Retry**, so even if it did fail it would already have
acknowledged and would not fail the attempt. Two independent guards.

### Q5 — Does Connection → Pause work when the agent calls it?

**Yes.** It returns the full connection object with `paused_at` set:

```json
{ "id": "web_x5lt3BfLNO8X", "paused_at": "2026-08-21T20:11:03.163Z",
  "name": "n8n-DL859bpejHkuWYaQ-...", "rules": [...] }
```

Verified in all three final runs. Pausing holds queued events rather than dropping them, so
it is safe to demo and trivially reversible (`hookdeck gateway connection unpause <id>`).

### Q6 — Wall clock

| Segment | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Happy path: ingest → Flow 1 `success` | 2s | 1s | 2s |
| Failure → Flow 1 `error` (Sync 5xx) | 1s | 1s | 1s |
| **Failure → agent finished, connection paused** | **6s** | **8s** | **8s** |

Comfortably inside a five-minute take. The agent is the only variable part and it stayed in
a 6–8s band across three runs with three tool calls each.

## 3. Setup procedure

Before every take:

```bash
./reset-demo.sh          # ~30s, ends with "READY" and the source URL
```

It stops any listener, deactivates both workflows, clears connections and destinations,
dismisses open issues, re-asserts the notification config, reactivates both workflows,
starts `hookdeck listen 5678 '*'`, and scopes the issue trigger to the new connection.

It **aborts** if the CLI did not attach to both connections, because an unattached CLI
means events are not recorded at all — nothing queued, nothing failed, nothing to retry.

**Why the reset must recreate the connection:** Hookdeck aggregates issues by
`(webhook_id, error_code, response_status)`. Once an issue exists for a connection, later
failures **join** it and no `issue.opened` fires. **Dismissing the issue does not reset
this** — I verified that directly: after dismissing, three further failures produced no new
issue. A new connection id is the only reliable reset, which is why the script deletes the
connection and lets activation re-provision it.

To rehearse the chain without recording:

```bash
./run-demo.sh "rehearsal"
```

## 4. What is on screen

**Flow 1 — ingestion (happy path).** Send `payment_intent.succeeded`. n8n executions list
shows a new `success`. Open it: trigger → `Event we can handle?` → **Fulfil order**. The
trigger's output pane shows the `hookdeck` metadata object — event id, attempt count,
`isLastAttempt` — which is the node's distinguishing feature and worth pausing on.

**Flow 1 — the failure.** Send `payment_intent.payment_failed`. New execution, **error**,
stopping at `Fulfilment unavailable`. In the Hookdeck dashboard the attempt is failed with
**500**, and a delivery issue opens within about a second.

**Flow 2 — the agent.** A new execution appears on its own, roughly 6–8s after the failure.
This is the beat: nobody triggered it.

Open the execution. The **On-call agent** node's output pane has a tool-call trace listing
`Get issue`, `List failed events`, `Pause connection` in order, each expandable to show the
JSON the tool returned. The `Pause connection` result showing `paused_at` filled in is the
single most legible frame in the demo — it is the agent changing infrastructure state.

The agent's final output, verbatim from run 3:

> INCIDENT REPORT
>
> Connection demo-stripe -> n8n-DL859bpejHkuWYaQ-b1000000-0000-4000-8000-000000000001 is
> failing. 1 event currently affected with response status 500. Connection paused; queued
> events are held and not lost. Check n8n destination logs for the "Error in workflow"
> message and fix the workflow before resuming.

**The before/after contrast.** Hookdeck dashboard, connection list: before the incident the
connection is active; after, it shows **Paused**. Two states of the same row. Stronger than
any n8n panel, because it is the external system that changed.

Note the executions list shows Flow 2 as green `success` — the agent succeeded at its job.
Flow 1 is red `error`, which is the point. Do not let that read as a broken demo.

## 5. What did not work, and what I could not verify

**Wrong in the brief: there is no `webhook` notification channel on an issue trigger.**
`IssueTriggerChannels` supports exactly `slack`, `microsoft_teams`, `discord`,
`betteruptime`, `incidentio`, `pagerduty`, `opsgenie`, `email`, and is
`additionalProperties: false`. Adding `channels.webhook` returns **HTTP 200 and silently
discards it** — worth reporting to the API team on its own. Webhook notifications are
project-level and separate:

```
PUT /notifications/webhooks  { "enabled": true, "topics": ["issue.opened"], "source_id": "src_..." }
```

So scoping (Q4) is on the issue trigger, delivery is on the project. Two different places.

**A racy design I introduced and removed.** My first agent prompt said "pause only if more
than one event is failing." The issue opens on the *first* failure, so the agent usually saw
a blast radius of 1 and correctly declined to pause — non-deterministically, because
sometimes retries had landed by the time it looked. Runs came out `paused: True` and
`paused: False` from identical input. I tried pre-seeding failures to inflate the count;
that made it worse (seeded events landed on a different destination). The fix was to delete
my invented rule: pause whenever the destination returns 5xx, because retries will pile up
regardless. Deterministic across three runs. **The chain was never the problem — my decision
rule was.**

**Not verified: Slack.** No Slack credential exists, so the agent's final output *is* the
notification. Adding a Slack node afterwards is a small change but it is untested here.

**Not verified: a real Stripe event.** All events were hand-rolled JSON posted to the source
URL. The Stripe CLI key on this machine has expired (`stripe login` needed), and sources are
deliberately generic with `verified: false`, per the brief. If the video is to show
`stripe trigger`, that path is untested and the signing-secret question is live: once
verification is on, a mismatched secret is rejected at the edge and nothing reaches n8n.

**Not verified: n8n Cloud.** Everything here is local with CLI destinations.

**Two workarounds you should know are load-bearing:**

- The `lmChatAnthropic` `model` parameter must be a resourceLocator
  (`{__rl, mode:"list", value:"claude-haiku-4-5-20251001"}`), not a string. A plain string
  fails at runtime with `Could not get parameter "model.value"`.
- Deactivate/reactivate cycles orphan connections and never delete destinations
  (issues #13). The reset script sweeps both, otherwise the project accrues clutter that
  will be visible on camera.

**One residual uncertainty.** Every run so far has had exactly one failing event at the
moment the agent looks. I have not tested what the agent says when a retry has already
landed and it sees 2 or 3 — the wording will differ ("3 events affected"). It should still
pause, since the rule no longer depends on the count, but I have not proven it. If a take
runs long between the failure and the agent, expect the number in the incident note to vary.
