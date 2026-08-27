# Example workflows

Import these from n8n: **Workflows → ⋯ → Import from File**. Each one asks you
to pick a Hookdeck Event Gateway credential on import, and the trigger needs a
source name before you can publish the workflow.

The first two were built and run against n8n 2.34.4 with the node installed. The
agent example was exported from a working workflow and run end to end three
times. What each section reports under *Observed* is what actually happened,
rather than what the workflow is meant to do.

`issue-opened-payload.json` is not a workflow. It is a captured `issue.opened`
body, kept as reference material for the agent example, whose prompt reads
fields out of it.

## process-each-event-once.json

**Problem.** A provider retries, or Hookdeck retries a delivery n8n was too slow
to accept, and the workflow runs twice on the same event. Doing the work twice
means a duplicate charge, a duplicate row, or a duplicate email.

**How it works.** `hookdeck.idempotencyKey` is stable across every retry of one
event. **Remove Duplicates** in "remove items seen in previous executions" mode
keeps a record of the keys it has let through, so the second arrival stops there.

```
Hookdeck Trigger → Only if not seen before → Process order
```

Observed: the same event delivered twice produced two executions. In the first,
one item reached `Process order`. In the second, `Only if not seen before`
emitted **0 items** and `Process order` did not run.

**Which key to dedupe on.** There are two duplicates you might mean, and they
need different keys. The workflow ships with the first.

| You want to catch | Dedupe on | Also required |
| --- | --- | --- |
| Retries of one event — Hookdeck redelivering after a timeout or a 5xx | `{{ $json.hookdeck.idempotencyKey }}` | nothing |
| A provider sending the same logical event twice, as two separate requests | `{{ $json.body.id }}` — the provider's own event id, `id` for Stripe | trigger **Options → Deduplication Window** set to `0` |

`idempotencyKey` is the Hookdeck event ID, so it identifies *one event and its
retries*. If the provider itself sends the same logical event as two separate
requests, those arrive as two Hookdeck events with two different keys and this
workflow lets both through. Keying on a payload field instead catches that.

The deduplication window is the part that is easy to miss. When it is set,
Hookdeck collapses a repeated request at the edge, so the second delivery never
reaches n8n and the **Remove Duplicates** node has nothing to catch — the
workflow looks like it is not working when in fact it is never being asked to.
Set the window to `0` and let n8n do the deduplicating, or leave the window in
place and accept that Hookdeck is already doing this job. Do not reason about
one without checking the other.

## catch-events-on-final-attempt.json

**Problem.** An event that fails every retry is simply gone, and nothing says so.

**How it works.** `hookdeck.isLastAttempt` is true only on the attempt after
which Hookdeck will not retry automatically. The IF routes those to a branch
where you alert, record, or park the payload.

```
                        ┌─ true  → Dead letter
Hookdeck Trigger → Final attempt?
                        └─ false → Process order
```

Observed: a normal delivery arrived with `isLastAttempt=false` and
`willRetryAfter=60`, and took the false branch. With **Retry Count** set to `0`
so the first attempt is also the last, the same event arrived with
`isLastAttempt=true` and took the true branch.

**Trying it.** Setting **Options → Retry Count** to `0` is the quickest way to
see the dead-letter branch fire without waiting out a full retry schedule.

![The workflow after a Stripe payment_intent.succeeded event arrived through
Hookdeck: the trigger and IF both succeeded, the false branch ran Process order,
and the output pane shows body, headers, query and hookdeck
columns](../docs/images/dead-letter-workflow.png)

Replace the `Dead letter` and `Process order` placeholders with whatever the
workflow should actually do — a Slack message and a database write, typically.

## ai-incident-agent.json

**Problem.** A destination starts failing. Hookdeck keeps retrying on schedule,
so attempts pile up against a system that is already broken, and nobody knows
until somebody happens to look at the dashboard.

**How it works.** Hookdeck opens a *delivery issue* when an attempt fails, and a
project webhook notification posts `issue.opened` to a source this workflow's
trigger owns. So the workflow is started by Hookdeck telling you it could not
deliver something — nobody triggers it.

The prompt lifts the issue, connection, destination and event ids out of that
payload and hands them to an AI Agent with three Hookdeck tool nodes. The agent
confirms the issue is still `OPENED`, looks up how many events are currently
failing on that destination — the one fact the payload does not contain — pauses
the connection, and writes a short incident note. Pausing holds queued events
rather than dropping them, so it is safe and reversible
(`hookdeck gateway connection unpause <id>`).

```
Hookdeck Trigger (issue.opened) → On-call agent → Notify on-call
                                        ↑
              Claude Haiku 4.5 ─────────┤  ai_languageModel
              Get issue ────────────────┤  ai_tool  Issue → Get
              List failed events ───────┤  ai_tool  Event → Get Many
              Pause connection ─────────┘  ai_tool  Connection → Pause
```

**Why three tool nodes rather than one.** On the action node, `resource` and
`operation` are `noDataExpression: true`. They cannot hold an expression, so the
agent cannot choose them: one tool node is one operation, fixed when you build
the workflow. What the model does fill in is everything else — `id` and
`filters` carry `$fromAI()` expressions, so the agent supplies the issue id, the
destination id and the connection id from what it read in the prompt and in
earlier tool results. Wiring one Hookdeck node and hoping the agent will pick the
operation does not work; give it one node per operation you are willing to let
it perform, which also makes the agent's permissions legible from the canvas.

**Why the failing workflow upstream has to be on Sync.** This example only ever
runs because something else failed in a way Hookdeck noticed, and that is a
property of the *other* workflow's acknowledgement mode:

- **Sync** holds the HTTP response open until the run finishes, so the run's
  outcome is the delivery's outcome. A failed run answers 5xx, the attempt
  fails, Hookdeck's retry rules apply to the run itself, and a delivery issue
  opens. That issue is what fires this workflow.
- **Async Retry** acknowledges the moment Hookdeck hands the event over, before
  the workflow has done anything. A downstream failure never bounces back, no
  attempt fails, and no issue is raised — so this agent never runs at all. In
  return the workflow can take as long as it likes without a delivery timing
  out, and recovering a failed run becomes your problem rather than Hookdeck's.

That is the trade-off: Sync gives you Hookdeck's retries and its issue tracking
over your workflow's own success or failure, and caps how long the workflow may
take. Async Retry gives you unlimited runtime and no safety net. This example's
own trigger is deliberately on **Async Retry** — it must acknowledge whatever
happens, because a failure while handling an incident notification would be an
incident notification about the incident notification.

**Before you run it.** More setup than the other two, because most of it is on
the Hookdeck side rather than in n8n:

- An **Anthropic** credential for the model node, as well as the Hookdeck one.
- A **delivery issue trigger** in the Hookdeck project, so a failed attempt
  opens an issue at all.
- A **project webhook notification** for `issue.opened`, pointed at this
  workflow's source. This is project-level (`PUT /notifications/webhooks`) and
  not a channel on the issue trigger — adding `channels.webhook` to an issue
  trigger returns HTTP 200 and silently discards it.
- The issue trigger scoped so it does **not** watch this workflow's own
  connection. Otherwise a failure here opens an issue, which notifies this
  workflow, which is a loop.

[`demo-setup/`](../demo-setup/) has a script that does all of that, and explains
what it deletes.

Observed, over three consecutive runs from a cleared project: the upstream Sync
failure returned 500, the delivery issue opened about a second later with
`strategy: first_attempt` and no retry wait, and the agent execution appeared on
its own **6–8 seconds** after the failure, having called all three tools in
order. `Pause connection` returned the connection object with `paused_at` set,
and the Hookdeck dashboard showed the connection as paused. The agent's final
output from the third run, with the resource names of the project it ran in:

> INCIDENT REPORT
>
> Connection demo-stripe -> n8n-DL859bpejHkuWYaQ-b1000000-... is failing. 1 event
> currently affected with response status 500. Connection paused; queued events
> are held and not lost. Check n8n destination logs for the "Error in workflow"
> message and fix the workflow before resuming.

Every one of those runs had exactly one failing event at the moment the agent
looked. What it says when retries have already landed and it sees two or three
has not been tested; the wording will differ, and it should still pause, because
the prompt's rule is "the destination is returning 5xx" rather than a threshold
on the count. An earlier version of the prompt did threshold on the count, and
produced `paused` and `not paused` from identical input, because the issue opens
on the *first* failure and the blast radius the agent sees is a race.

Two things about the model node are load-bearing if you edit it. The `model`
parameter is a resource locator (`{"__rl": true, "mode": "list", "value":
"claude-haiku-4-5-20251001"}`) — a plain string fails at runtime with
`Could not get parameter "model.value"`. And `temperature` is `0`, because the
point of the example is that the same incident produces the same actions.

`Notify on-call` is a placeholder. Replace it with the Slack, PagerDuty or email
node you would actually want; the agent's incident note is on its output.
