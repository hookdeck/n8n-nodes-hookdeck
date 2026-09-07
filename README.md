# @hookdeck/n8n-nodes-hookdeck

n8n community nodes for [Hookdeck](https://hookdeck.com), the event gateway
that receives, verifies, queues, and delivers webhooks, so your workflows
don't have to care whether n8n was up when the event arrived.

![A workflow in the n8n editor: a Stripe payment_intent.succeeded event arriving
through the Hookdeck Event Gateway Trigger, taking the false branch of an IF
node named "Final attempt?" to Process order, with the trigger's output panel
showing body, headers, query and the hookdeck delivery
metadata](docs/images/dead-letter-workflow.png)

*A dead-letter branch routing on `hookdeck.isLastAttempt`, one of the
[example workflows](#example-workflows) below. The `hookdeck` object in the
trigger's output is delivery metadata n8n's built-in Webhook node has no way to
supply.*

[n8n](https://n8n.io) is a [fair-code licensed](https://docs.n8n.io/reference/license/)
workflow automation platform. Its built-in Webhook trigger hands your provider
a URL that leads straight to your instance, which means a restart, a deploy,
or a deactivated workflow loses events, a double-firing provider runs your
workflow twice, and a failed execution has no event left to retry. This
package puts Hookdeck in between, and makes its guarantees configurable from
the node itself:

- **No events lost to downtime.** Events are queued durably at Hookdeck.
  Unpublishing a workflow pauses delivery instead of dropping events;
  publishing again delivers everything that arrived in the gap. Failed deliveries
  are retried, up to 50 attempts with exponential or linear backoff.
- **Duplicates collapsed at ingest.** A configurable deduplication window
  (60 s by default) means a provider retry costs one execution, not two. Every
  delivery carries a stable idempotency key for stricter checks in-workflow.
- **Failed runs are recoverable.** Sync acknowledgement returns `5xx` on a
  failed run so Hookdeck retries the run itself; Async mode exposes
  **Event > Retry** as a workflow step for error branches, plus
  `isLastAttempt` for dead-letter routing.
- **Signature verification at the edge.** 151 source types (Stripe, Shopify,
  GitHub, Twilio, and more), each with that platform's own scheme, plus HMAC /
  API key / basic auth for generic sources. Verification runs once you supply
  the platform's signing secret — a source without one accepts unsigned
  payloads. Deliveries into n8n are separately signed and verified against the
  raw body.
- **Rate limiting upstream of n8n.** Cap delivery throughput or concurrency
  before events reach your instance, including per-customer limits keyed on a
  payload path, so a burst (or one busy tenant) can't take the instance down.
- **Full visibility.** Inspect events, delivery attempts, and the original
  requests from inside n8n, and retry or replay them as workflow steps.

This package adds two nodes:

- **Hookdeck Event Gateway Trigger** — starts a workflow when Hookdeck delivers an event.
  On activation it provisions the Hookdeck connection for you, and lists your
  sources with the public URL to give your provider. Retries, deduplication, and rate
  limits are node options, with no dashboard round-trips.
- **Hookdeck Event Gateway** — manages sources, destinations and connections,
  and inspects events, delivery attempts, requests and issues.

**Scope.** These nodes cover the Event Gateway only — the inbound path, where
Hookdeck receives events on your behalf and delivers them to n8n. Hookdeck's
other products are not covered here: notably
[Outpost](https://hookdeck.com/outpost), which is the outbound path for
publishing events to *your* users' destinations. Outbound publishing would be a
separate node, not an operation on these.

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and use the package name `@hookdeck/n8n-nodes-hookdeck`.

You'll also need a [Hookdeck account](https://dashboard.hookdeck.com/signup);
the free tier is enough to run real workflows on.

**Self-hosted n8n today.** n8n Cloud installs only community nodes on n8n's
[verified list](https://docs.n8n.io/integrations/community-nodes/installation/verified-install/),
and this package is not on it yet — the submission is pending. Self-hosted
instances can install any community package, so that is where it runs for now.

## Documentation

### Credentials

The nodes authenticate with the API key of a Hookdeck **Event Gateway** project.

1. Open [Hookdeck](https://dashboard.hookdeck.com) and select an Event Gateway
   project.
2. Go to **Project Settings → Secrets** and copy the API key.
3. In n8n, create a new **Hookdeck Event Gateway API** credential and paste the
   key.

One credential is one project. The key carries the project, so there is nothing
else to configure and no way to reach across projects — everything these nodes
create or read belongs to the project the key came from. To work with a second
project, add a second credential.

A key from an Outpost project will not work here. Outpost is the outbound path,
with its own API; these nodes only speak to the Event Gateway.

### Hookdeck Event Gateway Trigger

Set a source name, pick the platform sending the events, and activate the
workflow. On activation the node creates a Hookdeck connection whose destination
is this workflow's webhook URL. The public source URL to give your provider is
then listed under **Source → From List** — see
[Finding the source URL](#finding-the-source-url).

Events arrive through Hookdeck rather than directly, so Hookdeck's connection
rules apply to them — retries, delivery rate limits and deduplication are
configured on the node under **Options**.

**An existing source is adopted, not rewritten.** If a source of that name is
already in the project, the node binds the connection to it by ID and leaves its
Source Type and Verification exactly as they are — a source can feed several
connections, and rewriting it would change how their events are verified too.
The node's own Source Type and Verification apply only when it creates the
source. Note that this holds even when the types agree: a Webhook Secret or HMAC
setting entered here does not reach a source that already exists. Whenever a
setting is ignored, n8n's server log names it.

To deliberately reconfigure an existing source, turn on **Options → Update
Existing Source**. That applies this node's settings to the source, and to every
connection fed by it.

### How events reach n8n

> **On wording.** n8n 2.x calls making a workflow live **publishing** — the
> button reads *Publish*, and *Unpublish* to take it down. Older versions, the
> REST API, and the node option **On Deactivate** still say activate and
> deactivate. They are the same thing.

The trigger picks one of two delivery routes when you publish the workflow,
based on whether Hookdeck can reach the address n8n advertises.

| n8n's webhook URL | Destination | How events arrive |
| --- | --- | --- |
| Publicly reachable — n8n Cloud, or self-hosted with a public address | `HTTP` | Hookdeck makes a request to n8n directly |
| Not reachable — a laptop, or an instance behind NAT | `CLI` | Hookdeck sends events to `hookdeck listen`, which forwards them to n8n |

There is nothing to configure. Both routes sign deliveries the same way, so
signature verification behaves identically and the workflow receives the same
item either way.

This is about reachability, not about development. A self-hosted n8n behind NAT
uses the CLI route in production just as a laptop does.

#### Running the CLI route

The node writes the exact commands to n8n's server log when the workflow is
published — that is the console n8n itself is running in, not the **Logs** panel
in the editor, which only shows workflow executions. Run them alongside n8n:

```bash
hookdeck ci --api-key <your Event Gateway project API key>
hookdeck listen 5678 <source> --device-name n8n-<host>-<instance>
```

`hookdeck ci` matters: `hookdeck listen` otherwise uses whichever project the
CLI was last logged into, and pointing it at the wrong one looks like the node
is broken. `--device-name` keeps two n8n instances from being treated as one
listener restarting.

**No connection is named in that command, deliberately.** An n8n trigger has two
webhook URLs — the live one used while the workflow is active, and a separate
one used by **Listen for test event** in the editor. The node provisions a
Hookdeck connection for each, both on the same source. Naming a connection
attaches the CLI to that one alone, so a command naming the live connection
would leave test events with no CLI session — and events for a connection with
no session are not recorded at all. Naming only the source attaches to every
connection the source has.

The CLI picks up the connections that exist when it starts, so restart it after
the first use of **Listen for test event**, which is when n8n creates the second
connection.

#### What the CLI route cannot do

- **No Delivery Rate Limit and no Delivery Group.** Hookdeck supports these on
  directly reachable destinations only. If they are set, the node does not send
  them and says so in the log.
- **Events are not held for a listener that is not there.** Two cases, and the
  second is the one that bites:
  - `hookdeck listen` was running and dropped. The session stays eligible for
    two minutes, so the event is created and the attempt fails with
    `CLI_UNAVAILABLE`. The connection's retry rule then applies — five
    exponential retries from a minute apart by default, roughly half an hour of
    recovery. Beyond that, retry it by hand.
  - **No CLI session exists at all. No event is created for that connection.**
    Measured: with two CLI connections on one source and a listener on only one
    of them, the listened connection recorded two events and the unlistened one
    recorded zero. There is nothing queued, nothing failed, and nothing to
    retry — the delivery simply is not recorded against that connection.

That last point decides whether this route suits production, and the answer
depends on how you run the CLI. A terminal window on a laptop is not production
whatever the retry settings. A supervised process on a server — a systemd unit,
or a container with a restart policy — keeps outages to seconds, which the retry
rule covers.

#### Parameters

| Parameter | Description |
| --- | --- |
| Source | The Hookdeck source. **From List** shows every source in the project with its public URL, so you can copy the URL for your provider without leaving the canvas. **By Name** takes a new name — letters, numbers, hyphens and underscores — and creates the source on publish. |
| Source Type | The platform sending events. This selects *which* signature scheme Hookdeck applies; it does not switch verification on by itself — see below. Use **Webhook (Generic)** to configure verification yourself. Applies when the node creates the source; an existing source keeps its own type. |
| Verification | For generic sources: HMAC, API Key, Basic Auth, or none. |
| Webhook Secret | For platform sources: the signing secret the platform issued you. Placed in whichever field that platform expects. A few platforms need more than one value — those ask you to use Source Config (JSON) instead, and name the fields. |

#### Verification only starts when a secret is set

Choosing a Source Type tells Hookdeck *which* signature scheme that platform
uses. It does not enable verification on its own. A source typed `STRIPE` with
no signing secret accepts an unsigned, forged payload and delivers it — the edge
answers `200` and records `verified: false`.

So fill in **Webhook Secret** for platform sources, or set **Verification** for
generic ones. Two things make this easy to miss:

- **The status code is not the verdict.** Hookdeck answers `200` at the edge
  whether or not a payload verified. The answer is the `verified` field on the
  request, under **Request → Get** (or the dashboard). Read the request detail,
  not the list — the list omits fields the detail returns.
- **A configured source looks identical to an unconfigured one.** The API never
  returns the secret, or any indication one exists, so you cannot confirm it
  from the source itself. An inbound request's `verified` field is the only
  signal.

This is separate from **Verify Signature** under Options, which covers the
Hookdeck-to-n8n hop and is on by default.

#### Options

| Option | Description |
| --- | --- |
| Retry Strategy / Count / Interval | How Hookdeck retries a delivery this workflow did not accept. Up to 50 attempts. Server errors and `429` are always retryable. Defaults to 5 exponential retries a minute apart, applied even if you never open Options. |
| Deduplication Window | Discard repeat events seen within the window, so a double-firing provider costs one execution. Defaults to 60000 ms; set 0 to turn it off. |
| Delivery Rate Limit / Period | Cap how fast Hookdeck delivers into this workflow. Supports `concurrent` to cap simultaneous executions. |
| Delivery Group Key / Rate Limit / Period | Group deliveries by a payload path, so each customer or repository gets its own rate limit and one busy sender cannot crowd out the rest. |
| On Deactivate | Pause the connection (default) or delete it. See below. |
| Header Prefix | Prefix of Hookdeck's metadata headers. Change only for a white-labelled project. |
| Update Existing Source | Apply this node's Source Type and Verification to a source that already exists. Off by default — see above. |
| Verify Signature | Reject deliveries that are not signed by Hookdeck. On by default. |
| Source Config (JSON) | Advanced. Merged into the source config, for verification schemes the fields above cannot express. |

#### Acknowledgement modes

| Mode | Behaviour |
| --- | --- |
| **Async Retry** (default) | Acknowledge as soon as the event is received, then run the workflow. The sender never waits. A run that fails afterwards is not retried by Hookdeck, because the delivery already succeeded. |
| **Sync** | Hold the HTTP response until the workflow finishes. Success answers 2xx; a failed run answers 5xx, so Hookdeck's retry rules apply to the *run*, not just the delivery. |

Hookdeck stops waiting after 60 seconds, so Sync suits workflows that finish
well inside that. Longer workflows should use Async Retry.

##### Retrying a failed run under Async Retry

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

#### Unpublishing without losing events

Deleting a Hookdeck connection cancels every event still queued for it, and that
cannot be undone. So unpublishing the workflow **pauses** the connection by
default: inbound events are held durably, and publishing again unpauses it and
delivers everything that arrived meanwhile. That makes a deploy or a
maintenance window lossless.

Choose **Delete the Connection** under Options if you would rather the
connection be removed — accepting that queued events go with it.

#### Output

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

#### Limitations

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
  option, which caps delivery inside Hookdeck before n8n is reached — on a
  directly reachable n8n. Instances receiving events through the Hookdeck CLI
  have no equivalent, because a CLI destination does not support rate limiting.

Destination authentication also uses `CUSTOM_SIGNATURE` rather than
`HOOKDECK_SIGNATURE`. Hookdeck's project signing secret is not exposed through
the API, so `HOOKDECK_SIGNATURE` would force you to copy a second secret by
hand. This node generates its own signing secret at provisioning time instead;
the algorithm is identical (HMAC-SHA256 over the raw body, base64).

#### Finding the source URL

This is the address you give your provider. It is `https://hkdk.events/<source id>`,
and Hookdeck generates that ID when the source is created, so it cannot be
predicted from the name and does not exist until the source does.

1. **Source → By Name**, type a name.
2. **Publish the workflow.** The node creates the source.
3. **Source → From List.** Each source is listed as `name — https://hkdk.events/...`.
4. Give that URL to Stripe, GitHub, or whatever is sending the events.

There is no need to know the URL before publishing. Nothing can arrive until
your provider has been pointed at it, so publishing first costs nothing.

If the source already exists in Hookdeck, skip to step 3 — pick it from the
list, and the node leaves its Source Type and Verification alone. The link
beside the field in **By Name** mode opens Hookdeck's create-a-source page, if
you would rather make it there first.

To get the URL onto your clipboard, either use the link beside a listed source,
which opens it in the Hookdeck dashboard where there is a copy button, or run
the **Hookdeck Event Gateway** node with **Source → Get or Create** or
**Source → Get URL**, both of which return the URL as workflow data with
copy-on-hover. (The link deliberately does not point at
the source URL itself: that endpoint rejects browser `GET` requests with `405`,
and aiming a link at your own ingest endpoint invites firing requests at it by
accident.)

n8n's own webhook URL is hidden on this node on purpose. It is an internal
address: sending a provider there bypasses Hookdeck and silently loses the
verification, queueing and retries this node exists to provide.

#### Activation, deactivation and test runs

- Publishing the workflow creates the connection. Unpublishing it pauses or
  deletes the connection depending on **On Deactivate**; the source and
  destination are left in place either way, because a source may be shared with
  other connections.
- **Listen for test event** provisions a *separate* connection against n8n's test
  URL, tracked independently, so a test run never disturbs the production
  connection. On the direct route that connection is deleted when the listen
  window closes, since the URL behind it stops answering after 120 seconds. On
  the CLI route it is **paused** instead: deleting it would mean every test run
  created a new connection that a running `hookdeck listen` is not attached to,
  so the CLI would need restarting each time. Paused, it keeps its ID, the CLI
  stays attached, and the next test run unpauses it.
- Both connections share one source, so they share one source URL — there is no
  second URL to configure for testing. The flip side is that while you are
  listening for a test event **on a workflow that is also published**, each
  incoming event is delivered twice: once to the published workflow and once to
  the test listener.
- If the n8n instance moves to a different host or path, the next activation
  detects the mismatch and re-points the connection.

#### Signature verification

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

#### Malformed bodies

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

### Example workflows

Three importable workflows are in [`examples/`](examples/), all built and run
against a real n8n instance:

| Workflow | Problem it solves |
| --- | --- |
| [`process-each-event-once.json`](examples/process-each-event-once.json) | A retried delivery runs the workflow twice. Gates on `hookdeck.idempotencyKey`, which is stable across retries of one event, so the second arrival stops before doing the work again. |
| [`catch-events-on-final-attempt.json`](examples/catch-events-on-final-attempt.json) | An event that fails every retry disappears silently. Routes on `hookdeck.isLastAttempt` so the final attempt reaches a dead-letter branch. |
| [`ai-incident-agent.json`](examples/ai-incident-agent.json) | A destination starts failing and retries pile up unnoticed. Hookdeck's own `issue.opened` notification starts a workflow whose AI Agent reads the issue, counts the failing events and pauses the connection — the action node used as an agent tool. |

The first two are not possible with n8n's built-in Webhook node, because both
depend on delivery metadata only a gateway can supply, and the third is not
possible without a gateway at all: the event it reacts to is the gateway
reporting a delivery it could not make. See
[`examples/README.md`](examples/README.md) for how each behaves and what was
observed running them.

The screenshot at the top of this README is the dead-letter example mid-run.
`isLastAttempt` is what its IF node branches on, `idempotencyKey` is what the
other example deduplicates on, and `eventUrl` links straight to that delivery in
the Hookdeck dashboard.

### Hookdeck Event Gateway node

| Resource | Operations |
| --- | --- |
| Attempt | Get, Get Many |
| Connection | Get, Get Many, Get Count, Delete, Pause, Unpause |
| Destination | Get, Get Many, Get Count |
| Event | Get, Get Many, Get Count, Retry, Mute, Cancel |
| Issue | Get, Get Many, Get Count, Update, Dismiss |
| Request | Get, Get Many, Retry |
| Source | Get or Create, Get, Get Many, Get Count, Get URL |

**Source → Get or Create** returns the named source, creating it only if it is
not there, and gives back its public URL. Source names are unique within a
project, so a plain create is not safe to re-run — `POST /sources` answers `409`
the second time. An upsert would be, but `PUT /sources` rewrites an existing
source's type and verification, which is the damage the trigger was changed to
stop doing. Getting first avoids both.

**Get Many** supports **Return All**, which walks Hookdeck's pagination, or a
**Limit**.

**Get Count** answers "how many" without listing them, and takes the same
filters. Connections, destinations, issues and sources are counted exactly and
return `isAtLeast: false`. Events are different — Hookdeck exposes no event
count — so they are counted by paging to a ceiling and returning
`isAtLeast: true` when that ceiling is reached, alongside `countedUpTo`. Treat
that as a floor, not a total. This matters most when the node is used as an AI
agent tool: a page size reported as a count is a number the agent will state as
fact.

### Compatibility

Built against Hookdeck API version `2025-07-01`, and verified end to end on n8n
**2.35.7** with Node.js 22.23.2: package loaded from `N8N_CUSTOM_EXTENSIONS`,
credential created and its test passing, workflow activated, a live event sent
through the source URL and received by the workflow with its signature verified,
forged requests rejected with `401`, and an event sent while deactivated held and
then delivered on reactivation.

It targets `n8nNodesApiVersion: 1`, which n8n 1.x also supports, but only 2.x has
been tested — if you run 1.x, treat it as unverified rather than assumed working.

## Contributing

Building the nodes, running the tests, trying them in a real n8n, and the
release process are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Resources

- [Hookdeck documentation](https://hookdeck.com/docs)
- [Hookdeck API reference](https://hookdeck.com/docs/api)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## License

[MIT](LICENSE.md)
