import type { INodeProperties } from 'n8n-workflow';

/** The shape n8n accepts for `displayOptions.show`. */
type ShowConditions = NonNullable<INodeProperties['displayOptions']>['show'];

import { SOURCE_TYPE_OPTIONS } from '../SourceTypes';

/**
 * The fields that describe a Hookdeck source: its platform type and how
 * Hookdeck verifies what arrives at it.
 *
 * Shared because both nodes create sources and both should ask the same
 * questions. The trigger creates one when it provisions a connection; the
 * action node's Source > Get or Create creates one directly. Before this was
 * shared, the action node offered only a raw JSON config field, so creating a
 * verified Stripe source there meant hand-writing
 * `{"auth_type":"STRIPE","auth":{"webhook_secret_key":"..."}}` while the
 * trigger two nodes away had a labelled secret field for it.
 *
 * `extraShow` is merged into every field's `displayOptions.show`. The trigger
 * shows these unconditionally; the action node needs them gated on its resource
 * and operation, and n8n has no way to express that from the outside.
 */
export function sourceConfigProperties(extraShow: ShowConditions = {}): INodeProperties[] {
	const fields: INodeProperties[] = [
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
	];

	if (Object.keys(extraShow).length === 0) return fields;

	return fields.map((field) => ({
		...field,
		displayOptions: {
			...field.displayOptions,
			show: { ...extraShow, ...(field.displayOptions?.show ?? {}) },
		},
	}));
}
