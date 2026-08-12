# Example workflows

Import these from n8n: **Workflows → ⋯ → Import from File**. Each one asks you
to pick a Hookdeck Event Gateway credential on import, and the trigger needs a
source name before it will activate.

Both were built and run against n8n 2.34.4 with the node installed, and the
behaviour described below is what was actually observed rather than what the
workflows are meant to do.

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

**Note on what this does and does not cover.** `idempotencyKey` is the Hookdeck
event ID, so it identifies *one event and its retries*. If the provider itself
sends the same logical event as two separate requests, those are two events with
two keys. Key the node on a payload field instead — `{{ $json.body.id }}` for
Stripe — when that is the duplicate you care about.

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

Replace the `Dead letter` and `Process order` placeholders with whatever the
workflow should actually do — a Slack message and a database write, typically.
