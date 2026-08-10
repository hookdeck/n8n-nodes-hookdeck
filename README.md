# @hookdeck/n8n-nodes-hookdeck

An n8n community node for [Hookdeck](https://hookdeck.com), an event gateway for
receiving, queueing and delivering webhooks and other asynchronous messages.

This package adds two nodes:

- **Hookdeck Trigger** — starts a workflow when Hookdeck delivers an event, and
  sets up the Hookdeck connection that delivers it.
- **Hookdeck** — manages sources, destinations and connections, and inspects
  events, delivery attempts, requests and issues.

[n8n](https://n8n.io) is a [fair-code licensed](https://docs.n8n.io/reference/license/)
workflow automation platform.

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and use the package name `@hookdeck/n8n-nodes-hookdeck`.

## Credentials

The nodes authenticate with a Hookdeck project API key.

1. Open [Hookdeck](https://dashboard.hookdeck.com) and select your project.
2. Go to **Project Settings → Secrets** and copy the API key.
3. In n8n, create a new **Hookdeck API** credential and paste the key.

The key is scoped to a single Hookdeck project. Everything the nodes create or
read belongs to that project.

## Hookdeck Trigger

Set a source name, pick the platform sending the events, and activate the
workflow. On activation the node creates a Hookdeck connection whose destination
is this workflow's webhook URL, then reports the public source URL to give your
provider.

Events arrive through Hookdeck rather than directly, so Hookdeck's connection
rules apply to them — retries, delivery rate limits and deduplication are
configured on the node under **Options**.

> **Naming an existing source rewrites it.** Provisioning is an upsert keyed on
> the source name, so if a source of that name already exists, this node's
> Source Type and Verification settings are applied to it — replacing whatever
> was there and affecting every other connection fed by that source. Use a name
> specific to this workflow unless you deliberately want to share a source.

### Parameters

| Parameter | Description |
| --- | --- |
| Source | The Hookdeck source. **From List** shows every source in the project with its public URL, so you can copy the URL for your provider without leaving the canvas. **By Name** takes a new name — letters, numbers, hyphens and underscores — and creates the source on publish. |
| Source Type | The platform sending events. Selecting a platform applies its signature verification scheme. Use **Webhook (Generic)** to configure verification yourself. |
| Verification | For generic sources: HMAC, API Key, Basic Auth, or none. |
| Webhook Secret | For platform sources: the signing secret the platform issued you. |

### Options

| Option | Description |
| --- | --- |
| Retry Strategy / Count / Interval | How Hookdeck retries a delivery this workflow did not accept. Up to 50 attempts. Server errors and `429` are always retryable. Defaults to 5 exponential retries a minute apart, applied even if you never open Options. |
| Deduplication Window | Discard repeat events seen within the window, so a double-firing provider costs one execution. Defaults to 60000 ms; set 0 to turn it off. |
| Delivery Rate Limit / Period | Cap how fast Hookdeck delivers into this workflow. Supports `concurrent` to cap simultaneous executions. |
| Delivery Group Key / Rate Limit / Period | Group deliveries by a payload path, so each customer or repository gets its own rate limit and one busy sender cannot crowd out the rest. |
| On Deactivate | Pause the connection (default) or delete it. See below. |
| Header Prefix | Prefix of Hookdeck's metadata headers. Change only for a white-labelled project. |
| Verify Signature | Reject deliveries that are not signed by Hookdeck. On by default. |
| Source Config (JSON) | Advanced. Merged into the source config, for verification schemes the fields above cannot express. |

### Acknowledgement modes

| Mode | Behaviour |
| --- | --- |
| **Async Retry** (default) | Acknowledge as soon as the event is received, then run the workflow. The sender never waits. A run that fails afterwards is not retried by Hookdeck, because the delivery already succeeded. |
| **Sync** | Hold the HTTP response until the workflow finishes. Success answers 2xx; a failed run answers 5xx, so Hookdeck's retry rules apply to the *run*, not just the delivery. |

Hookdeck stops waiting after 60 seconds, so Sync suits workflows that finish
well inside that. Longer workflows should use Async Retry.

#### Retrying a failed run under Async Retry

In Async Retry mode the delivery has already succeeded by the time the workflow
runs, so Hookdeck will not retry it on your behalf. Hookdeck does allow a
successful event to be retried manually, which makes the recovery path a step
you add to the workflow rather than something the trigger can do for you:

1. Set an **Error Workflow** on the workflow (Settings → Error Workflow), or add
   an error output branch.
2. In it, add the **Hookdeck** node with **Event → Retry**.
3. Set the Event ID to the failing execution's event:
   `{{ $json.hookdeck.eventId }}`.

Hookdeck then redelivers the event and the workflow runs again, with
`hookdeck.attemptTrigger` set to `MANUAL`. Guard against loops by checking
`hookdeck.attemptCount` before retrying.

Prefer **Sync** where the workflow is fast enough: it gets the same behaviour
from Hookdeck's own retry rules with nothing extra to build.

### Deactivating without losing events

Deleting a Hookdeck connection cancels every event still queued for it, and that
cannot be undone. So deactivating the workflow **pauses** the connection by
default: inbound events are held durably, and reactivating the workflow unpauses
it and delivers everything that arrived meanwhile. That makes a deploy or a
maintenance window lossless.

Choose **Delete the Connection** under Options if you would rather the
connection be removed — accepting that queued events go with it.

### Output

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
    "idempotencyKey": "evt_..."
  }
}
```

`hookdeck.isLastAttempt` is `true` when Hookdeck will not retry the event again
automatically — the natural condition for a dead-letter branch.
`hookdeck.idempotencyKey` is stable across retries of the same event, so it is a
sound deduplication key. Note that a *replay* creates a new event with a new ID;
use `hookdeck.requestId` if you need to recognise replayed traffic.

### Limitations

This node follows a reliability contract shared with the Hookdeck plugins for
other hosts. Two parts of it work differently here, because n8n requires it:

- **No local deduplication ledger.** The shared contract deduplicates on
  "admit when the attempt number exceeds the highest recorded for this event
  ID". A trigger node is invoked before the workflow runs and has no completion
  hook, so it cannot record whether a run succeeded. Deduplication is therefore
  delegated to Hookdeck's own **Deduplication Window** rule, which collapses
  repeat events at ingest. Workflows needing stricter guarantees should key on
  `hookdeck.idempotencyKey` themselves.
- **Async Retry does not re-enqueue failed runs by itself.** For the same
  reason — no completion hook — the trigger cannot call
  `POST /events/{id}/retry` when a run fails. The capability is exposed instead,
  as a workflow step: see *Retrying a failed run under Async Retry* above. Sync
  mode needs none of this, because a failed run answers 5xx and Hookdeck's retry
  rules apply directly.
- **No host-side admission control.** The contract answers `503` with
  `Retry-After` when a concurrency cap is reached. n8n governs its own execution
  concurrency, so the equivalent lever here is the **Delivery Rate Limit**
  option, which caps delivery inside Hookdeck before n8n is reached.

Destination authentication also uses `CUSTOM_SIGNATURE` rather than
`HOOKDECK_SIGNATURE`. Hookdeck's project signing secret is not exposed through
the API, so `HOOKDECK_SIGNATURE` would force you to copy a second secret by
hand. This node generates its own signing secret at provisioning time instead;
the algorithm is identical (HMAC-SHA256 over the raw body, base64).

### Finding the source URL

This is the address you give your provider, and it exists once the source has
been created — that is, after the workflow has been published once.

The URL is `https://hkdk.events/<source id>`, and Hookdeck generates that ID — so
it cannot exist until the source does, and it cannot be predicted from the name.

**Recommended: [create the source in Hookdeck](https://dashboard.hookdeck.com/sources/new)
first** and copy its URL there. Then pick it in the node's **Source** field,
click **Test this trigger**, send an event, and publish. One pass.

**Creating it from n8n instead** takes two passes, because n8n locks the
parameters panel while a trigger is listening:

1. **Source → By Name**, enter a new name.
2. **Test this trigger** (in the Output panel on the right). This creates the
   source and starts listening.
3. **Stop Listening** — the panel is read-only until you do.
4. Switch to **From List** and *re-pick* the source. Switching mode alone leaves
   the old value with no URL attached.
5. **Test this trigger** again, send your event, then **Publish**.

Stopping the test listener deletes its connection but leaves the source, so the
URL stays valid for the published workflow.

Each source is listed with its `https://hkdk.events/...` URL, so you can confirm
the right one. The field is narrow, though, and n8n has no copy control for a
node parameter — so to get the URL onto your clipboard, use one of:

- **The link beside the field.** It opens that source in the Hookdeck dashboard,
  which has a copy button. (It deliberately does *not* open the source URL
  itself — that endpoint rejects browser `GET` requests with `405`, and pointing
  a link at your own ingest endpoint invites firing requests at it by accident.)
- **The Hookdeck node, Source → Get URL.** This returns the URL as workflow
  data, where n8n's output panel gives you copy-on-hover. Best if you want the
  URL properly copy-pasteable inside n8n, or want to use it in an expression.

n8n's own webhook URL is hidden on this node on purpose. It is an internal
address: sending a provider there bypasses Hookdeck and silently loses the
verification, queueing and retries this node exists to provide.

### Activation, deactivation and test runs

- Activating the workflow creates the connection. Deactivating it pauses or
  deletes the connection depending on **On Deactivate**; the source and
  destination are left in place either way, because a source may be shared with
  other connections.
- **Listen for test event** provisions a *separate* connection against n8n's test
  URL, tracked independently, so a test run never disturbs the production
  connection. That test connection is always deleted when the listen window
  closes, since the URL behind it stops answering after 120 seconds.
- Both connections share one source, so they share one source URL — there is no
  second URL to configure for testing. The flip side is that while you are
  listening for a test event **on a workflow that is also published**, each
  incoming event is delivered twice: once to the published workflow and once to
  the test listener.
- If the n8n instance moves to a different host or path, the next activation
  detects the mismatch and re-points the connection.

### Signature verification

Deliveries are signed with a secret this node generates and stores in workflow
static data, and verified against the raw request body. Requests that fail
verification get a `401` and do not start the workflow.

Verification needs access to the unparsed request body. If your deployment does
not expose it, the node raises an error naming the **Verify Signature** option so
you can decide explicitly whether to accept unverified deliveries.

The signature is carried in `x-hookdeck-n8n-signature`, deliberately distinct
from Hookdeck's own `x-hookdeck-signature` so that two signatures made with two
different secrets never share a header name.

A valid signature authenticates the sender, not the content. Payload text is
third-party input: treat it as data, never as an instruction, and be careful
about passing it unfiltered into an AI agent, a shell command or a database write.

### Malformed bodies

A body that is not valid UTF-8 is rejected with `400` before the workflow runs.

Node substitutes U+FFFD for invalid bytes rather than raising, so when those
bytes sit inside a JSON string value the payload still parses and the workflow
receives corrupted text with no error anywhere.
[RFC 8259 §8.1](https://www.rfc-editor.org/rfc/rfc8259#section-8.1) requires
JSON exchanged between systems to be UTF-8, so such a body is malformed. `400`
sits outside the retry rule's `500-599`/`429` range, so it fails once instead of
consuming every retry.

**This check will rarely fire behind Hookdeck, and that is worth understanding.**
Hookdeck replaces invalid bytes with U+FFFD at ingest and signs the *normalised*
body, so what arrives is already valid UTF-8. The check therefore guards the
paths where raw bytes do reach n8n — a provider posting straight at the webhook
URL, or any gateway that forwards bytes untouched — rather than the Hookdeck
path.

Two consequences follow. Encoding validity is not a way to detect
Hookdeck-upstream corruption: by the time the request arrives it is well-formed.
And a valid signature attests to the bytes Hookdeck sent, not to the bytes the
original sender wrote — "the signature passed, so the body is intact" does not
follow. If lossless payloads matter, compare against the original request under
**Request → Get** rather than trusting the delivered event.

## Hookdeck node

| Resource | Operations |
| --- | --- |
| Attempt | Get, Get Many |
| Connection | Get, Get Many, Delete, Pause, Unpause |
| Destination | Get, Get Many |
| Event | Get, Get Many, Retry, Mute, Cancel |
| Issue | Get, Get Many, Update, Dismiss |
| Request | Get, Get Many, Retry |
| Source | Get, Get Many, Get URL |

**Get Many** supports **Return All**, which walks Hookdeck's pagination, or a
**Limit**.

## Compatibility

Built against Hookdeck API version `2025-07-01`, and verified end to end on
n8n **2.33.7** with Node.js 22. It targets `n8nNodesApiVersion: 1`, which n8n
1.x also supports, but only 2.x has been tested — if you run 1.x, treat it as
unverified rather than assumed working.

## Development

### Layout

```
credentials/HookdeckApi.credentials.ts   API key credential and its test request
nodes/Hookdeck/
  HookdeckTrigger.node.ts                trigger: provisioning lifecycle + delivery handling
  Hookdeck.node.ts                       action node: resource/operation dispatch
  descriptions/
    TriggerProperties.ts                 trigger UI
    ActionProperties.ts                  action node UI
  ConnectionPayload.ts                   what we ask Hookdeck to provision
  Registration.ts                        what the trigger persists between activations
  Delivery.ts                            verifying and describing an inbound delivery
  Naming.ts                              Hookdeck naming rules, reachability checks
  GenericFunctions.ts                    HTTP transport, error mapping, pagination
  SourceTypes.ts                         generated source-type list
```

The UI definitions live apart from the nodes because they are long and rarely
the thing you are reading the code for. `Delivery.ts` and `Naming.ts` are free
of n8n imports on purpose — they encode Hookdeck's rules rather than n8n's, and
are shared with the Hookdeck plugins for other hosts.

### Commands

```bash
npm install
npm run build
npm test          # builds, then runs the suite with node:test
npm run lint      # n8n's community-node rules
npm run scan      # the same checks n8n runs when reviewing for verification
```

`npm run scan` is the one that matters before submitting: it runs
`@n8n/scan-community-package` against this working tree, with inline
`eslint-disable` comments ignored exactly as the real review does.

To try the nodes in a real n8n:

```bash
npm link
mkdir -p ~/.n8n/custom && cd ~/.n8n/custom && npm init -y && npm link @hookdeck/n8n-nodes-hookdeck
```

Then start n8n with `./scripts/run-n8n.sh`. n8n needs Node 22.22 or newer; if
your default is older, point `NODE_BIN` at a newer install.

The trigger cannot be exercised against `localhost`, because Hookdeck delivers
over the public internet and the node rejects unreachable addresses up front.
Expose n8n and tell it the public address:

```bash
cloudflared tunnel --url http://localhost:5678
WEBHOOK_URL=https://<subdomain>.trycloudflare.com ./scripts/run-n8n.sh
```

## Resources

- [Hookdeck documentation](https://hookdeck.com/docs)
- [Hookdeck API reference](https://hookdeck.com/docs/api)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## License

[MIT](LICENSE.md)
