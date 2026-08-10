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

[Unreleased]: https://github.com/hookdeck/n8n-nodes-hookdeck/commits/main
