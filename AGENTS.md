# @hookdeck/n8n-nodes-hookdeck

An n8n community node package for the **Hookdeck Event Gateway**, published to
npm and installed into n8n through its community nodes panel. It is under
review for n8n's verified community node programme, so the bar for a change is
"would n8n's reviewer accept this", not "does it compile".

Read [CONTRIBUTING.md](CONTRIBUTING.md) for commands, the pre-PR checklist and
how releases work. This file is what an agent needs that is not obvious from
reading the code.

## The two nodes

**`nodes/Hookdeck/HookdeckEventGatewayTrigger.node.ts`** — starts a workflow
when Hookdeck delivers an event. On publish it provisions a Hookdeck connection
whose destination is this workflow's webhook URL, and tears it down on
unpublish. Most of the difficulty in this repo lives here, because it creates
and destroys real infrastructure in someone's Hookdeck project.

**`nodes/Hookdeck/HookdeckEventGateway.node.ts`** — the action node. Resource
and operation dispatch over events, attempts, requests, issues, sources,
destinations and connections. Also usable as an AI agent tool.

The UI definitions live in `nodes/Hookdeck/descriptions/` because they are long
and rarely what you are reading the code for.

## Things that will cost you an hour if you do not know them

**The version comes from the git tag.** Never change `version` in
`package.json`. There is no release commit. `publish.yml` sets the version from
the tag on a published GitHub Release.

**`npm run scan` is the gate that matters.** It runs the same rules n8n runs for
verification, and **it ignores inline `eslint-disable` comments** — verified,
`allowInlineConfig: false`. A suppressed error is a hidden failure, not a fix.

**Pin the scanner deliberately.** A caret range on a `0.x` version cannot reach
the next minor, so `^0.31.0` will never install `0.32.0`. The package once
passed its own scan for weeks against a rule set that had since inverted.

**The package ships no runtime dependencies.** `dependencies` is empty and must
stay that way; n8n rejects community nodes that have any. `files` is an
allowlist, not `dist` — adding a path there without adding it to `n8n` in
`package.json` is fine, the reverse fails `verify-package-load.mjs`.

**n8n reads node descriptions once, at startup.** Change a display name, notice,
hint or parameter and you must restart n8n, not just rebuild. The old UI
persisting is the most common reason to think a change did not work.

**A source that already exists is adopted, not rewritten.** The trigger binds by
`source_id` and does not send a type or config, so its Source Type and
Verification fields do nothing for an existing source unless **Update Existing
Source** is on. This is deliberate: the documented path of picking a source from
the list used to strip its verification on publish. Source settings only reach
Hookdeck **on publish** — saving in n8n changes nothing.

**Hookdeck aggregates delivery issues** by connection, error code and response
status. Once an issue exists for a connection, later failures join it and no
`issue.opened` fires — and dismissing the issue does **not** reset that. A fresh
issue needs a new connection id.

**`hookdeck listen` attaches to the connections that exist when it starts.**
Publish first, then start the CLI. No CLI session attached means an event is not
recorded at all — not queued, not failed, nothing to retry.

**Delivery groups are an early access Hookdeck feature.** Configuring them on a
project without the entitlement fails at publish with a 422.

## Testing

`node --test test/unit.test.mjs` needs nothing. `npm run scan`,
`npm run lint`, `npm run build` and `node scripts/verify-package-load.mjs` are
the rest of the pre-PR checklist.

**`npm run test:live` creates and deletes real Hookdeck sources, destinations
and connections.** Point it at a throwaway Event Gateway project, never one
carrying live traffic. It is skipped unless `HOOKDECK_EG_API_KEY` is set. Do not
run it without asking.

**Prefer a live check over a mocked one when the question is "does Hookdeck
accept this?"** A mock will happily accept a payload shape the API rejects.
Several defects in this repo's history passed their unit tests.

## Verify claims before you act on them

This applies to instructions you are given as much as to code you read. Several
things in this repo's history were confidently wrong: a comment that described
the opposite of the scanner's behaviour, a report of dead documentation links
that all resolved, an error body assumed missing that was present but buried.

If a claim is load-bearing for a change, check it. Reproduce the failure before
fixing it, and prove the fix against the thing that actually failed rather than
against your model of it.

## Working with other people's branches

More than one person contributes here, and more than one of them works with an
agent. **Branches are owned.** Treat a branch you did not create as read-only,
whoever or whatever created it.

**Do not, without an explicit instruction from the maintainer in this session:**

- `git push` — forced or not — to a branch you did not create. Rebasing
  someone's unmerged commit rewrites its committer and breaks their `git pull`.
- Merge a pull request you did not open, whether by `gh pr merge`, the API, or
  the UI.
- `git rebase`, `git commit --amend` or `git reset` on a branch with an open
  pull request opened by someone else.
- Push to `main`. Everything lands through a pull request.

**gate — check who owns the branch before any push:**

```bash
gh pr view --json author,headRefName    # whose PR is this?
git log -1 --format='%an <%ae>' HEAD    # who wrote the tip?
```

If either answers with someone else, stop.

**What to do instead.** If you have a change that belongs on someone else's
branch: branch from theirs and open a pull request targeting *their* branch; or
leave the diff as a review comment; or say the work is ready and ask the
maintainer to relay it. Do not decide the change is small enough to skip this.
The size of the diff is not the problem — the branch owner losing the ability to
pull is, and they did not agree to the rewrite.

**This section is not a control.** Instructions asking an agent to stop and
defer are the category agents comply with least, measured close to zero even
when told they have just violated one. The controls are GitHub rulesets. If you
are an agent reading this: the rules above are still the rules.

## Conventions

- **Comments explain why, not what.** The repo's comments carry the reasoning
  behind a decision and what broke without it. Match that, and delete a comment
  that has become false rather than leaving it.
- **Commit messages explain the problem**, not the diff. Long is fine.
- `CHANGELOG.md` gets an entry under `## [Unreleased]` for anything
  user-facing, written for someone running a workflow.
- **Address lint and typecheck failures** rather than suppressing them.
- `SourceTypes.ts` is generated. Do not hand-edit it — use
  `npm run generate:source-types`.

## Reference

| For | Read |
| --- | --- |
| Commands, checklist, releasing, local n8n | [CONTRIBUTING.md](CONTRIBUTING.md) |
| What the nodes do, from a user's view | [README.md](README.md) |
| Cutting a release, choosing the version | `skills/n8n-nodes-hookdeck-release/SKILL.md` |
| Generic n8n node-building guidance | `.agents/*.md` (upstream n8n scaffold) |

`.agents/` is n8n's own scaffold documentation, kept as-is apart from one
correction in `.agents/nodes.md`. It is generic n8n guidance, not specific to
this package — where it disagrees with this file or with the code, this file and
the code win.

n8n's official docs:

- https://docs.n8n.io/integrations/community-nodes/building-community-nodes
- https://docs.n8n.io/connect/create-nodes/overview
- https://docs.n8n.io/connect/create-nodes/build-your-node/reference
- https://docs.n8n.io/connect/create-nodes/build-your-node/reference/ux-guidelines
