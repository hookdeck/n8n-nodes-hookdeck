#!/usr/bin/env node
/**
 * Regenerate `nodes/Hookdeck/SourceTypes.ts` from Hookdeck's live OpenAPI schema.
 *
 * Both exports in that file are derived data — the ~150 platform source types
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
	// The spec says "X". Alone in a 150-entry dropdown that is unrecognisable.
	TWITTER: 'X (Twitter)',
	// Vendor casing the spec gets wrong.
	SENDGRID: 'SendGrid',
	CLOUDSIGNAL: 'CloudSignal',
	THREE_D_EYE: '3DEYE',
	// The product is "Front"; "FrontApp" is the legacy name.
	FRONTAPP: 'Front',
};

/** Resolve a `$ref`, or hand back an inline schema unchanged. */
function deref(schemas, schema) {
	if (!schema) return undefined;
	if (schema.$ref) return schemas[schema.$ref.split('/').pop()];
	return schema;
}

/**
 * Work out how a source type expects its verification secret to be supplied.
 *
 * Three outcomes, because they need three different answers from the node:
 * a single named field can hold a supplied secret, several cannot, a choice of
 * schemes cannot be inferred, and some types take no secret at all.
 */
function authShapeFor(schemas, type) {
	const config = schemas[`SourceTypeConfig${type}`];
	// No config schema: an unknown or newer type. Left out of the map entirely so
	// the node falls back to the common field rather than asserting a shape.
	if (!config) return undefined;

	// An `auth_type` property means the type accepts a choice of schemes, so
	// which fields apply cannot be known from the type alone.
	if (config.properties?.auth_type) return { kind: 'choice' };

	const auth = deref(schemas, config.properties?.auth);
	if (!auth) return { kind: 'none' };
	if (auth.oneOf) return { kind: 'choice' };

	const fields = Object.keys(auth.properties ?? {}).sort();
	if (fields.length === 0) return { kind: 'none' };
	return { kind: 'fields', fields };
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
 * Held as a constant rather than fetched at runtime: the spec is ~475KB and a
 * dropdown should not pay that cost every time it opens. \`npm run
 * check:source-types\` fails when this file no longer matches the spec.
 *
 * Choosing a platform type makes Hookdeck apply that platform's own signature
 * verification scheme. \`WEBHOOK\` is the generic type, where the verification
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
 * The three cases are kept structurally distinct because they need different
 * answers, and an array alone cannot tell "takes no secret" apart from "several
 * possible schemes":
 *
 * - \`fields\` — the named fields. One means a single supplied secret can be
 *   placed correctly; several means it cannot.
 * - \`choice\` — the type accepts a choice of schemes, so which fields apply
 *   cannot be inferred.
 * - \`none\`   — the type takes no secret at all.
 *
 * Sending a secret the API does not expect is rejected at activation, so each
 * case is answered explicitly rather than guessed at.
 */
export type SourceAuthShape =
	| { kind: 'fields'; fields: string[] }
	| { kind: 'choice' }
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
