# @hookdeck/n8n-nodes-hookdeck

**Reliable webhooks for n8n.** Put the [Hookdeck Event Gateway](https://hookdeck.com) in front of your workflows' inbound webhooks: signature verification for 151 providers, deduplication, a durable queue that survives restarts and unpublished workflows, and retries you can route on from inside the workflow.

Install from n8n's community nodes panel with the package name:

```
@hookdeck/n8n-nodes-hookdeck
```

## Why

n8n's built-in Webhook trigger hands your provider a URL that leads straight to your instance. A restart, a deploy or an unpublished workflow loses events, a double-firing provider runs the workflow twice, and a failed execution has no event left to retry. The Webhook node cannot tell you any of that happened, because it never saw the event.

This package puts Hookdeck in between and makes its guarantees options on the trigger node:

| n8n's Webhook node | With @hookdeck/n8n-nodes-hookdeck |
|---|---|
| Events lost while n8n is down, deploying, or the workflow is unpublished | Queued durably at Hookdeck. Unpublishing pauses delivery; publishing again delivers everything that arrived in the gap |
| A delivery n8n did not accept is gone | Retried up to 50 times with exponential or linear backoff, and `isLastAttempt` on the payload for a dead-letter branch |
| Provider retries run the workflow twice | Deduplicated at ingest (60 s window by default), plus a stable idempotency key on every delivery |
| No signature verification unless you build it | Verified at the edge with each platform's own scheme (Stripe, Shopify, GitHub, Twilio and 147 more), or HMAC / API key / basic auth for generic sources. Deliveries into n8n are separately signed |
| A burst, or one busy tenant, hits n8n at full speed | Delivery rate and concurrency capped upstream, including per-customer limits keyed on a payload path |
| Debugging means the execution log | Events, attempts, requests and issues inspected, retried and replayed as workflow steps, or in the Hookdeck dashboard |

Two nodes do this:

- **Hookdeck Event Gateway Trigger** starts a workflow when Hookdeck delivers an event. On publish it provisions the Hookdeck connection for you and lists your sources with the public URL to give your provider. Retries, deduplication and rate limits are node options, with no dashboard round-trips.
- **Hookdeck Event Gateway** manages sources, destinations and connections, and inspects events, delivery attempts, requests and issues. Each operation also works as an AI agent tool.

These nodes cover the Event Gateway only — the inbound path. [Outpost](https://hookdeck.com/outpost), Hookdeck's outbound path for publishing events to *your* users, is not covered here.

## Quickstart

1. Create a [Hookdeck account](https://dashboard.hookdeck.com/signup) (the free tier is enough) and copy the API key of an Event Gateway project from **Project Settings → Secrets**.
1. Install `@hookdeck/n8n-nodes-hookdeck` from **Settings → Community Nodes** in n8n ([guide](https://docs.n8n.io/integrations/community-nodes/installation/)). n8n Cloud installs only [verified](https://docs.n8n.io/integrations/community-nodes/installation/verified-install/) community nodes and this package's submission is pending, so for now it runs on self-hosted n8n.
1. Create a **Hookdeck Event Gateway API** credential and paste the key. One credential is one project.
1. Add a **Hookdeck Event Gateway Trigger** to a workflow. Under **Source → By Name** give the source a name, pick the platform sending the events as **Source Type**, and paste that platform's signing secret into **Webhook Secret**.
1. **Publish** the workflow. The node creates the source and the connection to this workflow.
1. Open **Source → From List** on the node. Each source is listed with its public `https://hkdk.events/...` URL. Give that URL to Stripe, GitHub, or whatever sends the events.

Events now arrive through Hookdeck with the default rules applied: five exponential retries a minute apart, and a 60 second deduplication window.

If Hookdeck cannot reach your n8n (a laptop, or an instance behind NAT), the node provisions a CLI destination instead and writes the `hookdeck listen` command to n8n's server log. Install the [Hookdeck CLI](https://hookdeck.com/cli) and run it alongside n8n. Nothing else changes — [Transport](docs/transport.md) covers what differs.

**Verification only starts when a secret is set.** Choosing a Source Type selects which signature scheme applies; it does not enable verification. A `STRIPE` source with no Webhook Secret accepts unsigned payloads, answers `200`, and records `verified: false`. [Security](docs/security.md) explains how to confirm a source is verifying.

## Hookdeck Event Gateway Trigger

Each execution receives one item: the provider's `body`, `headers` and `query`, plus a `hookdeck` object of delivery metadata that n8n's Webhook node has no way to supply.

```json
{
  "body":    { "...": "the payload the provider sent" },
  "headers": { "...": "all request headers" },
  "query":   { "...": "query string parameters" },
  "hookdeck": {
    "eventId": "evt_...",
    "attemptCount": 1,
    "attemptTrigger": "INITIAL",
    "isLastAttempt": false,
    "idempotencyKey": "evt_...",
    "verified": "true",
    "eventUrl": "https://dashboard.hookdeck.com/events/evt_..."
  }
}
```

`isLastAttempt` is `true` when Hookdeck will not retry again, the condition for a dead-letter branch. `idempotencyKey` is stable across retries of one event, so it is a sound deduplication key. The [trigger reference](docs/trigger.md#output) lists every field.

Hookdeck's connection rules are options on the node:

| Option | Default | Purpose |
|---|---|---|
| Acknowledgement Mode | Async Retry | **Async Retry** acknowledges on receipt and runs the workflow after. **Sync** holds the response until the run finishes, so a failed run answers `5xx` and Hookdeck retries the run itself. Sync is capped at 60 seconds |
| Retry Strategy / Count / Interval | 5 exponential retries, 60000 ms | How Hookdeck retries a delivery n8n did not accept. Up to 50 attempts |
| Deduplication Window (Ms) | `60000` | Repeat events within the window cost one execution. `0` turns it off |
| Delivery Rate Limit / Period | none | Cap deliveries per second, minute, hour, or `concurrent` executions |
| Delivery Group Key / Rate Limit / Period | none | A rate limit per value of a payload path, so one busy customer cannot crowd out the rest |
| On Deactivate | Pause | Unpublishing pauses the connection so queued events are held. Delete cancels them |
| Update Existing Source | off | A source that already exists is adopted as-is. Turn on to apply this node's type and verification to it |
| Verify Signature | on | Reject deliveries not signed by Hookdeck with `401` |

The full list, including Header Prefix and Source Config (JSON), is in the [trigger reference](docs/trigger.md).

## Hookdeck Event Gateway node

| Resource | Operations |
|---|---|
| Attempt | Get, Get Many |
| Connection | Get, Get Many, Get Count, Delete, Pause, Unpause |
| Destination | Get, Get Many, Get Count |
| Event | Get, Get Many, Get Count, Retry, Mute, Cancel |
| Issue | Get, Get Many, Get Count, Update, Dismiss |
| Request | Get, Get Many, Retry |
| Source | Get or Create, Get, Get Many, Get Count, Get URL |

**Event → Retry** is the recovery path for a failed run under Async Retry: add it to the workflow's error branch with `{{ $json.hookdeck.eventId }}` and Hookdeck redelivers the event. **Get Count** on events returns a floor (`isAtLeast: true`) because Hookdeck exposes no event count, which matters when an agent is reading the number. Details in the [node reference](docs/action-node.md).

## Example workflows

Three importable workflows are in [`examples/`](examples/), all built and run against a real n8n instance:

| Workflow | Problem it solves |
|---|---|
| [`process-each-event-once.json`](examples/process-each-event-once.json) | A retried delivery runs the workflow twice. Gates on `hookdeck.idempotencyKey` so the second arrival stops before doing the work again |
| [`catch-events-on-final-attempt.json`](examples/catch-events-on-final-attempt.json) | An event that fails every retry disappears silently. Routes on `hookdeck.isLastAttempt` so the final attempt reaches a dead-letter branch |
| [`ai-incident-agent.json`](examples/ai-incident-agent.json) | A destination starts failing and retries pile up unnoticed. Hookdeck's own `issue.opened` notification starts a workflow whose AI Agent reads the issue, counts the failing events and pauses the connection |

![A workflow in the n8n editor: a Stripe payment_intent.succeeded event arriving through the Hookdeck Event Gateway Trigger, taking the false branch of an IF node named "Final attempt?" to Process order, with the trigger's output panel showing body, headers, query and the hookdeck delivery metadata](docs/images/dead-letter-workflow.png)

*The dead-letter example mid-run.* The first two are not possible with n8n's built-in Webhook node, because both depend on delivery metadata only a gateway can supply. The third is not possible without a gateway at all: the event it reacts to is the gateway reporting a delivery it could not make. [`examples/README.md`](examples/README.md) describes what was observed running each.

## Security model

Webhook payloads are third-party input, and these nodes treat them that way:

- Provider verification happens at the Hookdeck source, using that platform's own scheme, once you supply its signing secret. That secret lives at the Hookdeck source; the trigger sends it there on publish and never checks a signature with it itself.
- Deliveries into n8n carry a second signature, in `x-hookdeck-n8n-signature`, made with a secret the trigger generates on publish. Requests that fail it get `401` and never start the workflow.
- n8n's own webhook URL is hidden on the trigger. Sending a provider there bypasses Hookdeck and silently loses everything above.
- A body that is not valid UTF-8 is rejected with `400`, outside the retryable range, rather than parsed into corrupted text.
- Payload text is data, never instructions. Be careful passing it unfiltered into an AI agent, a shell command or a database write.

## Limitations

- Self-hosted n8n only until the verified-node submission lands.
- Sync acknowledgement is capped at 60 seconds. Longer workflows use Async Retry, and recover failed runs with **Event → Retry** rather than Hookdeck's retry rules.
- The trigger has no completion hook, so deduplication is Hookdeck's Deduplication Window rather than a local ledger. Key on `hookdeck.idempotencyKey` for a stricter guarantee.
- On the CLI route, a connection with no `hookdeck listen` session records no event at all, and Delivery Rate Limit and Delivery Group are unavailable.
- n8n 1.x is untested.

[Limitations](docs/limitations.md) has each in full.

## Documentation

The README covers the common path. Everything else lives in [`docs/`](docs/):

| Guide | What's in it |
|---|---|
| [Getting started](docs/getting-started.md) | Install, credentials, setting up the trigger, finding the source URL, and what has been verified end to end |
| [Trigger reference](docs/trigger.md) | Every parameter and option, acknowledgement modes, the full output, and what publish, unpublish and test runs do |
| [Transport](docs/transport.md) | The direct and CLI delivery routes, running `hookdeck listen`, and what the CLI route cannot do |
| [Security](docs/security.md) | The two signatures, why a typed source is not a verified one, and malformed bodies |
| [Action node](docs/action-node.md) | Every resource and operation, Get or Create, counts, retry versus replay, and use as an agent tool |
| [Limitations](docs/limitations.md) | Known boundaries, and where this node departs from the shared reliability contract |
| [Example workflows](examples/README.md) | What each example does and what was observed running it |

## Development

```bash
npm test               # build + unit tests, no n8n or Hookdeck account required
npm run scan           # the rules n8n runs for verification
npm run lint
npm run test:live      # creates and deletes real Hookdeck resources (needs HOOKDECK_EG_API_KEY)
```

Trying the nodes in a real n8n, the pre-PR checklist and releasing are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Learn more

- [Hookdeck docs](https://hookdeck.com/docs) and [API reference](https://hookdeck.com/docs/api)
- [n8n community nodes](https://docs.n8n.io/integrations/#community-nodes)
- [Hookdeck Console](https://console.hookdeck.com): inspect webhooks without an account

Issues and PRs welcome. [MIT](LICENSE.md).
