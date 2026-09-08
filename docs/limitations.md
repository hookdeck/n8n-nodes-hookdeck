# Limitations

Known boundaries, stated so nobody discovers them in production.

- **Self-hosted n8n only, for now.** n8n Cloud installs only verified community
  nodes and this package's verification submission is pending.

- **Sync acknowledgement is capped at 60 seconds.** Hookdeck stops waiting after
  that, so a workflow that takes longer must use Async Retry, and with it takes
  on recovery itself — see below.

- **The CLI route holds nothing for a listener that does not exist.** When
  Hookdeck cannot reach n8n directly, events go through `hookdeck listen`. A
  dropped listener is covered by the retry rule, but a connection with *no* CLI
  session records no event at all: nothing queued, nothing failed, nothing to
  retry. Delivery Rate Limit and Delivery Group are also unavailable on that
  route. [Transport](transport.md#what-the-cli-route-cannot-do) has the
  measurements.

- **n8n 1.x is unverified.** The package targets `n8nNodesApiVersion: 1`, which
  1.x supports, but only 2.x has been tested.

## Departures from the shared reliability contract

This node follows a reliability contract shared with the Hookdeck plugins for
other hosts. Three parts of it work differently here, because n8n requires it:

- **No local deduplication ledger.** The shared contract deduplicates on
  "admit when the attempt number exceeds the highest recorded for this event
  ID". A trigger node is invoked before the workflow runs and has no completion
  hook, so it cannot record whether a run succeeded. Deduplication is therefore
  delegated to Hookdeck's own **Deduplication Window** rule, which collapses
  repeat events at ingest. Workflows needing stricter guarantees should key on
  `hookdeck.idempotencyKey` themselves — the
  [process-each-event-once example](../examples/README.md#process-each-event-oncejson)
  does exactly that.
- **Async Retry does not re-enqueue failed runs by itself.** For the same
  reason — no completion hook — the trigger cannot call
  `POST /events/{id}/retry` when a run fails. The capability is exposed instead,
  as a workflow step: see
  [Retrying a failed run under Async Retry](trigger.md#retrying-a-failed-run-under-async-retry).
  Sync mode needs none of this, because a failed run answers 5xx and Hookdeck's
  retry rules apply directly.
- **No host-side admission control.** The contract answers `503` with
  `Retry-After` when a concurrency cap is reached. n8n governs its own execution
  concurrency, so the equivalent lever here is the **Delivery Rate Limit**
  option, which caps delivery inside Hookdeck before n8n is reached — on a
  directly reachable n8n. Instances receiving events through the Hookdeck CLI
  have no equivalent, because a CLI destination does not support rate limiting.

Destination authentication also uses `CUSTOM_SIGNATURE` rather than
`HOOKDECK_SIGNATURE` — [Security](security.md#signature-verification-on-delivery)
explains why.
