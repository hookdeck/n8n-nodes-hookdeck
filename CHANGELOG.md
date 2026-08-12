# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Hookdeck Trigger** node. On publish it upserts a Hookdeck connection whose
  destination is this workflow's webhook URL, and tears it down on deactivation.
  Supports 150 source types, HMAC / API key / basic auth verification for
  generic sources, and a JSON escape hatch for schemes the fields cannot express.
- Connection rules applied by default, whether or not Options is opened: five
  exponential retries a minute apart on `500-599` and `429`, and a 60 second
  deduplication window.
- Acknowledgement modes. **Async Retry** answers on receipt; **Sync** holds the
  response until the workflow finishes so a failed run returns 5xx and
  Hookdeck's retry rules apply to the run itself.
- Deactivation **pauses** the connection by default, holding queued events for
  the next activation, rather than deleting it and cancelling them.
- Delivery metadata exposed on every item as `hookdeck` — event ID, attempt
  count, attempt trigger, and `isLastAttempt` for dead-letter branching —
  alongside `body`, `headers` and `query`.
- Signature verification over the raw request bytes, rejecting unsigned or
  mis-signed deliveries with `401`. Bodies that are not valid UTF-8 are rejected
  with `400`, outside the retry range so they fail once.
- Self-healing: if the n8n instance moves host or path, the next activation
  detects the mismatch and re-points the connection instead of duplicating it.
- **Hookdeck** node covering Attempts, Connections, Destinations, Events,
  Issues, Requests and Sources, including Get Source URL and cursor-following
  "Return All".
- **Update Existing Source** option on the trigger, to deliberately apply the
  node's Source Type and Verification to a source that already exists.
- `npm run generate:source-types` and `npm run check:source-types`, which
  generate `SourceTypes.ts` from Hookdeck's OpenAPI schema and detect drift. A
  weekly scheduled workflow runs the check.
- `npm run verify:load`, which loads the built package the way n8n does and
  checks what a rename breaks: declared paths, exported class names, codex node
  types, icons, and credential wiring. Runs in CI.
- Live integration tests (`npm run test:integration`), which run the trigger's
  provisioning against a real Hookdeck project to confirm an existing source
  survives it. Skipped unless `HOOKDECK_EG_API_KEY` is set.

- **Source → Get or Create** on the Hookdeck Event Gateway node, returning the
  source's public URL as workflow data. The URL cannot exist before the source
  does, so this is the way to obtain it without leaving n8n. It gets before
  creating, so it is safe to re-run and never overwrites an existing source.
- **Local Delivery Command** on the trigger, showing the real `hookdeck listen`
  command for this instance and source — actual port, source name and device
  name — rather than a placeholder. On an instance Hookdeck can reach it says
  the CLI is not needed.
- A hint in the trigger's output pane, beside n8n's "Listening for test event",
  saying to keep `hookdeck listen` running. That panel's own text is not
  configurable by a community node, and this is the moment a local n8n needs it.
- A notice on the trigger explaining that a local n8n needs `hookdeck listen`
  running, and that clicking "Execute step" creates a second connection an
  already-running CLI is not attached to. Both notices sit directly above the
  Source field they describe.
- Test connections on the CLI route are disabled rather than deleted when the
  listen window closes, so a running `hookdeck listen` stays attached across
  test runs instead of needing a restart every time. Disabled rather than
  paused, because a paused connection holds events and would deliver the
  backlog on the next test run.
- A link to Hookdeck's create-a-source page beside the trigger's Source field,
  and in the setup notice.
- Two importable example workflows in `examples/`, both run against a real n8n:
  an idempotency gate keyed on `hookdeck.idempotencyKey`, and a dead-letter
  branch routed on `hookdeck.isLastAttempt`.
- Delivery through the Hookdeck CLI when n8n is not reachable from the public
  internet. Activation used to fail with instructions to set up a tunnel; the
  node now provisions a `CLI` destination instead and logs the `hookdeck ci` and
  `hookdeck listen` commands to run. Deliveries are signed identically, so
  signature verification and the workflow's item are unchanged. Applies to any
  unreachable instance, not only local development.
- Delivery Rate Limit and Delivery Group are reported as not applied on the CLI
  route, where Hookdeck does not support them.

### Changed

- Both nodes and the credential are named for the Event Gateway rather than for
  Hookdeck as a whole, leaving room for nodes covering Hookdeck's other
  products: display names **Hookdeck Event Gateway**, **Hookdeck Event Gateway
  Trigger** and **Hookdeck Event Gateway API**, types `hookdeckEventGateway`,
  `hookdeckEventGatewayTrigger` and `hookdeckEventGatewayApi`. Done before the
  first release because these are recorded in saved workflows and credentials.
- The credential is explicit that it takes the API key of a single Event Gateway
  project, and that an Outpost key will not work.
- The trigger now binds to an existing source by ID instead of describing it
  inline in the upsert. Previously, activating a workflow applied the node's
  Source Type and Verification to any source of that name — so publishing
  against an existing verified source rewrote it to the node's defaults
  (`WEBHOOK`, no verification), affecting every other connection fed by it.
  Existing sources are now adopted as they are, and the workflow log names each
  setting that did not apply — including verification entered against a source
  of the same type, which reaches Hookdeck under neither the old behaviour nor
  the new one. Set **Update Existing Source** to opt back in to the old
  behaviour.
- Source type display names now come from the OpenAPI schema, correcting vendor
  casing on 24 of them (`Docusign` → `DocuSign`, `Whatsapp` → `WhatsApp`,
  `Gocardless` → `GoCardless`, and so on).
- `@n8n/node-cli` is pinned to `^0.42.2` rather than floating on `*`, so a build
  is reproducible.

[Unreleased]: https://github.com/hookdeck/n8n-nodes-hookdeck/commits/main
