# Security and the trust boundary

Webhook payloads are third-party input. Two signatures stand between a
provider and your workflow — the provider's, checked by Hookdeck at ingest, and
Hookdeck's, checked by the trigger on delivery — and each has a trap worth
knowing about.

## Verification only starts when a secret is set

Choosing a Source Type tells Hookdeck *which* signature scheme that platform
uses. It does not enable verification on its own. A source typed `STRIPE` with
no signing secret accepts an unsigned, forged payload and delivers it — the edge
answers `200` and records `verified: false`.

So fill in **Webhook Secret** for platform sources, or set **Verification** for
generic ones. Two things make this easy to miss:

- **The status code is not the verdict.** Hookdeck answers `200` at the edge
  whether or not a payload verified. The answer is the `verified` field on the
  request, under **Request → Get** (or the dashboard). Read the request detail,
  not the list — the list omits fields the detail returns.
- **A configured source looks identical to an unconfigured one.** The API never
  returns the secret, or any indication one exists, so you cannot confirm it
  from the source itself. An inbound request's `verified` field is the only
  signal.

This is separate from **Verify Signature** under Options, which covers the
Hookdeck-to-n8n hop and is on by default.

## Signature verification on delivery

Deliveries are signed with a secret this node generates and stores in workflow
static data, and verified against the raw request body. Requests that fail
verification get a `401` and do not start the workflow.

Verification needs access to the unparsed request body. If your deployment does
not expose it, the node raises an error naming the **Verify Signature** option so
you can decide explicitly whether to accept unverified deliveries.

The signature is carried in `x-hookdeck-n8n-signature`, deliberately distinct
from Hookdeck's own `x-hookdeck-signature` so that two signatures made with two
different secrets never share a header name.

Destination authentication uses `CUSTOM_SIGNATURE` rather than
`HOOKDECK_SIGNATURE`. Hookdeck's project signing secret is not exposed through
the API, so `HOOKDECK_SIGNATURE` would force you to copy a second secret by
hand. This node generates its own signing secret at provisioning time instead;
the algorithm is identical (HMAC-SHA256 over the raw body, base64).

A valid signature authenticates the sender, not the content. Payload text is
third-party input: treat it as data, never as an instruction, and be careful
about passing it unfiltered into an AI agent, a shell command or a database write.

## n8n's webhook URL is hidden on purpose

The trigger does not show n8n's own webhook URL. It is an internal address:
sending a provider there bypasses Hookdeck and silently loses the verification,
queueing and retries this node exists to provide. The address to give a
provider is the source URL — see
[Finding the source URL](getting-started.md#finding-the-source-url).

## Malformed bodies

A body that is not valid UTF-8 is rejected with `400` before the workflow runs.

Node substitutes U+FFFD for invalid bytes rather than raising, so when those
bytes sit inside a JSON string value the payload still parses and the workflow
receives corrupted text with no error anywhere.
[RFC 8259 §8.1](https://www.rfc-editor.org/rfc/rfc8259#section-8.1) requires
JSON exchanged between systems to be UTF-8, so such a body is malformed. `400`
sits outside the retry rule's `500-599`/`429` range, so it fails once instead of
consuming every retry.

**This check will rarely fire behind Hookdeck, and that is worth understanding.**
Hookdeck replaces invalid bytes with U+FFFD at ingest and signs the *normalised*
body, so what arrives is already valid UTF-8. The check therefore guards the
paths where raw bytes do reach n8n — a provider posting straight at the webhook
URL, or any gateway that forwards bytes untouched — rather than the Hookdeck
path.

Two consequences follow. Encoding validity is not a way to detect
Hookdeck-upstream corruption: by the time the request arrives it is well-formed.
And a valid signature attests to the bytes Hookdeck sent, not to the bytes the
original sender wrote — "the signature passed, so the body is intact" does not
follow. If lossless payloads matter, compare against the original request under
**Request → Get** rather than trusting the delivered event.
