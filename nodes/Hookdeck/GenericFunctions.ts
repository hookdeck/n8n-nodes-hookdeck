import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

/**
 * Pinned Hookdeck API version. The version is part of the path, so bumping it
 * is a deliberate, reviewable change rather than an implicit upgrade.
 */
export const HOOKDECK_API_VERSION = '2025-07-01';
export const HOOKDECK_BASE_URL = `https://api.hookdeck.com/${HOOKDECK_API_VERSION}`;

/** Dashboard origin, for linking a user to a resource they can act on. */
export const HOOKDECK_DASHBOARD_URL = 'https://dashboard.hookdeck.com';

type HookdeckContext =
	| IHookFunctions
	| IWebhookFunctions
	| IExecuteFunctions
	| ILoadOptionsFunctions;

/**
 * Single entry point for every Hookdeck API call.
 *
 * Always goes through httpRequestWithAuthentication so the credential's
 * `authenticate` block applies the Authorization header — setting it by hand
 * is both a lint failure and a way to leak the key into logs.
 */
export async function hookdeckApiRequest(
	this: HookdeckContext,
	method: IHttpRequestMethods,
	resource: string,
	body: IDataObject = {},
	qs: IDataObject = {},
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method,
		url: `${HOOKDECK_BASE_URL}${resource}`,
		headers: { 'Content-Type': 'application/json' },
		body,
		qs,
		json: true,
		// Handle non-2xx here rather than letting the helper throw. n8n's
		// NodeApiError returns the original instance when handed one, so a helper
		// generated error cannot be re-labelled — and Hookdeck puts the reason a
		// request was rejected in the response body, which would be lost.
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};

	if (Object.keys(body).length === 0) {
		delete options.body;
	}
	if (Object.keys(qs).length === 0) {
		delete options.qs;
	}

	let response: { statusCode: number; body: unknown };
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'hookdeckEventGatewayApi',
			options,
		)) as { statusCode: number; body: unknown };
	} catch (error) {
		// Transport-level failure — DNS, TLS, timeout. No response body exists.
		throw toHookdeckError.call(this, error, method, resource, undefined, undefined);
	}

	if (response.statusCode >= 400) {
		throw toHookdeckError.call(
			this,
			undefined,
			method,
			resource,
			response.statusCode,
			response.body,
		);
	}

	// A 204, or any endpoint answering with an empty body, yields '' rather than
	// an object. Normalise so callers always get something they can index.
	const responseBody = response.body;
	if (responseBody === null || typeof responseBody !== 'object') return {};
	return responseBody as IDataObject;
}

/**
 * Turn an HTTP failure into an error that names what Hookdeck actually
 * objected to.
 *
 * Hookdeck returns its reason in the response body, and workflow activation in
 * n8n surfaces only `error.message` — so a bare re-wrap leaves the user with
 * "Your request is invalid", which says nothing about which field was wrong.
 */
function toHookdeckError(
	this: HookdeckContext,
	error: unknown,
	method: string,
	resource: string,
	statusCode?: number,
	payload?: unknown,
): NodeApiError {
	const err = (error ?? {}) as { message?: string };

	const detail = describeHookdeckPayload(payload) ?? err.message;
	const status = statusCode ? ` (HTTP ${statusCode})` : '';

	// The detail goes in the message, not just the description: n8n's workflow
	// activation path reports only `error.message`, so a description alone would
	// be invisible exactly when provisioning fails.
	// A plain object is passed as the error response, never an existing
	// NodeApiError: handed one of those, the constructor returns it unchanged and
	// silently discards the message below.
	return new NodeApiError(
		this.getNode(),
		{ message: detail ?? 'Unknown error', statusCode } as never,
		{
			message: `Hookdeck API request failed${status}: ${method} ${resource}${
				detail ? ` — ${detail}` : ''
			}`,
			description: detail ?? 'No further detail was returned.',
			httpCode: statusCode ? String(statusCode) : undefined,
		},
	);
}

/** Render Hookdeck's error body, including per-field validation messages. */
function describeHookdeckPayload(payload: unknown): string | undefined {
	if (payload === undefined || payload === null) return undefined;
	if (typeof payload === 'string') return payload;

	const body = payload as { message?: string; errors?: unknown; data?: unknown };
	const parts: string[] = [];

	if (typeof body.message === 'string') parts.push(body.message);

	// Some Hookdeck failures carry the human reason in `data` and no `message` at
	// all — a delivery-group upsert on a project without the entitlement answers
	// {"level":"info","handled":true,"data":["Delivery groups are not enabled for
	// this organization"],"status":422}. Without this the whole body falls through
	// to the stringify below, so the reader meets `"level":"info"` before the
	// reason, on what is a hard failure the workflow could not complete.
	if (Array.isArray(body.data)) {
		for (const entry of body.data) {
			if (typeof entry === 'string' && entry) parts.push(entry);
		}
	}

	if (body.errors && typeof body.errors === 'object') {
		for (const [field, issue] of Object.entries(body.errors as Record<string, unknown>)) {
			parts.push(`${field}: ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`);
		}
	}

	return parts.length > 0 ? parts.join(' — ') : JSON.stringify(payload).slice(0, 500);
}

/**
 * Fetch every page of a paginated Hookdeck list endpoint.
 *
 * Hookdeck returns `{ models, pagination: { next } }`; `next` is an opaque
 * cursor passed back as `?next=`.
 */
export async function hookdeckApiRequestAllItems(
	this: HookdeckContext,
	resource: string,
	qs: IDataObject = {},
	limit?: number,
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let next: string | undefined;

	const PAGE_SIZE = 250;

	do {
		// Never ask for more than the caller can use. "Get URL" wants a single
		// source; fetching 250 to discard 249 is pure waste.
		const remaining = limit === undefined ? PAGE_SIZE : Math.max(1, limit - results.length);
		const query: IDataObject = { ...qs, limit: Math.min(PAGE_SIZE, remaining) };
		if (next) query.next = next;

		const response = await hookdeckApiRequest.call(this, 'GET', resource, {}, query);
		const models = (response.models as IDataObject[]) ?? [];
		results.push(...models);

		if (limit !== undefined && results.length >= limit) {
			return results.slice(0, limit);
		}

		next = (response.pagination as IDataObject | undefined)?.next as string | undefined;
	} while (next);

	return results;
}
