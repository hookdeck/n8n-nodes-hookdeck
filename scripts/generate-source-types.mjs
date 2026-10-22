#!/usr/bin/env node
/**
 * Regenerate `nodes/Hookdeck/SourceTypes.ts` from Hookdeck's live OpenAPI schema.
 *
 * Both exports in that file are derived data — the ~180 platform source types
 * and the auth shape each one expects — and both go stale silently as Hookdeck
 * adds platform support. Silently is the problem: a missing type is a platform
 * the node cannot offer, and a wrong auth shape is a secret sent in a field the
 * API rejects at activation, which the user sees as an opaque 422.
 *
 * Usage:
 *   node scripts/generate-source-types.mjs            # rewrite the file
 *   node scripts/generate-source-types.mjs --check    # exit 1 if it is stale
 *   node scripts/generate-source-types.mjs --spec <path-or-url>
 *
 * `--check` is what CI runs. It is deliberately not part of the build: the spec
 * is a live third-party document, so a Hookdeck release would otherwise turn
 * every unrelated pull request red.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(HERE, '../nodes/Hookdeck/SourceTypes.ts');
const DEFAULT_SPEC = 'https://api.hookdeck.com/2025-07-01/openapi';

/**
 * Display names to use instead of the spec's `x-docs-type`.
 *
 * The spec is the better source for most labels — it knows "DocuSign" and
 * "GoCardless" where a mechanical title-casing would not — but a handful are
 * absent, ambiguous in a dropdown, or plainly wrong. Each one here is an
 * exception with a reason, so a new platform still gets its label for free.
 */
const LABEL_OVERRIDES = {
	// No `x-docs-type` in the spec: these are Hookdeck's own types, not platforms.
	WEBHOOK: 'Webhook (Generic)',
	HTTP: 'HTTP',
	MANAGED: 'Managed',
	// No source type config schema at all, so nothing to read a label from.
	'PROPERTY-FINDER': 'Property Finder',
	// The spec labels this "Managed", which collides with the MANAGED type above.
	HOOKDECK_OUTPOST: 'Hookdeck Outpost',
	// The spec says "X". Alone in a 180-entry dropdown that is unrecognisable.
	TWITTER: 'X (Twitter)',
	// A choice of auth schemes carries no `x-docs-type` of its own, so these fall
	// through to title-casing. GitLab was labelled correctly until it gained a
	// second scheme, after which it read "Gitlab".
	GITLAB: 'GitLab',
	SENDGRID_INBOUND: 'SendGrid Inbound Parse',
	// Vendor casing the spec gets wrong.
	SENDGRID: 'SendGrid',
	CLOUDSIGNAL: 'CloudSignal',
	THREE_D_EYE: '3DEYE',
	// The product is "Front"; "FrontApp" is the legacy name.
	FRONTAPP: 'Front',
};

/**
 * Types Hookdeck verifies with signing keys it fetches itself, once the source is
 * created with an `auth` object, even an empty one.
 *
 * The spec cannot say this. Their auth schema is an empty object, identical to
 * Docker Hub's or WordPress.com's, which Hookdeck does not verify at all. The
 * difference lives in Hookdeck's own source type definitions, as a verification
 * feature with no fields that its dashboard shows as an on/off toggle. A source
 * created without `auth` gets no verification and accepts anything sent to it.
 * That is what the node created for AWS SNS, while its refusal of a secret told
 * users Hookdeck verified the platform without one.
 */
const KEYLESS_VERIFICATION = new Set([
	// The signing certificate is fetched from the URL each message names.
	'AWS_SNS',
	// Keys come from ShipStation's published JWKS. This took a `public_key` until
	// October 2026; Hookdeck now strips one silently rather than rejecting it.
	'SHIPSTATION',
]);

/**
 * Resolve a `$ref`, or hand back an inline schema unchanged.
 *
 * The schema name is everything after `#/components/schemas/`, not the last
 * path segment. Hookdeck names schemas after display labels, and "Google
 * Pub/Sub" puts an unescaped slash in the ref: a last-segment lookup found
 * "SubAuth", which does not exist, and read Pub/Sub as taking no secret when it
 * requires two values. `~1` and `~0` are JSON Pointer escapes, honoured in case
 * the spec starts escaping properly.
 */
function deref(schemas, schema) {
	if (!schema) return undefined;
	if (schema.$ref) {
		const name = schema.$ref
			.replace(/^#\/components\/schemas\//, '')
			.replace(/~1/g, '/')
			.replace(/~0/g, '~');
		return schemas[name];
	}
	return schema;
}

/** The fields an auth schema names, or `none` when it names nothing. */
function fieldsShape(auth) {
	const fields = Object.keys(auth.properties ?? {}).sort();
	if (fields.length === 0) return { kind: 'none' };
	return { kind: 'fields', fields };
}

/**
 * The scheme a type's own name selects, when it offers a choice that includes it.
 *
 * The node sends `auth_type` set to the source type itself with every platform
 * secret (see `buildSourceConfig`), so a choice of schemes only leaves the node
 * unable to answer when the type's own name is not one of the options. GitLab is
 * the case that forced this: it gained a Standard Webhooks scheme beside its own
 * `GITLAB` one, and reading that as a bare choice would have refused the secret
 * that `GITLAB` scheme takes in `api_key` — the request the node already sends.
 */
function ownScheme(schemas, config, type) {
	if (!config.properties.auth_type.enum?.includes(type)) return undefined;
	const auth = deref(schemas, config.properties.auth);
	return auth?.oneOf
		?.map((scheme) => deref(schemas, scheme))
		.find((scheme) => scheme?.['x-docs-type'] === type);
}

/**
 * How a source type expects verification to be set up, with the keyless
 * exceptions the spec cannot express applied on top.
 */
function authShapeFor(schemas, type) {
	const shape = specAuthShapeFor(schemas, type);
	if (!KEYLESS_VERIFICATION.has(type)) return shape;

	// The exception only holds while the spec agrees there is nothing to enter.
	// Failing here is what makes the weekly drift check report a stale entry,
	// rather than the node going on sending an empty `auth` to a type that now
	// wants something in it.
	if (shape?.kind !== 'none') {
		throw new Error(
			`${type} is in KEYLESS_VERIFICATION, but the spec now gives it ${
				shape ? `kind "${shape.kind}"` : 'no config schema'
			}. Check how Hookdeck verifies it and update the list.`,
		);
	}
	return { kind: 'keyless' };
}

/**
 * Work out from the spec alone how a source type expects its verification
 * secret to be supplied.
 *
 * Each outcome needs a different answer from the node: a single named field can
 * hold a supplied secret, several cannot, a choice of schemes cannot be
 * inferred, and some types have nowhere to put a secret at all.
 */
function specAuthShapeFor(schemas, type) {
	const config = schemas[`SourceTypeConfig${type}`];
	// No config schema: an unknown or newer type. Left out of the map entirely so
	// the node falls back to the common field rather than asserting a shape.
	if (!config) return undefined;

	// An `auth_type` property means the type accepts a choice of schemes. Which
	// fields apply can only be known when one of those schemes is the type's own.
	if (config.properties?.auth_type) {
		const own = ownScheme(schemas, config, type);
		return own ? fieldsShape(own) : { kind: 'choice' };
	}

	const auth = deref(schemas, config.properties?.auth);
	if (!auth) return { kind: 'none' };
	if (auth.oneOf) return { kind: 'choice' };
	return fieldsShape(auth);
}

function labelFor(schemas, type) {
	if (type in LABEL_OVERRIDES) return LABEL_OVERRIDES[type];

	const config = schemas[`SourceTypeConfig${type}`];
	const auth = deref(schemas, config?.properties?.auth);
	const label = auth?.['x-docs-type'];
	if (label) return label;

	// Last resort for a new type whose auth schema carries no label.
	return type
		.toLowerCase()
		.split(/[_-]/)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

function render(options, authShapes) {
	const optionLines = options
		.map(({ name, value }) => `\t{ name: '${name.replace(/'/g, "\\'")}', value: '${value}' },`)
		.join('\n');

	const authLines = Object.entries(authShapes)
		.map(([type, shape]) => {
			const body =
				shape.kind === 'fields'
					? `{ kind: 'fields', fields: [${shape.fields.map((f) => `'${f}'`).join(', ')}] }`
					: `{ kind: '${shape.kind}' }`;
			return `\t'${type}': ${body},`;
		})
		.join('\n');

	return `import type { INodePropertyOptions } from 'n8n-workflow';

/**
 * Hookdeck source types for the Event Gateway, generated from the live OpenAPI
 * schema. Do not edit by hand — run \`npm run generate:source-types\`, which
 * reads \`Source.properties.type.enum\` and the \`SourceTypeConfig*\` schemas
 * from ${DEFAULT_SPEC}.
 *
 * Held as a constant rather than fetched at runtime: the spec is over 500KB and a
 * dropdown should not pay that cost every time it opens. \`npm run
 * check:source-types\` fails when this file no longer matches the spec.
 *
 * Choosing a platform type lets Hookdeck apply that platform's own signature
 * verification scheme, once the source carries what the scheme needs (see
 * \`SOURCE_TYPE_AUTH\`). \`WEBHOOK\` is the generic type, where the verification
 * method is configured explicitly.
 */
export const SOURCE_TYPE_OPTIONS: INodePropertyOptions[] = [
${optionLines}
];

/**
 * How each source type expects its verification secret to be supplied, read
 * from \`SourceTypeConfig*.properties.auth\` (following $refs, inline
 * definitions and \`oneOf\` alike).
 *
 * The cases are kept structurally distinct because they need different answers,
 * and an array alone cannot tell "takes no secret" apart from "several possible
 * schemes":
 *
 * - \`fields\`  — the named fields. One means a single supplied secret can be
 *   placed correctly; several means it cannot. A type offering a choice of
 *   schemes lands here when one of them is its own, because the node names the
 *   type as the \`auth_type\` and so selects that scheme.
 * - \`choice\`  — the type accepts a choice of schemes, none of them its own, so
 *   which fields apply cannot be inferred.
 * - \`keyless\` — Hookdeck verifies the type with keys it fetches itself, but
 *   only once the source is created with an \`auth\` object, so the node sends an
 *   empty one. The spec cannot tell these from \`none\`; the generator lists them.
 * - \`none\`    — there is nowhere to put a secret. Hookdeck either does not
 *   verify the type or manages its credential itself.
 *
 * Hookdeck drops a field it does not expect, so a secret in the wrong place
 * either fails a required-field check at activation or vanishes without a word.
 * Each case is answered explicitly rather than guessed at.
 */
export type SourceAuthShape =
	| { kind: 'fields'; fields: string[] }
	| { kind: 'choice' }
	| { kind: 'keyless' }
	| { kind: 'none' };

export const SOURCE_TYPE_AUTH: Record<string, SourceAuthShape> = {
${authLines}
};
`;
}

async function loadSpec(location) {
	if (/^https?:\/\//.test(location)) {
		const response = await fetch(location);
		if (!response.ok) {
			throw new Error(`Could not fetch the OpenAPI spec: HTTP ${response.status}`);
		}
		return await response.json();
	}
	return JSON.parse(await readFile(location, 'utf8'));
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const specIndex = args.indexOf('--spec');
const specLocation = specIndex === -1 ? DEFAULT_SPEC : args[specIndex + 1];

const spec = await loadSpec(specLocation);
const schemas = spec.components?.schemas ?? {};
const types = schemas.Source?.properties?.type?.enum;

if (!Array.isArray(types) || types.length === 0) {
	throw new Error('Source.properties.type.enum is missing from the spec — has the schema moved?');
}

const options = types
	.map((value) => ({ name: labelFor(schemas, value), value }))
	// Sorted by display name, which is the order the dropdown shows.
	.sort((a, b) => a.name.localeCompare(b.name));

const authShapes = {};
for (const type of [...types].sort()) {
	const shape = authShapeFor(schemas, type);
	if (shape) authShapes[type] = shape;
}

const generated = render(options, authShapes);
const current = await readFile(TARGET, 'utf8').catch(() => '');

if (check) {
	if (generated === current) {
		console.log(`✅ SourceTypes.ts matches the Hookdeck OpenAPI spec (${types.length} types)`);
		process.exit(0);
	}
	console.error('❌ SourceTypes.ts is out of date with the Hookdeck OpenAPI spec.');
	console.error('   Run `npm run generate:source-types` and commit the result.');
	process.exit(1);
}

if (generated === current) {
	console.log(`SourceTypes.ts already up to date (${types.length} types)`);
} else {
	await writeFile(TARGET, generated);
	console.log(`Wrote SourceTypes.ts (${types.length} types)`);
}
