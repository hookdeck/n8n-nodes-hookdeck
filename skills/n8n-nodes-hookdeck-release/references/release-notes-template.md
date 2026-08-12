# Release notes template

Fill in for the GitHub release body — the file passed to
`gh release create --notes-file`.

**Omit any section with nothing to say.** Do not write "Breaking changes: none".
Most releases need two or three of these headings.

Write for someone running a workflow. The reader wants to know what changes for
them, and whether they have to do anything.

## Summary

<!-- Two to four sentences. Who benefits, and the scope since the previous tag.
Lead with the single most important change. -->

## Action required

<!-- Only when the reader must do something for the release to take effect or to
keep working:

- republish a workflow so the trigger re-provisions its Hookdeck connection
- restart `hookdeck listen`
- rotate or re-enter a credential
- change a node parameter that no longer means what it did

Put this above the feature list. Nobody scrolls to find out their workflow is
broken. Omit entirely when a plain upgrade is enough. -->

## Breaking changes

<!-- Only for changes that detach or alter an existing published workflow:
renamed node types, renamed credential types, renamed or removed parameters,
removed operations, a changed output item shape.

For each: what changed, why, and exactly what to do about it. Name the old and
new identifiers. Omit the section when there are none. -->

## New features

<!-- User-visible capability. Group by node or by area. Name the resource and
operation, or the option, as it appears in the UI — "Source → Get or Create",
not "getOrCreate". -->

## Fixes

<!-- What was wrong, and what happens now. Prefer the symptom over the
mechanism: "a retried delivery no longer runs the workflow twice" tells the
reader more than "dedupe on idempotencyKey". -->

## Improvements

<!-- Behaviour, defaults, reliability, docs and UI wording that users notice but
that are not new capability. -->

## Internal

<!-- Tests, CI, refactors, dependency bumps. Keep it short, or omit — this
section is for maintainers skimming, not users. -->

## Contributors

<!-- Omit for almost every release.

Include only when someone's first contribution ships here, or when a single
contribution was exceptionally large. Regular maintainers do not need a
call-out. -->

---

**Full Changelog**: https://github.com/hookdeck/n8n-nodes-hookdeck/compare/PREV_TAG...NEW_TAG
