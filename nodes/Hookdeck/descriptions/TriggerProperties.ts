import type { INodeProperties } from 'n8n-workflow';

import { HOOKDECK_DASHBOARD_URL } from '../GenericFunctions';
import { SOURCE_TYPE_OPTIONS } from '../SourceTypes';

/**
 * UI for the Hookdeck Trigger.
 *
 * Kept apart from the node itself so the lifecycle — provisioning, teardown and
 * delivery handling — is readable without scrolling past several hundred lines
 * of form definition.
 */
export const triggerProperties: INodeProperties[] = [
		{
			displayName:
				'Quickest setup: <a href="https://dashboard.hookdeck.com/sources/new" target="_blank">create the source in Hookdeck</a>, copy its URL for your provider, then pick it below. Otherwise name a new source below and click "Test this trigger" (Output panel, right) to create it — then Stop Listening, switch Source to "From list" and re-pick it to see the URL.',
			name: 'setupNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Acknowledgement Mode',
			name: 'ackMode',
			type: 'options',
			default: 'async_retry',
			options: [
				{
					name: 'Async Retry',
					value: 'async_retry',
					description:
						'Acknowledge as soon as the event is received, then run the workflow. Fastest, and the sender never waits.',
				},
				{
					name: 'Sync',
					value: 'sync',
					description:
						'Hold the response until the workflow finishes. A failed run answers with an error so Hookdeck retries it.',
				},
			],
			description:
				'When to answer Hookdeck. Use Sync to have Hookdeck retry runs that fail. Hookdeck stops waiting after 60 seconds, so Sync suits workflows that finish well inside that.',
		},
		{
			displayName: 'Source',
			name: 'source',
			type: 'resourceLocator',
			default: { mode: 'name', value: '' },
			required: true,
			description:
				'The Hookdeck source to receive events on. Pick an existing one to see its public URL, or type a name to create a new one.',
			modes: [
				{
					displayName: 'From List',
					name: 'list',
					type: 'list',
					typeOptions: {
						searchListMethod: 'searchSources',
						searchable: true,
					},
				},
				{
					displayName: 'By Name',
					name: 'name',
					type: 'string',
					placeholder: 'stripe-production',
					hint: 'Reused if it exists, otherwise created. Switch to "From list" and re-select it to see its URL.',
					// A name alone cannot build the source URL — that is keyed on the
					// ID Hookdeck generates. Linking to the sources list at least gives
					// this mode a route to the URL, since otherwise it has none at all.
					url: `=${HOOKDECK_DASHBOARD_URL}/sources`,
					validation: [
						{
							type: 'regex',
							properties: {
								regex: '^[A-Za-z0-9_-]+$',
								errorMessage: 'Use only letters, numbers, hyphens and underscores',
							},
						},
					],
				},
			],
		},
		{
			displayName: 'Source Type',
			name: 'sourceType',
			type: 'options',
			default: 'WEBHOOK',
			description:
				'Platform sending events to this source. This selects which signature scheme Hookdeck uses, but verification only starts once you supply the Webhook Secret below — until then the source accepts unsigned payloads. Use "Webhook (Generic)" to configure verification manually.',
			options: SOURCE_TYPE_OPTIONS,
		},
		{
			displayName: 'Verification',
			name: 'verification',
			type: 'options',
			default: 'none',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
				},
			},
			description: 'How Hookdeck verifies that requests to this source are genuine',
			options: [
				{ name: 'API Key', value: 'API_KEY' },
				{ name: 'Basic Auth', value: 'BASIC_AUTH' },
				{ name: 'HMAC', value: 'HMAC' },
				{ name: 'None', value: 'none' },
			],
		},
		{
			displayName: 'Webhook Secret',
			name: 'platformSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				hide: {
					sourceType: ['WEBHOOK'],
				},
			},
			description:
				'Signing secret issued by the platform. Leave empty to skip verification. Platforms whose verification needs more than a single secret can be configured with Source Config (JSON) under Options.',
		},
		{
			displayName: 'HMAC Secret',
			name: 'hmacSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
					verification: ['HMAC'],
				},
			},
			description: 'Shared secret used to compute the HMAC signature',
		},
		{
			displayName: 'HMAC Header',
			name: 'hmacHeaderKey',
			type: 'string',
			default: 'x-signature',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
					verification: ['HMAC'],
				},
			},
			description: 'Header carrying the signature',
		},
		{
			displayName: 'HMAC Algorithm',
			name: 'hmacAlgorithm',
			type: 'options',
			default: 'sha256',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
					verification: ['HMAC'],
				},
			},
			options: [
				{ name: 'MD5', value: 'md5' },
				{ name: 'SHA1', value: 'sha1' },
				{ name: 'SHA256', value: 'sha256' },
				{ name: 'SHA512', value: 'sha512' },
			],
		},
		{
			displayName: 'HMAC Encoding',
			name: 'hmacEncoding',
			type: 'options',
			default: 'hex',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
					verification: ['HMAC'],
				},
			},
			options: [
				{ name: 'Base64', value: 'base64' },
				{ name: 'Base64URL', value: 'base64url' },
				{ name: 'Hex', value: 'hex' },
			],
		},
		{
			displayName: 'API Key Header',
			name: 'authHeaderName',
			type: 'string',
			default: 'x-api-key',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
					verification: ['API_KEY'],
				},
			},
			description: 'Header carrying the API key',
		},
		{
			displayName: 'API Key',
			name: 'apiKeyValue',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
					verification: ['API_KEY'],
				},
			},
			description: 'Expected API key value',
		},
		{
			displayName: 'Username',
			name: 'basicAuthUsername',
			type: 'string',
			default: '',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
					verification: ['BASIC_AUTH'],
				},
			},
			description: 'Expected basic auth username',
		},
		{
			displayName: 'Password',
			name: 'basicAuthPassword',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: {
					sourceType: ['WEBHOOK'],
					verification: ['BASIC_AUTH'],
				},
			},
			description: 'Expected basic auth password',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			options: [
				{
					displayName: 'Deduplication Window (Ms)',
					name: 'deduplicateWindow',
					type: 'number',
					default: 60000,
					typeOptions: { minValue: 0, maxValue: 3600000 },
					description:
						'Discard repeat events seen within this window, between 1000 and 3600000 ms. Defaults to 60000. Set 0 to turn deduplication off.',
				},
				{
					displayName: 'Delivery Group Key',
					name: 'deliveryGroupKey',
					type: 'string',
					default: '',
					placeholder: 'body.customer_id',
					description:
						'Path in the payload to group deliveries by, so each value gets its own rate limit and one busy sender cannot crowd out the rest. Must start with headers, body, query or path.',
				},
				{
					displayName: 'Delivery Group Rate Limit',
					name: 'deliveryGroupRateLimit',
					type: 'number',
					default: 1,
					typeOptions: { minValue: 1, maxValue: 100000 },
					description: 'Events delivered per period for each group',
				},
				{
					displayName: 'Delivery Group Rate Period',
					name: 'deliveryGroupRatePeriod',
					type: 'options',
					default: 'second',
					options: [
						{ name: 'Hour', value: 'hour' },
						{ name: 'Minute', value: 'minute' },
						{ name: 'Second', value: 'second' },
					],
					description:
						'Period the delivery group rate limit applies over. Concurrency is not available for groups — use Delivery Rate Limit for that.',
				},
				{
					displayName: 'Delivery Rate Limit',
					name: 'rateLimit',
					type: 'number',
					default: 0,
					typeOptions: { minValue: 0 },
					description:
						'Cap on how fast Hookdeck delivers to this workflow. Set 0 for no limit.',
				},
				{
					displayName: 'Delivery Rate Period',
					name: 'rateLimitPeriod',
					type: 'options',
					default: 'second',
					options: [
						{ name: 'Concurrent', value: 'concurrent' },
						{ name: 'Hour', value: 'hour' },
						{ name: 'Minute', value: 'minute' },
						{ name: 'Second', value: 'second' },
					],
					description: 'Period the delivery rate limit applies over',
				},
				{
					displayName: 'Header Prefix',
					name: 'headerPrefix',
					type: 'string',
					default: 'x-hookdeck',
					description:
						'Prefix of the metadata headers Hookdeck adds to each delivery. Change this only if your project uses a white-labelled prefix.',
				},
				{
					displayName: 'On Deactivate',
					name: 'onDeactivate',
					type: 'options',
					default: 'pause',
					options: [
						{
							name: 'Pause the Connection',
							value: 'pause',
							description: 'Hold incoming events in Hookdeck and deliver them on reactivation',
						},
						{
							name: 'Delete the Connection',
							value: 'delete',
							description: 'Remove the connection. Events still queued for it are cancelled.',
						},
					],
					description:
						'What to do when the workflow is deactivated. Pausing holds events durably so a deploy loses nothing; deleting discards anything still queued.',
				},
				{
					displayName: 'Retry Count',
					name: 'retryCount',
					type: 'number',
					default: 5,
					typeOptions: { minValue: 0, maxValue: 50 },
					description: 'How many times Hookdeck retries a failed delivery, up to 50',
				},
				{
					displayName: 'Retry Interval (Ms)',
					name: 'retryInterval',
					type: 'number',
					default: 60000,
					typeOptions: { minValue: 0 },
					description: 'Time between retry attempts',
				},
				{
					displayName: 'Retry Strategy',
					name: 'retryStrategy',
					type: 'options',
					default: 'exponential',
					options: [
						{ name: 'Exponential', value: 'exponential' },
						{ name: 'Linear', value: 'linear' },
					],
					description: 'How the delay between retries is calculated',
				},
				{
					displayName: 'Source Config (JSON)',
					name: 'sourceConfigJson',
					type: 'json',
					default: '',
					description:
						'Advanced. Merged into the source config sent to Hookdeck, overriding the fields above. Use for verification schemes that need more than a single secret.',
				},
				{
					displayName: 'Verify Signature',
					name: 'verifySignature',
					type: 'boolean',
					default: true,
					description:
						'Whether to reject deliveries that are not signed by Hookdeck. Turn off only if your deployment cannot expose the raw request body.',
				},
			],
		},
];
