# Hookdeck Event Gateway Trigger reference

Every parameter and option on the trigger, what the workflow receives, and what
happens on publish, unpublish and a test run. Setting it up for the first time
is covered in [Getting started](getting-started.md).

## Parameters

| Parameter | Description |
| --- | --- |
| Source | The Hookdeck source. **From List** shows every source in the project with its public URL, so you can copy the URL for your provider without leaving the canvas. **By Name** takes a new name — letters, numbers, hyphens and underscores — and creates the source on publish. |
| Source Type | The platform sending events. This selects *which* signature scheme Hookdeck applies; it does not switch verification on by itself — see [Security](security.md#verification-only-starts-when-a-secret-is-set). Use **Webhook (Generic)** to configure verification yourself. Applies when the node creates the source; an existing source keeps its own type. |
| Verification | For generic sources: HMAC, API Key, Basic Auth, or none. |
| Webhook Secret | For platform sources: the signing secret the platform issued you. Placed in whichever field that platform expects. A few platforms need more than one value — those ask you to use Source Config (JSON) instead, and name the fields. |
| Acknowledgement Mode | **Async Retry** (default) or **Sync**. See [Acknowledgement modes](#acknowledgement-modes). |

## Options

| Option | Description |
| --- | --- |
| Retry Strategy / Count / Interval | How Hookdeck retries a delivery this workflow did not accept. Up to 50 attempts. Server errors and `429` are always retryable. Defaults to 5 exponential retries a minute apart, applied even if you never open Options. |
| Deduplication Window | Discard repeat events seen within the window, so a double-firing provider costs one execution. Defaults to 60000 ms; set 0 to turn it off. |
| Delivery Rate Limit / Period | Cap how fast Hookdeck delivers into this workflow. Supports `concurrent` to cap simultaneous executions. |
| Delivery Group Key / Rate Limit / Period | Group deliveries by a payload path, so each customer or repository gets its own rate limit and one busy sender cannot crowd out the rest. Delivery groups are an early access Hookdeck feature; on a project without the entitlement, publish fails with a `422`. |
| On Deactivate | Pause the connection (default) or delete it. See [Unpublishing without losing events](#unpublishing-without-losing-events). |
| Header Prefix | Prefix of Hookdeck's metadata headers. Change only for a white-labelled project. |
| Update Existing Source | Apply this node's Source Type and Verification to a source that already exists. Off by default — see [Getting started](getting-started.md#an-existing-source-is-adopted-not-rewritten). |
| Verify Signature | Reject deliveries that are not signed by Hookdeck. On by default. |
| Source Config (JSON) | Advanced. Merged into the source config, for verification schemes the fields above cannot express. |

Delivery Rate Limit and Delivery Group apply only when Hookdeck delivers to n8n
directly. On the CLI route the node does not send them and says so in the log —
see [Transport](transport.md#what-the-cli-route-cannot-do).

## Acknowledgement modes

| Mode | Behaviour |
| --- | --- |
| **Async Retry** (default) | Acknowledge as soon as the event is received, then run the workflow. The sender never waits. A run that fails afterwards is not retried by Hookdeck, because the delivery already succeeded. |
| **Sync** | Hold the HTTP response until the workflow finishes. Success answers 2xx; a failed run answers 5xx, so Hookdeck's retry rules apply to the *run*, not just the delivery. |

Hookdeck stops waiting after 60 seconds, so Sync suits workflows that finish
well inside that. Longer workflows should use Async Retry.

### Retrying a failed run under Async Retry

In Async Retry mode the delivery has already succeeded by the time the workflow
runs, so Hookdeck will not retry it on your behalf. Hookdeck does allow a
successful event to be retried manually, which makes the recovery path a step
you add to the workflow rather than something the trigger can do for you:

1. Set an **Error Workflow** on the workflow (Settings → Error Workflow), or add
   an error output branch.
2. In it, add the **Hookdeck Event Gateway** node with **Event → Retry**.
3. Set the Event ID to the failing execution's event:
   `{{ $json.hookdeck.eventId }}`.

Hookdeck then redelivers the event and the workflow runs again, with
`hookdeck.attemptTrigger` set to `MANUAL`. Guard against loops by checking
`hookdeck.attemptCount` before retrying.

Prefer **Sync** where the workflow is fast enough: it gets the same behaviour
from Hookdeck's own retry rules with nothing extra to build.

## Unpublishing without losing events

Deleting a Hookdeck connection cancels every event still queued for it, and that
cannot be undone. So unpublishing the workflow **pauses** the connection by
default: inbound events are held durably, and publishing again unpauses it and
delivers everything that arrived meanwhile. That makes a deploy or a
maintenance window lossless.

Choose **Delete the Connection** under Options if you would rather the
connection be removed — accepting that queued events go with it.

## Output

Each execution receives one item:

```json
{
  "body":    { "...": "the payload the provider sent" },
  "headers": { "...": "all request headers" },
  "query":   { "...": "query string parameters" },
  "hookdeck": {
    "eventId": "evt_...",
    "requestId": "req_...",
    "attemptCount": 1,
    "attemptTrigger": "INITIAL",
    "willRetryAfter": "60",
    "isLastAttempt": false,
    "sourceName": "stripe-production",
    "connectionName": "n8n-my-workflow",
    "destinationName": "n8n-my-workflow",
    "verified": "true",
    "originalIp": "203.0.113.10",
    "eventUrl": "https://dashboard.hookdeck.com/events/evt_...",
    "idempotencyKey": "evt_..."
  }
}
```

Every field under `hookdeck` except `isLastAttempt` is read from a delivery
header and is absent if Hookdeck did not send it, so treat them as optional.
`verified` is a string, not a boolean — it reports whether Hookdeck verified the
*provider's* signature at ingest, which is separate from the Hookdeck-to-n8n
signature the trigger checks itself.

`hookdeck.isLastAttempt` is `true` when Hookdeck will not retry the event again
automatically — the natural condition for a dead-letter branch.
`hookdeck.idempotencyKey` is stable across retries of the same event, so it is a
sound deduplication key. Note that a *replay* creates a new event with a new ID;
use `hookdeck.requestId` if you need to recognise replayed traffic.

## Activation, deactivation and test runs

- Publishing the workflow creates the connection. Unpublishing it pauses or
  deletes the connection depending on **On Deactivate**; the source and
  destination are left in place either way, because a source may be shared with
  other connections.
- **Listen for test event** provisions a *separate* connection against n8n's test
  URL, tracked independently, so a test run never disturbs the production
  connection. How that connection is cleaned up differs between the direct and
  CLI routes — see [Transport](transport.md#test-runs-on-each-route).
- Both connections share one source, so they share one source URL — there is no
  second URL to configure for testing. The flip side is that while you are
  listening for a test event **on a workflow that is also published**, each
  incoming event is delivered twice: once to the published workflow and once to
  the test listener.
- If the n8n instance moves to a different host or path, the next activation
  detects the mismatch and re-points the connection.
