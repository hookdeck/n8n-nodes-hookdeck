# Stills

Eight frames, one per scene, in cut order. Filenames are the scene identifiers used in [NARRATION.md](../NARRATION.md). All 1920x1080 PNG, n8n light theme,
Hookdeck dashboard forced to light via CDP colour-scheme emulation (it follows
the OS otherwise). Captured 8 Sep 2026 from a live run.

| Scene | Act | Narration line it sits under | Frame |
| --- | --- | --- | --- |
| **01-A** | hook | "A webhook delivery just failed, and nobody needed to know." | `01-A-cold-open.png` — agent execution, Logs open |
| **02-B** | what it is | "That's the Hookdeck n8n node, doing the work." | `02-B-node-panel.png` — both verified nodes with shields |
| **03-C1** | setup | "This is Stripe ingestion…" | `03-C1-ingestion-workflow.png` — editor view |
| **04-C2** | setup | "And this is Ingestion incident…" | `04-C2-incident-workflow.png` — editor view |
| **05-D1** | what happened | "In the Event Gateway that's two connections…" | `05-D1-steady-state.png` — both **Active**, six events on `demo-stripe` |
| **06-D2** | what happened | "Then the ledger starts returning 500s." | `06-D2-failed-run.png` — `Post to ledger` red, "HTTP 500 code" |
| **07-D3** | what happened | "A failed delivery opens an issue." | `07-D3-issue.png` — the open delivery issue |
| **08-D4** | what happened | "Which is the run you saw at the start." | `08-D4-paused.png` — `demo-stripe` **Paused** |

One image per scene. Filenames are the scene identifier, so they match
[NARRATION.md](../NARRATION.md) headings exactly and sort into cut order.

**05-D1 → 08-D4 is the strongest cut in the set.** Same framing, same scroll
position, one cell changes from `Active` to `Paused`. It is the external system
changing, which no n8n panel can show. They are not adjacent in the cut — the
break and the issue sit between them — so match the framing carefully.

**05-D1 has real traffic on it.** `demo-stripe` shows six delivered events
because `warmup` fires successful ones first. Without that the frame reads 0 and
`NO DATA`, which looks like an empty project rather than a system that was
working. The second connection still reads zero, which is correct — it only
carries traffic when something breaks.

## Not captured

- **D, the end card.** Static, no source to capture.
- **The install click.** 02-B shows the panel with the node found and the shield
  visible, which is the frame that matters. Actually clicking Install would
  uninstall and reinstall on a live instance for no gain.

## Two framings that were dropped

Both were captured and discarded in favour of one frame per scene. Regenerate
either from the steps below if the cut wants it:

- **01-A with the Logs panel closed** — a cleaner pure cold open, but it loses the
  agent's words, which are the payoff.
- **06-D2 with n8n's error toast** instead of the log panel — the toast is transient
  UI and reads as a screenshot artefact rather than a state.

## Regenerating

```bash
node --env-file-if-exists=demo/.env demo/reset.mjs reset    # both connections Active
node --env-file-if-exists=demo/.env demo/reset.mjs warmup   # 6 successful events
# capture 05-D1, then 02-B, 03-C1, 04-C2
node --env-file-if-exists=demo/.env demo/reset.mjs prime    # wait ~15s
# capture 01-A, 06-D2, 07-D3, 08-D4
```

Order matters twice: `warmup` before 04-B2 or the frame has no traffic on it,
and it before `prime` or there is no before.

## Check the frame rendered before you keep it

The Hookdeck dashboard paints skeleton placeholders while it fetches, and a
screenshot taken a beat too early keeps them: 07-D3 was captured with grey bars
where the issue row should be, and the `Open 1` badge above them made it look
convincing. Confirm the content is actually on screen, not just that the page
loaded.

07-D3 also carries a relative timestamp — "41 minutes ago" in the current
capture. It is the only frame that visibly ages, so take it soon after `prime`
if the cut is meant to read as something that just happened.
