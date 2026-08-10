import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Everything about an inbound delivery from Hookdeck: proving it is authentic,
 * proving it is readable, and describing it to the workflow.
 *
 * Deliberately free of n8n imports so the rules here can be shared with the
 * Hookdeck plugins for other hosts, which follow the same delivery contract.
 */

/**
 * Header carrying the signature Hookdeck computes for deliveries into n8n.
 *
 * Deliberately *not* `x-hookdeck-signature`. That name belongs to Hookdeck's
 * own project-level signature; reusing it would put two different signatures,
 * made with two different secrets, under one header name. This node sets the
 * header explicitly on the destination, so it is unaffected by the per-project
 * header prefix white-labelling that applies to the metadata headers below.
 */
export const SIGNATURE_HEADER = 'x-hookdeck-n8n-signature';

/** Default prefix for Hookdeck's delivery metadata headers. Configurable per project. */
export const DEFAULT_HEADER_PREFIX = 'x-hookdeck';

/** Delivery metadata Hookdeck attaches to every attempt. */
export interface HookdeckDeliveryMetadata {
	eventId?: string;
	requestId?: string;
	attemptCount?: number;
	attemptTrigger?: string;
	willRetryAfter?: string;
	/**
	 * True when Hookdeck will not retry this event automatically again.
	 *
	 * Hookdeck signals the last automatic attempt by omitting
	 * `will-retry-after`, which makes this the natural condition for routing an
	 * event to a dead-letter branch.
	 */
	isLastAttempt: boolean;
	sourceName?: string;
	connectionName?: string;
	destinationName?: string;
	verified?: string;
	originalIp?: string;
	eventUrl?: string;
	idempotencyKey?: string;
}

/**
 * Pull Hookdeck's delivery metadata out of the request headers.
 *
 * Without this the workflow sees only the payload and cannot tell a first
 * attempt from a fifth, or a normal delivery from the final one before the
 * event is abandoned.
 */
export function extractDeliveryMetadata(
	headers: Record<string, string | string[] | undefined>,
	prefix: string = DEFAULT_HEADER_PREFIX,
): HookdeckDeliveryMetadata {
	const p = prefix.toLowerCase().replace(/-$/, '');
	const read = (suffix: string): string | undefined => {
		const value = headers[`${p}-${suffix}`];
		return Array.isArray(value) ? value[0] : value;
	};

	const rawAttemptCount = read('attempt-count');
	const willRetryAfter = read('will-retry-after');

	// Leave the field absent rather than emitting NaN, which serialises to null
	// and reads as "zero attempts" downstream.
	const parsedAttemptCount = rawAttemptCount === undefined ? NaN : Number(rawAttemptCount);
	const attemptCount = Number.isFinite(parsedAttemptCount) ? parsedAttemptCount : undefined;

	return {
		// Hookdeck spells these without a separator: `eventid`, not `event-id`.
		eventId: read('eventid'),
		requestId: read('requestid'),
		attemptCount,
		attemptTrigger: read('attempt-trigger'),
		willRetryAfter,
		isLastAttempt: !willRetryAfter,
		sourceName: read('source-name'),
		connectionName: read('connection-name'),
		destinationName: read('destination-name'),
		verified: read('verified'),
		originalIp: read('original-ip'),
		eventUrl: read('event-url'),
		idempotencyKey: (() => {
			const value = headers['idempotency-key'];
			return Array.isArray(value) ? value[0] : value;
		})(),
	};
}

/**
 * Whether a request body is well-formed UTF-8.
 *
 * Node never throws on invalid UTF-8 — `Buffer.toString('utf8')` substitutes
 * U+FFFD for each bad byte. When those bytes sit inside a JSON string value the
 * result still parses, so the workflow receives silently corrupted text with no
 * error anywhere. RFC 8259 §8.1 requires JSON exchanged between systems to be
 * UTF-8, so a body that fails this is malformed and worth rejecting outright.
 *
 * The check is a re-encode comparison: only well-formed UTF-8 survives a
 * decode/encode round trip byte for byte.
 */
export function isValidUtf8(body: Buffer): boolean {
	return Buffer.from(body.toString('utf8'), 'utf8').equals(body);
}

/** Generate a signing secret for the CUSTOM_SIGNATURE destination auth. */
export function generateSigningSecret(): string {
	return randomBytes(32).toString('hex');
}

/**
 * Verify the HMAC-SHA256 signature Hookdeck attaches to each delivery.
 *
 * The header is tolerated in multi-value form — Hookdeck's own signature header
 * carries space-separated values while a secret is rotating — and any one
 * matching is a pass. Base64 contains no spaces, so splitting is safe.
 * Comparison is constant-time.
 */
export function verifySignature(
	rawBody: Buffer | string,
	signatureHeader: string | undefined,
	signingSecret: string,
): boolean {
	if (!signatureHeader) return false;

	// Hash the bytes exactly as they arrived. Decoding to a string first would
	// be wrong for any body that is not valid UTF-8: `Buffer.toString('utf8')`
	// silently substitutes U+FFFD, so re-encoding yields different bytes and a
	// genuinely signed payload would be rejected as forged.
	const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
	const expected = createHmac('sha256', signingSecret).update(bytes).digest('base64');
	const expectedBuffer = Buffer.from(expected);

	return signatureHeader
		.split(' ')
		.filter(Boolean)
		.some((candidate) => {
			const candidateBuffer = Buffer.from(candidate);
			if (candidateBuffer.length !== expectedBuffer.length) return false;
			return timingSafeEqual(candidateBuffer, expectedBuffer);
		});
}
