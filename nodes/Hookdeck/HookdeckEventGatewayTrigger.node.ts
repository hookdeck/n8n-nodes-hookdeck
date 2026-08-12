import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	buildDestination,
	buildRules,
	buildSourceConfig,
	optionsUnsupportedOverCli,
} from './ConnectionPayload';
import {
	DEFAULT_HEADER_PREFIX,
	SIGNATURE_HEADER,
	expectsUtf8,
	extractDeliveryMetadata,
	generateSigningSecret,
	isValidUtf8,
	verifySignature,
} from './Delivery';
import { HOOKDECK_DASHBOARD_URL, hookdeckApiRequest, hookdeckApiRequestAllItems } from './GenericFunctions';
import {
	buildDeviceName,
	buildResourceName,
	describeUnreachableWebhookUrl,
	localPortFor,
	sanitizeName,
} from './Naming';
import { registrationFor } from './Registration';
import type { HookdeckStaticData } from './Registration';
import { triggerProperties } from './descriptions/TriggerProperties';

/** How many sources to show when the list is opened without a search term. */
const BROWSE_SOURCE_LIMIT = 250;

/**
 * Find a source by exact name, or undefined if the project has none.
 *
 * Hookdeck's `?name=` filter is an exact match, but it is still a list endpoint,
 * so the single result has to be read out of the page.
 */
async function findSourceByName(
	this: IHookFunctions,
	name: string,
): Promise<IDataObject | undefined> {
	const matches = await hookdeckApiRequestAllItems.call(this, '/sources', { name }, 1);
	return matches[0];
}

/**
 * Say so when a source's own settings are being left alone.
 *
 * Adopting an existing source means nothing configured here reaches it. That is
 * the safe default, but it is silent — and a user who filled in a Webhook Secret
 * expecting it to take effect deserves to know it did not, rather than
 * discovering it when an unverified payload arrives.
 *
 * Every setting that would otherwise have been sent is checked, not just the
 * type. A source of the *same* type still keeps its own verification, so an HMAC
 * secret entered here does not reach it either — and that case is the easiest to
 * miss, because nothing about it looks unusual.
 */
function warnIgnoredSourceConfig(
	this: IHookFunctions,
	source: IDataObject,
	sourceType: string,
	options: IDataObject,
): void {
	const existingType = source.type as string | undefined;
	const reasons: string[] = [];

	if (existingType !== sourceType) {
		reasons.push(`it is a ${existingType} source rather than ${sourceType}`);
	}

	const configuresVerification =
		sourceType === 'WEBHOOK'
			? (this.getNodeParameter('verification', 'none') as string) !== 'none'
			: (this.getNodeParameter('platformSecret', '') as string) !== '';
	if (configuresVerification) {
		reasons.push('its verification stays as configured in Hookdeck');
	}

	if (options.sourceConfigJson) {
		reasons.push('Source Config (JSON) was not applied');
	}

	if (reasons.length === 0) return;

	this.logger.warn(
		`Hookdeck Trigger: source "${source.name as string}" already exists, so it was used exactly as configured in Hookdeck and this node's source settings were not applied — ${reasons.join(
			'; ',
		)}. Enable Options → "Update Existing Source" to apply them, noting that this changes the source for every connection using it.`,
	);
}

/**
 * The commands that connect a not-publicly-reachable n8n to Hookdeck.
 *
 * `hookdeck ci` comes first deliberately: `hookdeck listen` otherwise uses
 * whichever project the CLI was last logged into, and picking the wrong one
 * fails in a way that looks like the node is broken rather than the CLI being
 * pointed elsewhere.
 */
function describeCliSetup(
	this: IHookFunctions,
	webhookUrl: string,
	sourceName: string,
	connectionName: string,
	reason: string | undefined,
): string {
	const deviceName = buildDeviceName(webhookUrl, this.getInstanceId());
	const port = localPortFor(webhookUrl);

	return [
		`Hookdeck Event Gateway Trigger: ${reason ?? 'This n8n is not reachable from the public internet.'}`,
		'Events will be delivered through the Hookdeck CLI. Run these alongside n8n:',
		'',
		'  hookdeck ci --api-key <your Event Gateway project API key>',
		`  hookdeck listen ${port} ${sourceName} ${connectionName} --device-name ${deviceName}`,
		'',
		'Events arriving while the CLI is not running will fail and be retried; they are not queued indefinitely.',
	].join('\n');
}

export class HookdeckEventGatewayTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hookdeck Event Gateway Trigger',
		name: 'hookdeckEventGatewayTrigger',
		icon: { light: 'file:hookdeck.svg', dark: 'file:hookdeck.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["source"]["value"] || $parameter["source"]}}',
		description: 'Starts a workflow when Hookdeck delivers an event',
		// `eventTriggerDescription` is deliberately unset: n8n substitutes its own
		// "Go to Hookdeck and create an event" for webhook triggers and ignores
		// whatever is set here, so anything put in it never reaches the user.
		activationMessage:
			'Your Hookdeck connection is live. Set Source to "From list" to see the URL to give your provider. If this n8n is not reachable from the internet, the workflow log has the hookdeck listen command needed to receive events.',
		defaults: {
			name: 'Hookdeck Event Gateway Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		// Set because n8n requires it: `node-usable-as-tool` is an error in both
		// the community-node lint rules and the verification scanner, and the
		// scanner ignores inline disables — so omitting it fails verification.
		//
		// It is not, however, harmless. On n8n 2.34.4 this produces a companion
		// `hookdeckEventGatewayTriggerTool` node type with an `ai_tool` output,
		// filed under the AI category, which an agent can select and call.
		// Calling a trigger as a tool does nothing useful — its job is to receive
		// a delivery from Hookdeck, not to be invoked — so the entry is noise at
		// best. There is no way to opt a trigger out and still pass the scan.
		usableAsTool: true,
		credentials: [
			{
				name: 'hookdeckEventGatewayApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				// `sync` holds the HTTP response until the workflow finishes so a
				// failure answers 5xx and Hookdeck's retry rules take over.
				// `async_retry` acknowledges on receipt.
				responseMode: '={{$parameter["ackMode"] === "sync" ? "lastNode" : "onReceived"}}',
				path: 'webhook',
				// Hide n8n's own webhook URL. It is an internal detail here — the
				// address to give a provider is the Hookdeck source URL. Showing it
				// invites pasting it into Stripe or GitHub, which bypasses the gateway
				// and silently loses the verification, queueing and retries that are
				// the entire point of this node.
				ndvHideUrl: true,
			},
		],
		properties: triggerProperties,
	};

	methods = {
		listSearch: {
			/**
			 * List the project's sources, labelled with the public URL.
			 *
			 * That URL is the whole point of the node — it is what gets pasted into
			 * Stripe or GitHub — and it is only knowable after the source exists.
			 * Surfacing it here means setup finishes in the canvas instead of
			 * requiring a second node or a trip to the dashboard.
			 */
			async searchSources(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				// Matching happens here rather than server-side, so a cap while
				// searching would hide sources the user explicitly asked for. Browsing
				// stays bounded; searching does not.
				const limit = filter ? undefined : BROWSE_SOURCE_LIMIT;
				const sources = await hookdeckApiRequestAllItems.call(this, '/sources', {}, limit);

				const results: INodeListSearchItems[] = sources
					.map((source) => {
						const sourceName = (source.name as string) ?? '';
						const url = source.url as string | undefined;
						const id = source.id as string | undefined;
						return {
							// The URL goes in the label, not `description` or `url`:
							// n8n's resource locator list renders neither, so anywhere else
							// it would be invisible — and showing it is the whole point.
							// It also stays on screen after selection, as the cached label.
							name: url ? `${sourceName} — ${url}` : sourceName,
							value: sourceName,
							// n8n turns this into an "open" link beside the field, so it must
							// be somewhere worth opening. Emphatically not the ingest URL:
							// a browser GET against that is rejected (405), and pointing a
							// link at your own webhook endpoint invites firing requests at
							// it by accident. The dashboard page has a copy button.
							url: id ? `${HOOKDECK_DASHBOARD_URL}/sources/${id}` : undefined,
						};
					})
					.filter((item) =>
						filter ? item.value.toLowerCase().includes(filter.toLowerCase()) : true,
					)
					.sort((a, b) => a.value.localeCompare(b.value));

				return { results };
			},
		},
	};

	webhookMethods = {
		default: {
			/**
			 * Decide whether the Hookdeck connection this node provisioned is still
			 * usable. Returning false makes n8n call `create()`.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as HookdeckStaticData;

				const webhookUrl = this.getNodeWebhookUrl('default');
				if (!webhookUrl) return false;

				const { registration } = registrationFor(staticData, webhookUrl, this.getMode());
				if (!registration.connectionId) return false;

				let connection: IDataObject;
				try {
					connection = await hookdeckApiRequest.call(
						this,
						'GET',
						`/connections/${registration.connectionId}`,
					);
				} catch (error) {
					// Deleted in the Hookdeck dashboard, or belongs to another project
					// now that the credential changed. Either way, reprovision — but say
					// so, because a persistent failure here means every activation
					// silently recreates the connection.
					this.logger.debug(
						`Hookdeck connection ${registration.connectionId} could not be fetched, reprovisioning: ${
							(error as Error).message
						}`,
					);
					return false;
				}

				// Re-point the connection if this n8n instance moved host or path.
				// Without this check a relocated instance would keep a connection
				// delivering to an address that no longer exists.
				const destination = connection.destination as IDataObject | undefined;
				const config = destination?.config as IDataObject | undefined;
				if (config?.url !== webhookUrl) return false;

				// A disabled or paused connection does not deliver. Returning false
				// sends this through `create`, which upserts and then unpauses —
				// which is exactly what has to happen when the previous deactivation
				// paused the connection and queued events are waiting on it.
				if (connection.disabled_at || connection.paused_at) return false;

				return true;
			},

			/**
			 * Provision the Hookdeck connection that fronts this workflow.
			 *
			 * One idempotent upsert creates the destination and the connection, and
			 * either creates the source or binds to the one already there.
			 */
			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				if (!webhookUrl) {
					throw new NodeOperationError(this.getNode(), 'Could not resolve the n8n webhook URL');
				}

				// Hookdeck delivers over the public internet, so an n8n it cannot reach
				// needs the other delivery route: a CLI destination, fed by
				// `hookdeck listen` running alongside n8n. That covers a laptop and an
				// instance behind NAT alike — this is about reachability, not about
				// whether the workflow is a development one.
				const unreachable = describeUnreachableWebhookUrl(webhookUrl);
				const viaCli = unreachable !== undefined;

				const staticData = this.getWorkflowStaticData('node') as HookdeckStaticData;
				// extractValue collapses either resource locator mode to the source name.
				const sourceNameRaw = this.getNodeParameter('source', undefined, {
					extractValue: true,
				}) as string;
				const sourceType = this.getNodeParameter('sourceType') as string;
				const options = this.getNodeParameter('options', {}) as IDataObject;

				const sourceName = sanitizeName(sourceNameRaw).slice(0, 155);
				if (!sourceName) {
					throw new NodeOperationError(this.getNode(), 'Source Name must not be empty', {
						description:
							'Use letters, numbers, hyphens or underscores — other characters are removed.',
					});
				}

				const { registration, isTest } = registrationFor(staticData, webhookUrl, this.getMode());
				const workflowId = this.getWorkflow().id ?? 'workflow';
				const nodeId = this.getNode().id;

				// Reuse the stored secret when there is one, so a re-provision caused by
				// a moved URL does not invalidate signatures mid-flight.
				const signingSecret = registration.signingSecret ?? generateSigningSecret();

				// Bind to an existing source by ID rather than describing it inline.
				//
				// The upsert is keyed on source name, so an inline `source` block
				// rewrites the type and verification config of a source that is already
				// there — and that source may feed other connections, whose events would
				// silently start being verified differently, or not at all. Since
				// Source Type defaults to WEBHOOK and Verification to none, the common
				// path of picking an existing source from the list would otherwise strip
				// its verification on publish.
				//
				// `source_id` is unambiguous: it cannot carry a type or a config, so
				// there is nothing for the API to overwrite.
				const existingSource = await findSourceByName.call(this, sourceName);
				const updateExisting = options.updateExistingSource === true;

				let sourceBinding: IDataObject;
				if (existingSource && !updateExisting) {
					warnIgnoredSourceConfig.call(this, existingSource, sourceType, options);
					sourceBinding = { source_id: existingSource.id as string };
				} else {
					sourceBinding = {
						source: {
							name: sourceName,
							type: sourceType,
							config: buildSourceConfig.call(this, sourceType, options),
						},
					};
				}

				const destination = buildDestination(webhookUrl, signingSecret, options, viaCli);
				const connectionName = buildResourceName('n8n', workflowId, nodeId, isTest);

				const body: IDataObject = {
					name: connectionName,
					...sourceBinding,
					destination: {
						name: buildResourceName('n8n-dest', workflowId, nodeId, isTest),
						type: destination.type,
						config: destination.config,
					},
					// Retries matter more on the CLI route, where they are the only thing
					// that recovers an event delivered while `hookdeck listen` was down.
					rules: buildRules(options),
				};

				const connection = await hookdeckApiRequest.call(this, 'PUT', '/connections', body);

				// A previous deactivation may have paused this connection, holding
				// events. Unpausing releases them to the reactivated workflow.
				if (connection.paused_at) {
					await hookdeckApiRequest.call(this, 'PUT', `/connections/${connection.id}/unpause`);
				}

				const source = connection.source as IDataObject | undefined;
				registration.connectionId = connection.id as string;
				registration.sourceId = source?.id as string;
				registration.sourceUrl = source?.url as string;
				registration.signingSecret = signingSecret;
				registration.destinationUrl = webhookUrl;

				if (viaCli) {
					// The node cannot start the CLI — n8n forbids community nodes from
					// spawning processes — so the most it can do is say exactly what to
					// run. `activationMessage` is a static string on the description and
					// cannot carry these values, which leaves the log.
					this.logger.info(
						describeCliSetup.call(this, webhookUrl, sourceName, connectionName, unreachable),
					);

					const unsupported = optionsUnsupportedOverCli(options);
					if (unsupported.length > 0) {
						this.logger.info(
							`Hookdeck Event Gateway Trigger: ${unsupported.join(' and ')} ${
								unsupported.length > 1 ? 'are' : 'is'
							} not applied. Hookdeck supports ${
								unsupported.length > 1 ? 'them' : 'it'
							} on directly reachable destinations only, and this workflow receives events through the Hookdeck CLI.`,
						);
					}
				}

				return true;
			},

			/**
			 * Stand the connection down on deactivation.
			 *
			 * Pausing is the default because deleting a connection cancels every
			 * event still queued for it, irrecoverably — which is exactly the loss
			 * this node exists to prevent when a workflow is deactivated for a
			 * deploy. A paused connection holds events and delivers them on
			 * reactivation.
			 *
			 * The source and destination are left in place either way: a source may
			 * be shared with other connections, and removing it would break them.
			 */
			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as HookdeckStaticData;

				// Which registration this call refers to is decided by the URL n8n is
				// deregistering, so a lapsed test webhook never touches the production
				// connection.
				const webhookUrl = this.getNodeWebhookUrl('default');
				const { registration, isTest } = registrationFor(staticData, webhookUrl, this.getMode());
				if (!registration.connectionId) return true;

				const options = this.getNodeParameter('options', {}) as IDataObject;
				// A test registration is always torn down completely: its connection
				// points at a URL that stops answering after 120 seconds, so pausing it
				// would leave a permanently broken connection behind.
				const onDeactivate = isTest ? 'delete' : ((options.onDeactivate as string) ?? 'pause');

				if (onDeactivate === 'pause') {
					await hookdeckApiRequest.call(
						this,
						'PUT',
						`/connections/${registration.connectionId}/pause`,
					);
					// Static data is kept so the next activation finds and unpauses this
					// same connection rather than provisioning a second one.
					return true;
				}

				try {
					await hookdeckApiRequest.call(
						this,
						'DELETE',
						`/connections/${registration.connectionId}`,
					);
				} catch (error) {
					// Already gone is success. Anything else is surfaced, because a
					// connection left delivering to a deactivated workflow is exactly the
					// silent failure this node exists to avoid.
					const statusCode = (error as { httpCode?: string }).httpCode;
					if (statusCode !== '404') {
						// Looks redundant — the error is already a NodeApiError and the
						// constructor returns it unchanged. It stays because a bare
						// `throw error` fails the `require-node-api-error` lint rule, and
						// the verification scanner ignores inline disables.
						throw new NodeApiError(this.getNode(), error as never);
					}
				}

				delete staticData[isTest ? 'test' : 'production'];

				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const staticData = this.getWorkflowStaticData('node') as HookdeckStaticData;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const shouldVerify = (options.verifySignature as boolean) ?? true;

		const request = this.getRequestObject();
		const rawBody = (request as unknown as { rawBody?: Buffer | string }).rawBody;

		if (shouldVerify) {
			if (rawBody === undefined) {
				throw new NodeOperationError(
					this.getNode(),
					'Cannot verify the Hookdeck signature: this n8n instance did not expose the raw request body',
					{
						description:
							'Turn off "Verify Signature" under Options to accept deliveries without checking the signature.',
					},
				);
			}

			const headers = this.getHeaderData() as Record<string, string | undefined>;
			const signature = headers[SIGNATURE_HEADER];

			// A delivery does not say whether it belongs to the test or production
			// registration, and each has its own secret. Both are this node's own,
			// so accepting either is correct — and checking only one would reject
			// valid test deliveries while a workflow is also running in production.
			//
			// Verified against the raw bytes, never a decoded string — see
			// verifySignature for why decoding first would reject valid payloads.
			const secrets = [staticData.production?.signingSecret, staticData.test?.signingSecret]
				// The pre-split layout kept a single secret at the top level.
				.concat(staticData.signingSecret)
				.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);

			if (secrets.length === 0) {
				// Static data does not survive an export/import or an instance
				// migration. Without this, every delivery 401s and nothing says why,
				// when the fix is simply to reactivate and reprovision.
				this.logger.warn(
					'Hookdeck Trigger: signature verification is on but no signing secret is stored for this workflow, so every delivery will be rejected. Reactivate the workflow to reprovision it.',
				);
			}

			const verified = secrets.some((secret) => verifySignature(rawBody, signature, secret));

			if (!verified) {
				const response = this.getResponseObject();
				response.status(401).json({ message: 'Invalid signature' });
				return { noWebhookResponse: true };
			}
		}

		// A valid signature proves the bytes are authentic, not that they are
		// readable. Invalid UTF-8 inside a JSON string still parses in Node, so
		// the workflow would receive silently corrupted text. Reject instead.
		//
		// 400 is deliberate: it sits outside the retry rule's 500-599/429 range,
		// so a malformed body fails once rather than burning every retry.
		// Only for payloads meant to be text. A binary body — multipart, compressed,
		// a non-UTF-8 XML charset — is legitimately not UTF-8, and rejecting it
		// would make those providers permanently undeliverable.
		if (Buffer.isBuffer(rawBody) && expectsUtf8(this.getHeaderData()) && !isValidUtf8(rawBody)) {
			const response = this.getResponseObject();
			response.status(400).json({ message: 'Request body is not valid UTF-8' });
			return { noWebhookResponse: true };
		}

		// Surface Hookdeck's delivery metadata alongside the payload. Without it a
		// workflow cannot tell a first attempt from a fifth, spot the last attempt
		// before an event is abandoned, or deduplicate on the event ID.
		const metadata = extractDeliveryMetadata(
			this.getHeaderData() as Record<string, string | string[] | undefined>,
			(options.headerPrefix as string) ?? DEFAULT_HEADER_PREFIX,
		);

		return {
			workflowData: [
				this.helpers.returnJsonArray({
					body: this.getBodyData(),
					headers: this.getHeaderData() as IDataObject,
					query: this.getQueryData() as IDataObject,
					hookdeck: metadata as unknown as IDataObject,
				}),
			],
		};
	}
}
