# Contributing

Thanks for looking at this. The nodes are small, but they provision real
infrastructure in someone's Hookdeck project on workflow activation, so most of
the care here is about what happens on the boundary — activation, deactivation,
and an inbound delivery — rather than about the code shape.

[README.md](README.md) documents the nodes from a user's point of view. This
file covers building, testing and releasing them.

## Layout

```
credentials/
  HookdeckEventGatewayApi.credentials.ts API key credential and its test request
nodes/Hookdeck/
  HookdeckEventGatewayTrigger.node.ts    trigger: provisioning lifecycle + delivery handling
  HookdeckEventGateway.node.ts           action node: resource/operation dispatch
  descriptions/
    TriggerProperties.ts                 trigger UI
    ActionProperties.ts                  action node UI
  ConnectionPayload.ts                   what we ask Hookdeck to provision
  Registration.ts                        what the trigger persists between activations
  Delivery.ts                            verifying and describing an inbound delivery
  Naming.ts                              Hookdeck naming rules, reachability checks
  GenericFunctions.ts                    HTTP transport, error mapping, pagination
  SourceTypes.ts                         generated source-type list (do not hand-edit)
```

The UI definitions live apart from the nodes because they are long and rarely
the thing you are reading the code for. `Delivery.ts` and `Naming.ts` are free
of n8n imports on purpose — they encode Hookdeck's rules rather than n8n's, and
are shared with the Hookdeck plugins for other hosts.

## Commands

```bash
npm install
npm run build
npm test          # builds, then runs the unit suite with node:test
npm run lint      # n8n's community-node rules
npm run scan      # the same checks n8n runs when reviewing for verification
npm run verify:load  # loads the built package the way n8n loads it

HOOKDECK_EG_API_KEY=... npm run test:live          # live tests against the API

npm run generate:source-types   # rewrite SourceTypes.ts from Hookdeck's OpenAPI spec
npm run check:source-types      # fail if it has drifted from the spec
```

`SourceTypes.ts` is generated, so the platform types and their auth shapes are
never hand-maintained. A scheduled workflow runs `check:source-types` weekly
rather than blocking every pull request, because the spec is a live third-party
document and a Hookdeck release would otherwise fail unrelated CI.

The integration suite is skipped unless `HOOKDECK_EG_API_KEY` is set, so the
default `npm test` needs no credentials. It creates and deletes real sources,
destinations and connections — point it at a throwaway Event Gateway project,
never one carrying live traffic. In CI it runs from a repository secret of the
same name, and is skipped for pull requests from forks, which cannot read it.

`npm run scan` is the one that matters before submitting: it runs
`@n8n/scan-community-package` against this working tree, with inline
`eslint-disable` comments ignored exactly as the real review does.

## Before opening a pull request

CI runs these on every pull request, so running them locally first is the
fastest way to avoid a round trip:

```bash
npm run lint
npm run build
npm run scan
node scripts/verify-package-load.mjs
node --test "test/unit.test.mjs"
```

`verify-package-load.mjs` is worth understanding, because unit tests
structurally cannot catch what it catches. They import `dist/**` by path, so a
wrong path in `package.json`, a renamed class, a codex file left behind by a
rename, or a `files` entry that omits a new node all pass the suite and then
fail on n8n startup with the whole package missing from the panel. The load
check loads the package the way n8n does, and asserts every file it resolves is
in what `npm pack` would actually publish.

Workflow files are linted too — an invalid one does not fail loudly, GitHub
simply never runs it, so a broken `publish.yml` looks identical to a release
that published nothing.

If you change anything user-facing, add it to `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md).

## Trying the nodes in a real n8n

```bash
npm link
mkdir -p ~/.n8n/custom && cd ~/.n8n/custom && npm init -y && npm link @hookdeck/n8n-nodes-hookdeck
```

Then start n8n with `./scripts/run-n8n.sh`. n8n needs Node 22.22 or newer — the
script checks and refuses otherwise. If your default is older, install one
(`asdf install nodejs 22.23.2`) and point `NODE_BIN` at it rather than changing
the machine default.

Node descriptions are read once at startup, so a change to a display name,
notice, hint or parameter needs n8n restarted before it appears. A rebuild alone
will not do it, and the old UI persisting is the most common reason to think a
change did not work.

No tunnel is needed. Publish the workflow; the node sees that Hookdeck cannot
reach this n8n, provisions a CLI destination, and writes the commands to run to
its server log:

```bash
hookdeck ci --api-key <your Event Gateway project API key>
hookdeck listen 5678 <source> --device-name n8n-<host>-<instance>
```

A tunnel still works if you prefer one — set `WEBHOOK_URL` to the public address
before starting n8n and the node provisions an HTTP destination instead. See
[How events reach n8n](README.md#how-events-reach-n8n) for what differs between
the two.

**Uninstalling through the Public API is a one-way door.** n8n's Public API will
uninstall a community package — `DELETE /api/v1/community-packages/<name>` — but
refuses to install one that is not on its vetted list:
`POST /api/v1/community-packages` answers `Package ... is not vetted for
installation`. The UI has no such check, which is why installing it by hand in
the first place works. Until this package is verified, treat an API uninstall as
irreversible from the API: putting it back means the n8n UI (Settings → Community
nodes), or placing it in `~/.n8n/nodes` and registering it in n8n's database by
hand. Scripts that tear an instance down and expect to build it back up should
not use the API for this step.

## Releasing

Publishing is driven by a **GitHub Release**, not by a tag push and never from a
laptop. n8n requires community nodes to be published from GitHub Actions with an
npm provenance statement, so the publish has to happen in CI.

1. Land everything through PRs, including a release PR that sets `version` in
   [package.json](package.json) to the new version and promotes
   `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) to that same version with a
   date. Both live in the same PR — the version on `main` is what n8n's
   verification review compares against npm.
2. Check `main` is green.
3. Draft the release notes. Write them for someone running a workflow: what
   changes for them, and whether they have to do anything.
4. Create the release against `main`, tagged `vMAJOR.MINOR.PATCH`:

   ```bash
   gh release create v0.2.0 --target main --title v0.2.0 --notes-file notes.md
   ```

   Or use the GitHub UI — Releases → Draft a new release.

Publishing then happens automatically:
[`publish.yml`](.github/workflows/publish.yml) checks out the tag, **fails if
the tag does not match `version` in `package.json`**, then re-runs lint, the
verification scan, the build, the load check and the unit tests, and publishes
with provenance. A release marked **pre-release** publishes under the `beta`
dist-tag instead of `latest`.

`package.json` is the version; the tag only has to agree with it. If the guard
fails, bump `package.json` on `main` in a PR, then delete the release and its
tag and create it again — the workflow runs on `release: published`, so editing
the failed release does not re-run it.

Between releases, `version` in `package.json` is the **last published** version,
not the next one. That is the state n8n's review expects: `main` and npm
matching.

### Choosing the version

SemVer here is about the contract with a **saved workflow**. n8n records the node
type, the credential type and every parameter name inside the user's workflow
JSON, so renaming any of them detaches existing workflows without failing a
build. That is a MAJOR change, whatever it looks like in the diff.

| Change | Bump |
| --- | --- |
| Renamed or removed node type, credential type, parameter, resource or operation; changed output item shape; a default that alters delivery behaviour | MAJOR |
| New resource, operation or option; additive output fields; new source types | MINOR |
| Fixes, wording, icons, tests, CI, dependency bumps | PATCH |

Agents: [`skills/n8n-nodes-hookdeck-release`](skills/n8n-nodes-hookdeck-release/SKILL.md)
carries the full checklist, the gates and a notes template.

### Bootstrapping the package (done once, kept for reference)

npm configures trusted publishers on a package that already exists, so a package
that has never been published cannot use OIDC for its first publish. The name is
claimed by hand once, and everything anyone installs is published from CI with
provenance.

```bash
npm login
RELEASE_MODE=true npm publish --access public --otp=<code>   # claims the name at 0.0.1
npm deprecate @hookdeck/n8n-nodes-hookdeck@0.0.1 --otp=<code> \
  "Placeholder to claim the package name. Use 0.1.0 or later."
```

Both need `--otp` when the npm account has 2FA on. Expect the deprecation to
fail with a `404` for a few minutes after publishing: npm's read path lags
behind the write path on a brand-new package, and `npm access get status` will
report the package as `public` while `npm view` still says it does not exist.

`RELEASE_MODE` is needed because `prepublishOnly` runs a guard that blocks
publishing by hand — this is the one sanctioned exception to it.

Then on npmjs.com: the package → Settings → Trusted Publishers → Add a publisher
→ GitHub Actions, owner `hookdeck`, repository `n8n-nodes-hookdeck`, workflow
`publish.yml`, environment blank, allowed action `npm publish`. Environment must
be blank because `publish.yml` declares no `environment:`, and npm matches the
OIDC claim exactly.

No `NPM_TOKEN` secret is needed and none should be added. npm finds the trusted
publisher itself and exchanges the Actions OIDC token during publish; a token in
`.npmrc` takes precedence over OIDC, so a stale or empty secret quietly becomes
the publishing identity, or fails the publish.

That throwaway `0.0.1` is the only version ever published without provenance,
and it is deprecated the moment it exists. `0.1.0` onwards go through
`publish.yml`.
