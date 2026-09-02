/**
 * The request body sent to Hookdeck when provisioning a connection: the source
 * to receive on, the destination to deliver to, and the rules that govern
 * retries and deduplication.
 *
 * Kept apart from the node because this is the part most likely to change as
 * the Hookdeck API evolves, and it is easier to review in isolation.
 */
import type { IDataObject, IHookFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { SIGNATURE_HEADER } from './Delivery';
import { webhookPathFor } from './Naming';
import { SOURCE_TYPE_AUTH } from './SourceTypes';

/** Field a platform's verification secret belongs in. */
const DEFAULT_PLATFORM_AUTH_FIELD = 'webhook_secret_key';

/**
 * Resolve which auth field a single supplied secret should populate.
 *
 * Most platforms name it `webhook_secret_key`, but a sizeable minority use
 * `api_key`, `public_key` or similar, and a secret in the wrong field is
 * rejected by the API at activation. Three cases cannot be served by a single
 * input at all — a type needing several values, one accepting a choice of
 * schemes, and one taking no secret — and each is refused with the guidance that
 * fits it, rather than being allowed through to surface as a 422.
 */
function platformAuthField(this: SourceConfigContext, sourceType: string): string {
	const shape = SOURCE_TYPE_AUTH[sourceType];

	// Not in the map at all: an unknown or newer type. The common field is the
	// best available guess, and the API says so plainly if it is wrong.
	if (!shape) return DEFAULT_PLATFORM_AUTH_FIELD;

	if (shape.kind === 'none') {
		throw new NodeOperationError(
			this.getNode(),
			`${sourceType} does not take a verification secret`,
			{
				description:
					'Leave Webhook Secret empty. Hookdeck verifies this platform without one, and sending a secret it does not expect is rejected.',
			},
		);
	}

	if (shape.kind === 'choice') {
		throw new NodeOperationError(
			this.getNode(),
			`${sourceType} accepts a choice of verification schemes, so a single secret cannot say which one to use`,
			{
				description:
					'Clear Webhook Secret and set Options → Source Config (JSON) to {"auth_type": "HMAC", "auth": { … }}, naming the scheme you want.',
			},
		);
	}

	if (shape.fields.length === 1) return shape.fields[0];

	throw new NodeOperationError(
		this.getNode(),
		`${sourceType} verification needs more than one value, so Webhook Secret cannot express it`,
		{
			description: `Clear Webhook Secret and set Options → Source Config (JSON) to {"auth_type": "${sourceType}", "auth": {${shape.fields
				.map((f) => `"${f}": "…"`)
				.join(', ')}}}.`,
		},
	);
}

/**
 * Translate the node's verification parameters into a Hookdeck source config.
 *
 * Platform source types carry their own verification scheme, so they only need
 * the secret. The generic `WEBHOOK` type spells the scheme out explicitly.
 */
/**
 * What `buildSourceConfig` and `platformAuthField` need from their caller.
 *
 * Deliberately narrower than `IHookFunctions`. The trigger calls these while
 * provisioning, where parameters are read without an item index; the action
 * node calls them from `execute`, where they are read *with* one. Typing the
 * context structurally lets the action node pass a small shim that closes over
 * its item index, instead of this file having to know which node it is serving.
 */
export type SourceConfigContext = {
	getNode: IHookFunctions['getNode'];
	getNodeParameter(name: string, fallback?: unknown): unknown;
};

export function buildSourceConfig(
	this: SourceConfigContext,
	sourceType: string,
	options: IDataObject,
): IDataObject {
	const config: IDataObject = {};

	if (sourceType === 'WEBHOOK') {
		const verification = this.getNodeParameter('verification') as string;

		if (verification === 'HMAC') {
			config.auth_type = 'HMAC';
			config.auth = {
				webhook_secret_key: this.getNodeParameter('hmacSecret') as string,
				header_key: this.getNodeParameter('hmacHeaderKey') as string,
				algorithm: this.getNodeParameter('hmacAlgorithm') as string,
				encoding: this.getNodeParameter('hmacEncoding') as string,
			};
		} else if (verification === 'API_KEY') {
			config.auth_type = 'API_KEY';
			config.auth = {
				header_key: this.getNodeParameter('authHeaderName') as string,
				api_key: this.getNodeParameter('apiKeyValue') as string,
			};
		} else if (verification === 'BASIC_AUTH') {
			config.auth_type = 'BASIC_AUTH';
			config.auth = {
				username: this.getNodeParameter('basicAuthUsername') as string,
				password: this.getNodeParameter('basicAuthPassword') as string,
			};
		}
	} else {
		const platformSecret = this.getNodeParameter('platformSecret', '') as string;
		if (platformSecret) {
			config.auth_type = sourceType;
			config.auth = { [platformAuthField.call(this, sourceType)]: platformSecret };
		}
	}

	// Escape hatch for verification schemes that need a shape the fields above
	// cannot express. Applied last so it wins.
	const raw = options.sourceConfigJson as string | IDataObject | undefined;
	if (raw) {
		let parsed: IDataObject;
		try {
			parsed = typeof raw === 'string' ? (JSON.parse(raw) as IDataObject) : raw;
		} catch {
			throw new NodeOperationError(this.getNode(), 'Source Config (JSON) is not valid JSON');
		}
		Object.assign(config, parsed);
	}

	return config;
}

/**
 * Options that only an HTTP destination can honour.
 *
 * Hookdeck gives the CLI destination type `CUSTOM_CLI_PATH` and nothing else;
 * `MAX_DELIVERY_RATE` and `delivery_groups` belong to HTTP. Sending them to a
 * CLI destination is not an error to fail on, but a user who set a rate limit
 * deserves to be told it is not in force.
 */
export function optionsUnsupportedOverCli(options: IDataObject): string[] {
	const unsupported: string[] = [];
	if (options.rateLimit) unsupported.push('Delivery Rate Limit');
	if (options.deliveryGroupKey) unsupported.push('Delivery Group Key');
	return unsupported;
}

/**
 * Describe the destination Hookdeck should deliver this workflow's events to.
 *
 * Two shapes, chosen by whether Hookdeck can reach n8n:
 *
 * - `HTTP` — Hookdeck makes a request to n8n's webhook URL. Needs n8n to be
 *   reachable from the public internet.
 * - `CLI` — `hookdeck listen` holds a connection open from the operator's
 *   machine and Hookdeck sends events down it. Nothing has to reach *in*, which
 *   is what makes a local or NAT'd n8n work at all.
 *
 * Both are signed identically. CUSTOM_SIGNATURE is used rather than
 * HOOKDECK_SIGNATURE because the secret is generated and stored here, so
 * verification needs no extra API call to look up a project-wide signing key —
 * and a CLI destination accepts it exactly as an HTTP one does, so the delivery
 * the workflow verifies is the same either way.
 */
export function buildDestination(
	webhookUrl: string,
	signingSecret: string,
	options: IDataObject,
	viaCli: boolean,
): { type: 'HTTP' | 'CLI'; config: IDataObject } {
	const auth = {
		auth_type: 'CUSTOM_SIGNATURE',
		auth: {
			key: SIGNATURE_HEADER,
			signing_secret: signingSecret,
		},
		// Hookdeck appends the source request's path to the destination unless
		// this is set, and it defaults to false. n8n matches its webhook path
		// exactly, so a provider posting to <source-url>/events would be delivered
		// to <webhook-url>/events and 404 — then retry until the event is
		// exhausted. Nothing here benefits from path forwarding.
		path_forwarding_disabled: true,
	};

	if (viaCli) {
		// Only the path: the CLI supplies the host and port when it connects, and
		// the rate limiting options below are not part of this destination type.
		return { type: 'CLI', config: { path: webhookPathFor(webhookUrl), ...auth } };
	}

	const config: IDataObject = { url: webhookUrl, ...auth };

	const rateLimit = options.rateLimit as number | undefined;
	if (rateLimit) {
		config.rate_limit = rateLimit;
		config.rate_limit_period = (options.rateLimitPeriod as string) ?? 'second';
	}

	// Rate limit each group of events independently, so one busy customer or
	// repository cannot crowd out the rest.
	//
	// Note this is a rate limit, not a concurrency lock: `delivery_groups` accepts
	// only second/minute/hour, so it cannot express "one at a time". The
	// destination-level Delivery Rate Limit is the setting that supports
	// `concurrent`, and it applies across all groups.
	const groupKey = options.deliveryGroupKey as string | undefined;
	if (groupKey) {
		config.delivery_groups = {
			key: groupKey,
			rate_limit: (options.deliveryGroupRateLimit as number) ?? 1,
			rate_limit_period: (options.deliveryGroupRatePeriod as string) ?? 'second',
		};
	}

	return { type: 'HTTP', config };
}

/**
 * Defaults applied when the user has not opened Options.
 *
 * These cannot live in the option definitions: n8n's `collection` type only
 * carries values the user explicitly added, so a default declared there never
 * reaches the node and the connection would be provisioned with no rules at
 * all. An event gateway in front of n8n that does not retry is pointless.
 */
const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_RETRY_INTERVAL_MS = 60000;
const DEFAULT_RETRY_STRATEGY = 'exponential';
const DEFAULT_DEDUPLICATE_WINDOW_MS = 60000;

/** Build the connection rules that give Hookdeck its retry and dedup behaviour. */
export function buildRules(options: IDataObject): IDataObject[] {
	const rules: IDataObject[] = [];

	const retryCount = (options.retryCount as number | undefined) ?? DEFAULT_RETRY_COUNT;
	if (retryCount > 0) {
		rules.push({
			type: 'retry',
			strategy: (options.retryStrategy as string) ?? DEFAULT_RETRY_STRATEGY,
			count: retryCount,
			interval: (options.retryInterval as number) ?? DEFAULT_RETRY_INTERVAL_MS,
			// Server errors and rate limiting must be retryable, otherwise an n8n
			// instance that is briefly down or shedding load drops events for good.
			response_status_codes: ['500-599', '429'],
		});
	}

	const window =
		(options.deduplicateWindow as number | undefined) ?? DEFAULT_DEDUPLICATE_WINDOW_MS;
	// Hookdeck's floor is 1000ms; anything lower (including the 0 that turns the
	// rule off) means no deduplication.
	if (window >= 1000) {
		rules.push({ type: 'deduplicate', window });
	}

	return rules;
}
