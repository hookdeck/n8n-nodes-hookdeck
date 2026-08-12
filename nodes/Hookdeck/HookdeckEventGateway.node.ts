import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	attemptProperties,
	connectionProperties,
	destinationProperties,
	eventProperties,
	issueProperties,
	requestProperties,
	resourceProperty,
	sourceProperties,
} from './descriptions/ActionProperties';
import { hookdeckApiRequest, hookdeckApiRequestAllItems } from './GenericFunctions';
import { sanitizeName } from './Naming';

/**
 * Programmatic style is used rather than declarative because several operations
 * need more than one request-per-item mapping: "Return All" walks Hookdeck's
 * cursor pagination, and "Get URL" resolves a source by name before reading a
 * field off it. Declarative routing cannot express either.
 */
export class HookdeckEventGateway implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hookdeck Event Gateway',
		name: 'hookdeckEventGateway',
		// One file, which `icon-prefer-themed-variants` warns about. The warning is
		// accepted rather than worked around: the mark sits on a solid #0044CC
		// tile and reads identically on a light or a dark canvas, so a second
		// variant would differ in name only. Naming this file for both themes is
		// an `icon-validation` error, and the two byte-identical files this
		// replaced only passed by having different names. A warning is the honest
		// outcome; the verification scan passes either way.
		icon: 'file:hookdeck.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Manage the Hookdeck Event Gateway and inspect delivered events',
		defaults: {
			name: 'Hookdeck Event Gateway',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'hookdeckEventGatewayApi',
				required: true,
			},
		],
		properties: [
			resourceProperty,
			...attemptProperties,
			...connectionProperties,
			...destinationProperties,
			...eventProperties,
			...issueProperties,
			...requestProperties,
			...sourceProperties,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// Errors are already NodeApiError (from the API helper) or
		// NodeOperationError (from parameter validation). Branching on
		// continueOnFail up front lets them propagate with their original type and
		// HTTP context intact, instead of being caught and re-wrapped.
		const tolerateFailure = this.continueOnFail();

		for (let i = 0; i < items.length; i++) {
			if (tolerateFailure) {
				try {
					const results = await executeOperation.call(this, resource, operation, i);
					returnData.push(...toExecutionData(results, i));
				} catch (error) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
				}
			} else {
				const results = await executeOperation.call(this, resource, operation, i);
				returnData.push(...toExecutionData(results, i));
			}
		}

		return [returnData];
	}
}

/** Tag each returned row with the input item it came from, for lineage in the UI. */
function toExecutionData(rows: IDataObject[], itemIndex: number): INodeExecutionData[] {
	return rows.map((json) => ({ json, pairedItem: { item: itemIndex } }));
}

/** Collection path for each resource. */
const RESOURCE_PATH: Record<string, string> = {
	attempt: '/attempts',
	connection: '/connections',
	destination: '/destinations',
	event: '/events',
	issue: '/issues',
	request: '/requests',
	source: '/sources',
};

/**
 * Run one resource/operation pair and return the rows it produced.
 *
 * Always returns an array so list and single-item operations funnel through the
 * same path in `execute`.
 */
async function executeOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<IDataObject[]> {
	const basePath = RESOURCE_PATH[resource];
	if (!basePath) {
		throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`, { itemIndex: i });
	}

	switch (operation) {
		case 'get': {
			const id = this.getNodeParameter('id', i) as string;
			return [await hookdeckApiRequest.call(this, 'GET', `${basePath}/${id}`)];
		}

		case 'getAll': {
			const returnAll = this.getNodeParameter('returnAll', i) as boolean;
			const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
			const limit = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);
			return await hookdeckApiRequestAllItems.call(this, basePath, filters, limit);
		}

		case 'retry':
		case 'mute':
		case 'cancel':
		case 'pause':
		case 'unpause': {
			const id = this.getNodeParameter('id', i) as string;
			// Events use POST for retry; the connection state changes use PUT.
			const method = operation === 'retry' ? 'POST' : 'PUT';
			return [await hookdeckApiRequest.call(this, method, `${basePath}/${id}/${operation}`)];
		}

		case 'delete': {
			const id = this.getNodeParameter('id', i) as string;
			return [await hookdeckApiRequest.call(this, 'DELETE', `${basePath}/${id}`)];
		}

		case 'update': {
			const id = this.getNodeParameter('id', i) as string;
			const status = this.getNodeParameter('status', i) as string;
			return [await hookdeckApiRequest.call(this, 'PUT', `${basePath}/${id}`, { status })];
		}

		case 'dismiss': {
			const id = this.getNodeParameter('id', i) as string;
			// Hookdeck models "dismissed" as the IGNORED status.
			return [
				await hookdeckApiRequest.call(this, 'PUT', `${basePath}/${id}`, { status: 'IGNORED' }),
			];
		}

		case 'create': {
			// Sources are the one resource worth creating from a workflow: the public
			// URL only exists once the source does, and this hands it back as data
			// with copy-on-hover rather than sending the user to the dashboard.
			const requested = this.getNodeParameter('sourceName', i) as string;
			const name = sanitizeName(requested).slice(0, 155);
			if (!name) {
				throw new NodeOperationError(this.getNode(), 'Source Name must not be empty', {
					itemIndex: i,
					description:
						'Use letters, numbers, hyphens or underscores — other characters are removed.',
				});
			}

			// Adopt rather than fail or overwrite. Source names are unique within a
			// project, so a plain create is not safe to re-run: POST /sources answers
			// 409 the second time, which breaks any workflow that runs more than
			// once. PUT would be idempotent but upserts — it rewrites an existing
			// source's type and verification config, which is the exact damage the
			// trigger was changed to stop doing. Returning the existing source
			// unchanged is idempotent and destroys nothing.
			const existing = await hookdeckApiRequestAllItems.call(this, basePath, { name }, 1);
			if (existing.length > 0) return [existing[0]];

			const body: IDataObject = { name, type: this.getNodeParameter('sourceType', i) as string };

			const raw = this.getNodeParameter('sourceConfigJson', i, '') as string | IDataObject;
			if (raw) {
				try {
					body.config = typeof raw === 'string' ? (JSON.parse(raw) as IDataObject) : raw;
				} catch {
					throw new NodeOperationError(this.getNode(), 'Source Config (JSON) is not valid JSON', {
						itemIndex: i,
					});
				}
			}

			return [await hookdeckApiRequest.call(this, 'POST', basePath, body)];
		}

		case 'getUrl': {
			const requested = this.getNodeParameter('name', i) as string;
			// The trigger sanitises the name before creating the source, so the same
			// normalisation has to happen here or "My Source" would never find the
			// "My-Source" it actually created.
			const name = sanitizeName(requested).slice(0, 155);
			const matches = await hookdeckApiRequestAllItems.call(this, '/sources', { name }, 1);
			if (matches.length === 0) {
				const alsoTried = name === requested ? '' : ` (normalised to "${name}")`;
				throw new NodeOperationError(
					this.getNode(),
					`No Hookdeck source named "${requested}"${alsoTried}`,
					{
						itemIndex: i,
						description:
							'Check the name matches a source in the project this API key belongs to. Sources are created when a workflow using the Hookdeck Trigger is activated.',
					},
				);
			}
			return [{ id: matches[0].id, name: matches[0].name, url: matches[0].url }];
		}

		default:
			throw new NodeOperationError(
				this.getNode(),
				`Unsupported operation "${operation}" for resource "${resource}"`,
				{ itemIndex: i },
			);
	}
}
