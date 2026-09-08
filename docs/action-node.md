# Hookdeck Event Gateway node

The action node: manages sources, destinations and connections, and inspects
events, delivery attempts, requests and issues. Every operation is also
usable as an AI agent tool — the
[incident agent example](../examples/README.md#ai-incident-agentjson) wires
three of them up that way.

| Resource | Operations |
| --- | --- |
| Attempt | Get, Get Many |
| Connection | Get, Get Many, Get Count, Delete, Pause, Unpause |
| Destination | Get, Get Many, Get Count |
| Event | Get, Get Many, Get Count, Retry, Mute, Cancel |
| Issue | Get, Get Many, Get Count, Update, Dismiss |
| Request | Get, Get Many, Retry |
| Source | Get or Create, Get, Get Many, Get Count, Get URL |

## Source → Get or Create

Returns the named source, creating it only if it is not there, and gives back
its public URL. Source names are unique within a project, so a plain create is
not safe to re-run — `POST /sources` answers `409` the second time. An upsert
would be, but `PUT /sources` rewrites an existing source's type and
verification, which is the damage the trigger was changed to stop doing.
Getting first avoids both.

It asks the same questions the trigger does — Source Type, Verification, and the
labelled secret fields for HMAC, API key, basic auth and platform schemes — so
a verified Stripe source can be created without hand-writing its config.
Source Config (JSON) is still there for schemes the fields cannot express, and
still wins where they overlap.

## Get Many

Supports **Return All**, which walks Hookdeck's pagination, or a **Limit**.

## Get Count

Answers "how many" without listing them, and takes the same filters.
Connections, destinations, issues and sources are counted exactly and return
`isAtLeast: false`. Events are different — Hookdeck exposes no event count — so
they are counted by paging to a ceiling and returning `isAtLeast: true` when
that ceiling is reached, alongside `countedUpTo`. Treat that as a floor, not a
total. This matters most when the node is used as an AI agent tool: a page size
reported as a count is a number the agent will state as fact.

## Event → Retry versus Request → Retry

**Event → Retry** redelivers an existing event to its connection; the retry
arrives at the workflow with `hookdeck.attemptTrigger` set to `MANUAL` and the
same `idempotencyKey`. **Request → Retry** replays the original inbound request
through the source, which creates a *new* event with a new ID. Use the first to
recover a failed run (see
[Retrying a failed run under Async Retry](trigger.md#retrying-a-failed-run-under-async-retry)),
and the second when you want the request re-evaluated from ingest.

## As an AI agent tool

On this node, `resource` and `operation` cannot hold an expression, so an agent
cannot choose them: one tool node is one operation, fixed when you build the
workflow. Everything else — `id`, `filters` — can carry `$fromAI()` expressions.
Give the agent one node per operation you are willing to let it perform, which
also makes its permissions legible from the canvas.
