# demo/deck.html

A full-screen slide deck for recording the demo. Open it in a browser — it is a
single self-contained file, no server needed:

```bash
open demo/deck.html
```

## Keys

| Key | Does |
| --- | --- |
| `→` `space` | Next scene |
| `←` `backspace` | Previous scene |
| `1`–`9` | Jump to a scene |
| `Home` `End` | First / last |
| `F` | Full screen |
| `N` | Narration notes for the current scene |
| `H` | Hide every control — hints, nav buttons, counter and progress bar |

The mouse cursor and every control fade out after about two seconds of no input,
so once you stop touching it there is nothing on screen but the frame. That is
usually enough on its own.

`H` is the stronger version: it hides the hints, the arrow buttons, the scene
counter and the progress bar outright, so they stay gone even while you are
moving the mouse or clicking through. Arrow keys still work. **`H` hides the hint
that tells you about `H`**, so remember it is the way back.

The URL carries the scene id (`deck.html#05-D1`), so you can reload straight back
to where you were between takes.

## Notes are for rehearsal, not for the take

`N` shows the narration for the current scene, taken from
[NARRATION.md](NARRATION.md). While they are up, a marker sits top-right saying
so, and **going full screen turns them off automatically** — full screen is the
signal that you are about to record, and notes on screen would be in the take.
Press `N` again if you deliberately want them during a rehearsal pass.

## The end card is drawn, not captured

Scene 09-E has no frame in `stills/`, so the deck renders it: the product name,
the npm package, and the repo. Edit the `#endcard` markup in `deck.html` to
change it.

## Regenerating after a script change

```bash
node demo/build-deck.mjs           # rewrite the slide list from NARRATION.md
node demo/build-deck.mjs --check   # fail if the deck is out of date
```

The slide list is generated from `NARRATION.md`, so it cannot drift on its own —
but it does not update on its own either. Run the build after editing the
script.

The frames are committed, so the deck works from a fresh clone. If they are ever
missing the deck says so rather than showing broken-image icons. See
[stills/README.md](stills/README.md) for how to recapture them.
