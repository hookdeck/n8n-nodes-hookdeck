#!/usr/bin/env node
/**
 * Run n8n's verification scanner against this working tree.
 *
 * `npx @n8n/scan-community-package <name>` only accepts a package already on
 * npm — it resolves the source repo from the published provenance attestation.
 * That is too late to be useful: a failure would be discovered after publishing.
 *
 * The scanner's `analyzePackage` works on a local directory, so this runs the
 * same rule set over the same file patterns n8n will scan, before anything ships.
 */
import { analyzePackage, SOURCE_FILE_PATTERNS } from '@n8n/scan-community-package/scanner/scanner.mjs';

const result = await analyzePackage(process.cwd(), SOURCE_FILE_PATTERNS);

if (result.passed) {
	console.log('✅ Passed n8n community package verification checks');
	process.exit(0);
}

console.error('❌ Failed n8n community package verification checks');
console.error(`Reason: ${result.message}`);
if (result.details) console.error(`\n${result.details}`);
process.exit(1);
