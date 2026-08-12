import type { INodeProperties } from 'n8n-workflow';

import { SOURCE_TYPE_OPTIONS } from '../SourceTypes';

/**
 * Property builders.
 *
 * Seven resources share the same handful of shapes — an ID field, a
 * "return all / limit" pair, a filter collection. Building them keeps the
 * declarations honest: a change to how limits work happens in one place rather
 * than in seven near-identical literals.
 */

function idProperty(
	resource: string,
	operations: string[],
	displayName: string,
	description: string,
): INodeProperties {
	return {
		displayName,
		name: 'id',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { resource: [resource], operation: operations } },
		description,
	};
}

function paginationProperties(resource: string): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			displayOptions: { show: { resource: [resource], operation: ['getAll'] } },
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			displayOptions: {
				show: { resource: [resource], operation: ['getAll'], returnAll: [false] },
			},
			description: 'Max number of results to return',
		},
	];
}

function filterProperty(resource: string, options: INodeProperties[]): INodeProperties {
	return {
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: [resource], operation: ['getAll'] } },
		options,
	};
}

export const resourceProperty: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	default: 'event',
	options: [
		{ name: 'Attempt', value: 'attempt' },
		{ name: 'Connection', value: 'connection' },
		{ name: 'Destination', value: 'destination' },
		{ name: 'Event', value: 'event' },
		{ name: 'Issue', value: 'issue' },
		{ name: 'Request', value: 'request' },
		{ name: 'Source', value: 'source' },
	],
};

// ─── Event ────────────────────────────────────────────────────────────────────

export const eventProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'get',
		displayOptions: { show: { resource: ['event'] } },
		options: [
			{ name: 'Cancel', value: 'cancel', description: 'Stop retrying an event', action: 'Cancel an event' },
			{ name: 'Get', value: 'get', description: 'Retrieve an event', action: 'Get an event' },
			{ name: 'Get Many', value: 'getAll', description: 'Retrieve many events', action: 'Get many events' },
			{ name: 'Mute', value: 'mute', description: 'Mute a failed event', action: 'Mute an event' },
			{ name: 'Retry', value: 'retry', description: 'Retry delivery of an event', action: 'Retry an event' },
		],
	},
	idProperty('event', ['get', 'retry', 'mute', 'cancel'], 'Event ID', 'ID of the event'),
	...paginationProperties('event'),
	filterProperty('event', [
		{
			displayName: 'Status',
			name: 'status',
			type: 'options',
			default: 'FAILED',
			options: [
				{ name: 'Cancelled', value: 'CANCELLED' },
				{ name: 'Failed', value: 'FAILED' },
				{ name: 'Hold', value: 'HOLD' },
				{ name: 'Queued', value: 'QUEUED' },
				{ name: 'Scheduled', value: 'SCHEDULED' },
				{ name: 'Successful', value: 'SUCCESSFUL' },
			],
			description: 'Only return events with this delivery status',
		},
		{
			displayName: 'Source ID',
			name: 'source_id',
			type: 'string',
			default: '',
			description: 'Only return events from this source',
		},
		{
			displayName: 'Destination ID',
			name: 'destination_id',
			type: 'string',
			default: '',
			description: 'Only return events sent to this destination',
		},
		{
			displayName: 'Search Term',
			name: 'search_term',
			type: 'string',
			default: '',
			description: 'Free-text search across the event',
		},
	]),
];

// ─── Attempt ──────────────────────────────────────────────────────────────────

export const attemptProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'get',
		displayOptions: { show: { resource: ['attempt'] } },
		options: [
			{ name: 'Get', value: 'get', description: 'Retrieve a delivery attempt', action: 'Get an attempt' },
			{ name: 'Get Many', value: 'getAll', description: 'Retrieve many delivery attempts', action: 'Get many attempts' },
		],
	},
	idProperty('attempt', ['get'], 'Attempt ID', 'ID of the delivery attempt'),
	...paginationProperties('attempt'),
	filterProperty('attempt', [
		{
			displayName: 'Event ID',
			name: 'event_id',
			type: 'string',
			default: '',
			description: 'Only return attempts for this event',
		},
	]),
];

// ─── Issue ────────────────────────────────────────────────────────────────────

export const issueProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'get',
		displayOptions: { show: { resource: ['issue'] } },
		options: [
			{ name: 'Dismiss', value: 'dismiss', description: 'Ignore an issue', action: 'Dismiss an issue' },
			{ name: 'Get', value: 'get', description: 'Retrieve an issue', action: 'Get an issue' },
			{ name: 'Get Many', value: 'getAll', description: 'Retrieve many issues', action: 'Get many issues' },
			{ name: 'Update', value: 'update', description: 'Change the status of an issue', action: 'Update an issue' },
		],
	},
	idProperty('issue', ['get', 'update', 'dismiss'], 'Issue ID', 'ID of the issue'),
	{
		displayName: 'Status',
		name: 'status',
		type: 'options',
		default: 'ACKNOWLEDGED',
		required: true,
		displayOptions: { show: { resource: ['issue'], operation: ['update'] } },
		options: [
			{ name: 'Acknowledged', value: 'ACKNOWLEDGED' },
			{ name: 'Ignored', value: 'IGNORED' },
			{ name: 'Opened', value: 'OPENED' },
			{ name: 'Resolved', value: 'RESOLVED' },
		],
		description: 'New status for the issue',
	},
	...paginationProperties('issue'),
	filterProperty('issue', [
		{
			displayName: 'Status',
			name: 'status',
			type: 'options',
			default: 'OPENED',
			options: [
				{ name: 'Acknowledged', value: 'ACKNOWLEDGED' },
				{ name: 'Ignored', value: 'IGNORED' },
				{ name: 'Opened', value: 'OPENED' },
				{ name: 'Resolved', value: 'RESOLVED' },
			],
			description: 'Only return issues with this status',
		},
	]),
];

// ─── Request ──────────────────────────────────────────────────────────────────

export const requestProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'get',
		displayOptions: { show: { resource: ['request'] } },
		options: [
			{ name: 'Get', value: 'get', description: 'Retrieve an ingested request', action: 'Get a request' },
			{ name: 'Get Many', value: 'getAll', description: 'Retrieve many ingested requests', action: 'Get many requests' },
			{ name: 'Retry', value: 'retry', description: 'Create new events from a request', action: 'Retry a request' },
		],
	},
	idProperty('request', ['get', 'retry'], 'Request ID', 'ID of the ingested request'),
	...paginationProperties('request'),
	filterProperty('request', [
		{
			displayName: 'Source ID',
			name: 'source_id',
			type: 'string',
			default: '',
			description: 'Only return requests received by this source',
		},
		{
			displayName: 'Status',
			name: 'status',
			type: 'options',
			// Lowercase, unlike every other status enum in the Hookdeck API.
			default: 'accepted',
			options: [
				{ name: 'Accepted', value: 'accepted' },
				{ name: 'Rejected', value: 'rejected' },
			],
			description: 'Only return requests Hookdeck accepted or rejected',
		},
		{
			displayName: 'Search Term',
			name: 'search_term',
			type: 'string',
			default: '',
			description: 'Free-text search across the request',
		},
	]),
];

// ─── Connection ───────────────────────────────────────────────────────────────

export const connectionProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'getAll',
		displayOptions: { show: { resource: ['connection'] } },
		options: [
			{ name: 'Delete', value: 'delete', description: 'Delete a connection', action: 'Delete a connection' },
			{ name: 'Get', value: 'get', description: 'Retrieve a connection', action: 'Get a connection' },
			{ name: 'Get Many', value: 'getAll', description: 'Retrieve many connections', action: 'Get many connections' },
			{ name: 'Pause', value: 'pause', description: 'Hold delivery and queue events', action: 'Pause a connection' },
			{ name: 'Unpause', value: 'unpause', description: 'Resume delivery of queued events', action: 'Unpause a connection' },
		],
	},
	idProperty(
		'connection',
		['get', 'delete', 'pause', 'unpause'],
		'Connection ID',
		'ID of the connection',
	),
	...paginationProperties('connection'),
	filterProperty('connection', [
		{
			displayName: 'Name',
			name: 'name',
			type: 'string',
			default: '',
			description: 'Only return the connection with this name',
		},
	]),
];

// ─── Source ───────────────────────────────────────────────────────────────────

export const sourceProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'getAll',
		displayOptions: { show: { resource: ['source'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Create a source and return its public URL',
				action: 'Create a source',
			},
			{ name: 'Get', value: 'get', description: 'Retrieve a source', action: 'Get a source' },
			{ name: 'Get Many', value: 'getAll', description: 'Retrieve many sources', action: 'Get many sources' },
			{
				name: 'Get URL',
				value: 'getUrl',
				description: 'Retrieve the public URL to give a provider',
				action: 'Get the URL of a source',
			},
		],
	},
	idProperty('source', ['get'], 'Source ID', 'ID of the source'),
	{
		displayName: 'Name',
		name: 'sourceName',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'stripe-production',
		displayOptions: { show: { resource: ['source'], operation: ['create'] } },
		description:
			'Name for the new source. Letters, numbers, hyphens and underscores; anything else is replaced.',
	},
	{
		displayName: 'Source Type',
		name: 'sourceType',
		type: 'options',
		default: 'WEBHOOK',
		displayOptions: { show: { resource: ['source'], operation: ['create'] } },
		description:
			'Platform sending events to this source. Choosing a platform applies its signature verification scheme.',
		options: SOURCE_TYPE_OPTIONS,
	},
	{
		displayName: 'Source Config (JSON)',
		name: 'sourceConfigJson',
		type: 'json',
		default: '',
		displayOptions: { show: { resource: ['source'], operation: ['create'] } },
		description:
			'Advanced. Sent as the source config, for verification schemes that need explicit fields, e.g. {"auth_type":"HMAC","auth":{...}}.',
	},
	{
		displayName: 'Source Name',
		name: 'name',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { resource: ['source'], operation: ['getUrl'] } },
		description: 'Name of the source whose URL you want',
	},
	...paginationProperties('source'),
	filterProperty('source', [
		{
			displayName: 'Name',
			name: 'name',
			type: 'string',
			default: '',
			description: 'Only return the source with this name',
		},
	]),
];

// ─── Destination ──────────────────────────────────────────────────────────────

export const destinationProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'getAll',
		displayOptions: { show: { resource: ['destination'] } },
		options: [
			{ name: 'Get', value: 'get', description: 'Retrieve a destination', action: 'Get a destination' },
			{ name: 'Get Many', value: 'getAll', description: 'Retrieve many destinations', action: 'Get many destinations' },
		],
	},
	idProperty('destination', ['get'], 'Destination ID', 'ID of the destination'),
	...paginationProperties('destination'),
	filterProperty('destination', [
		{
			displayName: 'Name',
			name: 'name',
			type: 'string',
			default: '',
			description: 'Only return the destination with this name',
		},
	]),
];
