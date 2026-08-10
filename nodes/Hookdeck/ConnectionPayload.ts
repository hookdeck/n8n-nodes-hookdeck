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
function platformAuthField(this: IHookFunctions, sourceType: string): string {
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
export function buildSourceConfig(
	this: IHookFunctions,
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
 * Sign deliveries into n8n with a secret this node owns.
 *
 * CUSTOM_SIGNATURE is used rather than HOOKDECK_SIGNATURE because the secret is
 * generated and stored here, so verification needs no extra API call to look up
 * a project-wide signing key.
 */
export function buildDestinationConfig(
	webhookUrl: string,
	signingSecret: string,
	options: IDataObject,
): IDataObject {
	const config: IDataObject = {
		url: webhookUrl,
		auth_type: 'CUSTOM_SIGNATURE',
		auth: {
			key: SIGNATURE_HEADER,
			signing_secret: signingSecret,
		},
		// Hookdeck appends the source request's path to the destination URL unless
		// this is set, and it defaults to false. n8n matches its webhook path
		// exactly, so a provider posting to <source-url>/events would be delivered
		// to <webhook-url>/events and 404 — then retry until the event is
		// exhausted. Nothing here benefits from path forwarding.
		path_forwarding_disabled: true,
	};

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

	return config;
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
