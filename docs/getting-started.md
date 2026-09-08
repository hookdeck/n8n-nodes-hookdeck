# Getting started

The long version: installing, creating the credential, setting up the trigger,
finding the URL to give your provider, and what this package has been verified
against.

## Install

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and use the package name `@hookdeck/n8n-nodes-hookdeck`.

You'll also need a [Hookdeck account](https://dashboard.hookdeck.com/signup);
the free tier is enough to run real workflows on.

**Self-hosted n8n today.** n8n Cloud installs only community nodes on n8n's
[verified list](https://docs.n8n.io/integrations/community-nodes/installation/verified-install/),
and this package is not on it yet — the submission is pending. Self-hosted
instances can install any community package, so that is where it runs for now.

## Credentials

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

## Setting up the trigger

Set a source name, pick the platform sending the events, and activate the
workflow. On activation the node creates a Hookdeck connection whose destination
is this workflow's webhook URL. The public source URL to give your provider is
then listed under **Source → From List** — see
[Finding the source URL](#finding-the-source-url).

Events arrive through Hookdeck rather than directly, so Hookdeck's connection
rules apply to them — retries, delivery rate limits and deduplication are
configured on the node under **Options**. Every option is listed in the
[trigger reference](trigger.md).

> **On wording.** n8n 2.x calls making a workflow live **publishing** — the
> button reads *Publish*, and *Unpublish* to take it down. Older versions, the
> REST API, and the node option **On Deactivate** still say activate and
> deactivate. They are the same thing.

**Verification only starts when a secret is set.** Choosing a Source Type tells
Hookdeck *which* signature scheme that platform uses; it does not enable
verification on its own. Fill in **Webhook Secret** for platform sources, or
set **Verification** for generic ones. [Security](security.md) explains why this
is easy to miss and how to confirm a source is verifying.

### An existing source is adopted, not rewritten

If a source of that name is already in the project, the node binds the
connection to it by ID and leaves its Source Type and Verification exactly as
they are — a source can feed several connections, and rewriting it would change
how their events are verified too. The node's own Source Type and Verification
apply only when it creates the source. Note that this holds even when the types
agree: a Webhook Secret or HMAC setting entered here does not reach a source
that already exists. Whenever a setting is ignored, n8n's server log names it.

To deliberately reconfigure an existing source, turn on **Options → Update
Existing Source**. That applies this node's settings to the source, and to every
connection fed by it.

## Finding the source URL

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

## If Hookdeck cannot reach your n8n

A laptop, or an instance behind NAT, has no address Hookdeck can deliver to.
The trigger detects this on publish, provisions a CLI destination instead of an
HTTP one, and writes the `hookdeck listen` command to run to n8n's server log.
There is nothing to configure, but the CLI route has limits of its own —
[Transport](transport.md) covers both routes and what differs.

## Compatibility

Built against Hookdeck API version `2025-07-01`, and verified end to end on n8n
**2.35.7** with Node.js 22.23.2: package loaded from `N8N_CUSTOM_EXTENSIONS`,
credential created and its test passing, workflow activated, a live event sent
through the source URL and received by the workflow with its signature verified,
forged requests rejected with `401`, and an event sent while deactivated held and
then delivered on reactivation.

It targets `n8nNodesApiVersion: 1`, which n8n 1.x also supports, but only 2.x has
been tested — if you run 1.x, treat it as unverified rather than assumed working.
