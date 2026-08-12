---
name: n8n-nodes-hookdeck-release
description: >-
  Guides maintainers through releases of @hookdeck/n8n-nodes-hookdeck (stable
  from main, beta from main or a feature branch) and user-centric GitHub release
  notes. Validates the proposed version against SemVer as an n8n community node
  reads it, where a renamed node type or credential breaks saved workflows. Use
  when cutting a release, publishing a tag, drafting release notes, choosing
  MAJOR.MINOR.PATCH, npm publish, provenance, pre-releases, n8n verification, or
  `gh release create`.
---

# @hookdeck/n8n-nodes-hookdeck — release workflow

## Canonical documentation

Follow **[README.md](../../README.md) § Releasing** for the human steps. This
skill adds **how automation works**, **what counts as breaking for an n8n node**,
and a **research loop** for drafting notes.

**Agents:** publish with the **GitHub CLI** — see **Publish with `gh`** below.

## Agent checklist (end-to-end)

Follow **in order**. Items marked **gate** are blocking unless the maintainer
explicitly overrides.

- [ ] **Release shape:** stable from `main`, beta from `main`, or beta from a
      feature branch. Confirm with the maintainer.
- [ ] **`PREV_TAG` / `NEW_TAG`:** agreed. For a beta series the baseline is
      usually the last **stable** tag, not the last beta.
- [ ] **Change set:** `git log PREV_TAG..HEAD` read in full, grouped by user
      impact (see **Research loop**).
- [ ] **gate — SemVer:** the proposed tag matches the **minimum** bump the delta
      requires (see **What breaks an n8n node**). Stop and realign if under-bumped.
- [ ] **gate — node identity unchanged:** no node `name`, credential `name` or
      parameter `name` changed since the last stable release without a MAJOR bump
      and a migration note. These are recorded in saved workflows.
- [ ] **gate — verification scan:** `npm run scan` passes. A release that fails it
      would fail n8n's review.
- [ ] **gate — CI green:** the commit being released has green checks. For a
      stable release that means the tip of `main`.
- [ ] **CHANGELOG:** `## [Unreleased]` promoted to the new version with a date, in
      a normal PR **before** the release.
- [ ] **Notes drafted:** see **Drafting release notes** and
      [references/release-notes-template.md](references/release-notes-template.md).
      Include the **Full Changelog** compare link.
- [ ] **gate — approval:** the maintainer has signed off on the version, the notes
      and the target branch. Never push a surprise tag.
- [ ] **Publish:** notes to a temp file → `gh release create` → remove the temp
      file. `--prerelease` for betas.
- [ ] **Post-publish:** the **Publish** workflow succeeded, and the version is on
      npm under the expected dist-tag.

## What triggers a release

**[.github/workflows/publish.yml](../../.github/workflows/publish.yml)** runs on
`release: published` — not on a tag push, and not on a branch push. Creating the
release in the GitHub UI or with `gh release create` creates the tag and starts
the workflow together.

The workflow checks out the release tag, sets the version in `package.json` from
the tag name, re-runs lint, scan, build, the load check and the unit tests, then
`npm publish --provenance`. A **pre-release** publishes under the `beta`
dist-tag so `npm install @hookdeck/n8n-nodes-hookdeck` keeps resolving to the
last stable version.

There is no release commit. The tag is the version, so `package.json` in git
stays at whatever it was — do not "fix" it in a follow-up commit.

## Auth: provenance is not trusted publishing

Two things, easily conflated:

- **Provenance** — the signed attestation tying the package to this repo,
  workflow and commit. Needs `id-token: write`. Works with either auth method.
  **This is what n8n requires.**
- **Trusted publishing** — publishing with a short-lived OIDC token instead of a
  long-lived npm token. Not required by n8n.

Trusted publishers are configured on an **existing** package's settings page, so
a package that has never been published cannot use OIDC for its first release.
The first release needs an `NPM_TOKEN` secret; provenance still applies, so it
still satisfies n8n. After that, add the trusted publisher on npmjs.com and
delete the secret — the workflow's auth step is skipped when it is absent and npm
falls back to OIDC.

Do not leave an empty `NPM_TOKEN` secret in place. An empty credential takes
precedence over OIDC and the publish fails.

## What breaks an n8n node

SemVer here is about **the contract with a saved workflow**, not just the API
surface. n8n stores the node type, the credential name and every parameter name
inside the user's workflow JSON. Renaming any of them does not fail a build — it
silently detaches existing workflows.

| Change since `PREV_TAG` | Bump | Examples |
| --- | --- | --- |
| **Breaking** — an existing published workflow stops working or loses configuration | **MAJOR** | Renaming a node type (`hookdeckEventGateway`), renaming the credential type (`hookdeckEventGatewayApi`), renaming or removing a parameter, removing a resource or operation, changing the shape of the trigger's output item, changing a default in a way that alters delivery behaviour |
| **New capability**, backward compatible | **MINOR** | New resource or operation, new option, new source types, additive fields on the output item, a new delivery route that existing workflows are not moved onto |
| **Fixes, docs, internals** | **PATCH** | Bug fixes, wording, icons, tests, CI, dependency bumps, generated source-type refreshes |

**Before 1.0.0**, a MINOR bump is the strongest signal available for a breaking
change, so say so loudly in the notes rather than relying on the number.

**Ask, do not guess.** If it is unclear whether a change detaches an existing
workflow, ask the maintainer before tagging. The cost of over-bumping is a
version number; the cost of under-bumping is someone's production workflow.

### The node-identity check, concretely

```bash
git diff PREV_TAG..HEAD -- nodes credentials \
  | grep -E '^[-+]\s+(name:|displayName:)' | sort | uniq -c | sort -rn | head -20
```

Any `- name: '...'` paired with a `+ name: '...'` in a node description, a
credential class or a property is a candidate break. Read it, do not skim it.

## Stable release

1. Land everything, including the CHANGELOG promotion, through PRs.
2. Confirm `main` is green:

   ```bash
   SHA=$(git rev-parse origin/main)
   gh api "repos/hookdeck/n8n-nodes-hookdeck/commits/${SHA}/status" --jq .state
   ```

   Do not release on `failure`, or on `pending` for required checks.
3. Create the release targeting `main` (see **Publish with `gh`**).

## Pre-release (beta)

Tag as `v0.3.0-beta.1`. The **base version** still has to satisfy the table
above relative to the last stable release — a beta containing a breaking change
is `v1.0.0-beta.1`, not `v0.9.0-beta.1`.

- **From `main`:** `--target main --prerelease`. Still requires green CI.
- **From a feature branch:** `--target <branch> --prerelease`. Requires green CI
  on that branch, and the notes should say what to test.

Install with `npm install @hookdeck/n8n-nodes-hookdeck@beta`.

## Publish with `gh`

Create the **release**, not a bare tag: the release carries the notes and is what
the workflow listens for.

1. Write the notes to a temp file, with cleanup registered up front:

   ```bash
   NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/n8n-nodes-hookdeck-notes.XXXXXX.md")"
   trap 'rm -f "$NOTES_FILE"' EXIT
   ```

2. Write the final markdown body to `"$NOTES_FILE"`.

3. Create the release:

   ```bash
   gh release create "v0.2.0" \
     --repo hookdeck/n8n-nodes-hookdeck \
     --target main \
     --title "v0.2.0" \
     --notes-file "$NOTES_FILE"
   ```

   Add `--prerelease` for a beta, and `--target <branch>` for a branch beta.

4. Confirm the workflow ran and the package landed:

   ```bash
   gh run list --repo hookdeck/n8n-nodes-hookdeck --workflow Publish --limit 1
   npm view @hookdeck/n8n-nodes-hookdeck dist-tags
   ```

**Never put a secret in the notes.** The release body is public.

## Drafting release notes

Start from
[references/release-notes-template.md](references/release-notes-template.md).

Write for someone running a workflow, not someone reading the diff. "Events are
no longer lost when the CLI restarts" beats "changed teardown from delete to
disable".

**Include only headings with real content.** Do not write "Breaking changes:
none".

Always end with:

`**Full Changelog**: https://github.com/hookdeck/n8n-nodes-hookdeck/compare/<PREV_TAG>...<NEW_TAG>`

**Say what a user must do.** If a release changes delivery behaviour, needs a
workflow republished to take effect, or requires the Hookdeck CLI to be
restarted, that belongs at the top, not in a bullet halfway down.

**Contributors:** only call out a **new** contributor shipping their first work,
or an exceptionally large contribution. No generic thanks block.

## Research loop

1. **Tags:** `git describe --tags --abbrev=0` on the target branch, or ask.
2. **Commits:** `git log PREV_TAG..HEAD --oneline`, then read the full messages.
   This repo writes long commit messages that explain *why* — use them; they are
   usually closer to release-note prose than the diff is.
3. **Group by user impact**, merging related commits.
4. **SemVer check** against the table above, plus the node-identity check.
5. **PRs:** `gh pr list --state merged --search "merged:>=<date>"` for links.
6. **Sanity:** if a commit is unclear, read the README section it changed —
   user-facing behaviour is documented there.
7. **gate — CI** on the branch being released.

## Safety

- Do not release with a failing `npm run scan`. It is the same rule set n8n runs
  for verification, and a failure there is a rejected submission.
- Do not under-bump. A renamed node type in a PATCH release detaches workflows
  silently.
- Do not publish from a laptop. n8n requires provenance from GitHub Actions, and
  a local `npm publish` produces none.
- Respect branch protection; no surprise tags.

## Related files

| Topic | Location |
| --- | --- |
| Human steps | [README.md § Releasing](../../README.md) |
| Publish workflow | [.github/workflows/publish.yml](../../.github/workflows/publish.yml) |
| CI | [.github/workflows/ci.yml](../../.github/workflows/ci.yml) |
| Live API tests | [.github/workflows/integration.yml](../../.github/workflows/integration.yml) |
| Change history | [CHANGELOG.md](../../CHANGELOG.md) |
| Notes template | [references/release-notes-template.md](references/release-notes-template.md) |
