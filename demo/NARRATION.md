# Voiceover script

Recorded silent, voiced over afterwards, so nothing here has to be performed to
picture. Timings are targets, not constraints.

**One scene per image.** Nine scenes, eight captured frames in
[stills/](stills/) plus a static end card. Headings carry the scene identifier
and its frame; identifiers match the filenames exactly.

## Structure

Four acts, in this order:

1. **A — the hook.** The agent working, with no explanation. Here is the world.
2. **B — what it is.** The node, verified, on Cloud and self-hosted.
3. **C — how it is built.** The two workflows, named, before anything breaks.
4. **D — what happened.** Steady state, the break, the issue, the pause.
5. **E — end card.**

The setup comes _before_ the failure. Showing a break in a system the viewer has
not been introduced to is what made the earlier draft not flow.

| Scene | Starts | Length |
| --- | --- | --- |
| 01-A | 0:00 | 0:33 |
| 02-B | 0:33 | 0:12 |
| 03-C1 | 0:45 | 0:14 |
| 04-C2 | 0:59 | 0:10 |
| 05-D1 | 1:09 | 0:16 |
| 06-D2 | 1:25 | 0:18 |
| 07-D3 | 1:43 | 0:13 |
| 08-D4 | 1:56 | 0:17 |
| 09-E | 2:13 | 0:17 |

**2:30 as recorded**, measured from the finished read rather than
estimated. Delivery came out at 162wpm, faster than the 150 the drafts
assumed, which is why every scene is shorter than its estimate.

If it has to come down, in order of least loss:

1. **03-C1 and 04-C2** — 26s of setup. Merging them into one canvas beat costs
   the least.
2. **02-B's middle sentence** — "The agent does the reasoning…" The split is
   worth stating once, but 08-D4 demonstrates it anyway.
3. **06-D2's Sync explanation** — 18s on one mechanism. Cutting it makes the
   film shorter and the engineering less legible; it is the last thing I would
   drop.

**Spoken lines are in `text` fences**, not blockquotes, so a scene's script can
be selected and copied without stripping a marker off every line. The deck reads
those fences — run `node demo/build-deck.mjs` after editing.

**Nothing in `WALKTHROUGH.md` is spoken.** The quoted text there is what appears
on screen. This file is the only thing you say.

## Naming, fixed throughout

- **The Hookdeck n8n node** — the thing you install. Singular. Not "package"
  except when talking about npm specifically.
- **Hookdeck** — the company. **The Hookdeck Event Gateway** — the product that
  receives, queues and delivers. Events arrive at _the Event Gateway_.
- **Hookdeck Event Gateway Trigger** and **Hookdeck Event Gateway** — the two
  nodes, as the node panel and canvas label them.
- **n8n's AI Agent** does the reasoning; the Hookdeck node gives it the trigger
  and the actions. Credit both.
- **Triggers and Actions are n8n's own terms**, so the script uses them. Clicking
  into the node in the node panel lists its operations as `ISSUE ACTIONS`,
  `CONNECTION ACTIONS`, `EVENT ACTIONS` and so on, with `Triggers (1)` beneath.
  The canvas labels the agent's port `Tool`, which is why the three actions are
  also fairly called tools — but "actions" is the term n8n puts on screen, and
  01-A already uses it.
- The workflows are **Stripe ingestion** and **Ingestion incident**, and both are
  named on screen before the incident starts.

---

## 01-A — The hook · `stills/01-A-cold-open.png`

**0:33, 93 words.** The agent execution, Logs panel open: tool-call tree left,
the agent's incident note right. Let the last line land as `Pause connection` is
on screen.

```text
A webhook delivery just failed. An agent picked it up, counted how many events were failing, and determined this wasn't just a transient and recoverable error. So it paused the connection and stopped the retries being attempted to a service that's already down.

Then it wrote an incident note and triggered an on-call notification. That's n8n's AI agent and the Hookdeck n8n node working together. The agent does the reasoning. The Hookdeck node provides actions to read and manage the Event Gateway resources, so the agent can act upon the data it gets.
```

No setup, no context. The incident flow is the thing nobody else can show, so it
gets the opening seconds.

**On-call gets told, and has to be.** The agent does not replace on-call;
`Notify on-call` is the last node in the workflow and it runs. Pausing stops
events reaching the workflow, so a human has to know delivery has stopped and
that resuming it is their call. What changed is the order — they are told after
the triage and the remediation, not before them. Do not let the line drift into
"nobody needed to know" — that is both untrue and a weaker story.

**The division of labour belongs here, not on 02-B.** This is the scene where it
is visible: the tool calls are on screen as you say it. 02-B is about how you get
the thing, and putting the explanation there separates it from its evidence.

**"Reads the Event Gateway, and acts on it" — keep both halves.** The node is not
only a data source. `Get issue` and `List failed events` are reads; `Pause
connection` changes the external system, and it is the only step in the whole
film that does. Crediting the node with data alone gives away the more
interesting half.

**"Wasn't a blip" is the other claim to protect.** The agent is instructed to
distinguish a transient failure from a persistent one, and to pause only for the
second. A single failed delivery is a blip; the Event Gateway retries and it
clears. Several events failing on the same destination with the same status is a
destination that is down, and retries only add load. Pausing over one failure
would be the wrong call, and a viewer who works on this will notice if the demo
does it.

**On screen, `Notify on-call` is a No-Op node.** It is a placeholder for whatever
you actually page with, and it carries a green tick like any other step, so the
narration must not imply a message was delivered somewhere. "Wrote the incident
note" is the honest verb — the note is real and visible in the output panel; the
delivery is left to you.

---

## 02-B — What it is · `stills/02-B-node-panel.png`

**0:12, 32 words.** Node panel with `hookdeck` searched, both verified nodes
carrying shields above **More from the community**.

```text
The Hookdeck node is a verified community node, so it installs straight from the node panel on n8n Cloud, or self-hosted. Now, here's how the scenario we just looked at is constructed.
```

**Do not click into the node here.** The flat search result is safe. Clicking
through to the node's own page adds a footer reading `Package version 0.2.1
(Latest)`, and a version on screen is the one thing this asset must never show —
n8n Cloud serves whatever is on the verified list, which moves independently of
anything published. Stay on the search results.

"Verified" is load-bearing — unqualified "community node" reads as unofficial,
and verification is _why_ it appears in the node panel. Do not name a version,
and stay out of Settings → Community nodes.

The last line hands off into the setup act.

---

## 03-C1 — Stripe ingestion · `stills/03-C1-ingestion-workflow.png`

**0:14, 33 words.** The Stripe ingestion canvas, editor view.

```text
This is the Stripe ingestion workflow. The Hookdeck Event Gateway Trigger starts it when an event arrives from Stripe, and everything downstream is your workflow. Here, one call to a payments ledger endpoint.
```

Publishing the workflow is what creates the source, destination and connection in
the Event Gateway. Say that here only if the cut has room; it is the least
interesting true thing in the script.

---

## 04-C2 — Ingestion incident · `stills/04-C2-incident-workflow.png`

**0:10, 26 words.** The Ingestion incident canvas, editor view.

```text
And this is the Ingestion incident workflow. The agent sits behind it with three Event Gateway actions: get an issue, list events, and pause a connection.
```

---

## 05-D1 — Steady state · `stills/05-D1-steady-state.png`

**0:16, 40 words.** Connection list, Table view. `demo-stripe` carrying six
events, `demo-hookdeck-issues` idle, both **Active**.

```text
In the Event Gateway, the two trigger nodes are represented as two connections. Stripe events into the ingestion workflow, and Hookdeck's own issue notifications into the Ingestion incident workflow.

Both connections are active and events are being processed as expected.
```

The second connection reads zero events, which is correct — it only carries
traffic when something breaks. If that feels like a gap, "nothing to look at"
covers it.

---

## 06-D2 — The break · `stills/06-D2-failed-run.png`

**0:18, 50 words.** The failing run, `Post to ledger` red, "HTTP 500 code" in
the log panel.

```text
Then the ledger starts returning 500 errors on every event. The Hookdeck Trigger node is set to be synchronous, so it holds the response open until the workflow run finishes. The run fails, the trigger answers the Event Gateway with a 500 response, and the delivery is marked as failed.
```

The Sync sentence is the one technical point worth making: on Async the delivery
is acknowledged on receipt and a downstream failure never reaches the Event
Gateway, so none of the rest happens.

---

## 07-D3 — The issue · `stills/07-D3-issue.png`

**0:13, 36 words.** The open delivery issue in the Hookdeck dashboard.

```text
A failed delivery opens an issue in the Hookdeck Event Gateway. Hookdeck notifies you about issues over a webhook, so the notification arrives back through the Event Gateway and into the Ingestion incident workflow in n8n.
```

---

## 08-D4 — The pause · `stills/08-D4-paused.png`

**0:17, 44 words.** Same frame as 05-D1, `demo-stripe` now **Paused**.

```text
In our scenario, the agent found five events failing with the same status, decided the destination was down rather than flaky, and paused the demo-stripe connection. This queues all future events to be processed once the issue is resolved and the connection is unpaused.
```

Cut straight from 05-D1's framing so only the Status cell changes. It is the
external system changing, which no n8n panel can show.

**"Five events" is tied to the capture.** The agent counts what it finds, and
`prime` fires six of which five had reached FAILED when it looked. If the frames
are recaptured and the count comes out different, this line has to change with
them — it is the one number spoken aloud.

**The callback to the cold open is gone.** An earlier draft opened this scene
with "Which is the run you saw at the start", which tied the payoff back to 01-A.
Without it the viewer has to make that connection themselves. Worth a listen on
the first assembly: if 08-D4 feels like a new event rather than the resolution of
the one that opened the film, that sentence is why.

---

## 09-E — End card

**0:17, 50 words.** Static. The only scene with no captured frame.

```text
That's just one of the many scenarios and use cases that can be solved with n8n and the Hookdeck Event Gateway. Search Hookdeck in the n8n node panel to get started, or install from npm if you're self-hosted.

Both workflows from this video are in the Hookdeck n8n nodes repo.
```

On screen: **the Hookdeck n8n node**, `@hookdeck/n8n-nodes-hookdeck`, and the
repo link. The npm path is for self-hosters; the Cloud path is the primary call
to action, so it goes first.

---

## Alternative: the 15-second GIF

If the post is the deliverable and the video is illustration, 01-A alone carries
most of the value and needs no voiceover. One caption:

```text
A delivery issue in the Hookdeck Event Gateway, triaged and remediated by an n8n agent. Read the issue, count the blast radius, pause the connection.
```

---

## Notes on what NOT to say

- **No version number.** Not spoken, not on screen, not in the post.
- **Not "package"** for the thing you install — it is the Hookdeck n8n node.
  "Package" only when naming the npm path.
- **Not "the workflow acknowledges".** The _trigger_ holds the response. The
  workflow just runs.
- **No "simply", "just", "easily", "powerful", "seamless".** The install is two
  nodes; saying "simply" makes it sound like it isn't.
- **Don't apologise for length or hedge about unfinished edges.** The
  verification recording did this four times and it read as an unfinished
  product.
- **Don't claim this replaces on-call.** It pauses a connection and writes a
  note. That is the honest claim and it is a good one.
