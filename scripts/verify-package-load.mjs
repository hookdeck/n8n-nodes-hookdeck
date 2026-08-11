#!/usr/bin/env node
/**
 * Load this package the way n8n loads it, and check what n8n checks.
 *
 * This is not a substitute for running a real n8n — it cannot tell you whether
 * a webhook fires or a credential authenticates. What it does catch is the
 * class of failure that unit tests structurally cannot: the package not being
 * loadable at all. Unit tests import `dist/**` by path, so a wrong path in
 * `package.json`, a renamed class, or a codex file left behind by a rename all
 * pass the suite and then fail on n8n startup with the whole package missing
 * from the panel.
 *
 *   node scripts/verify-package-load.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(import.meta.url);

const failures = [];
const checks = [];

const check = (ok, label, detail) => {
	checks.push({ ok, label });
	if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const declared = pkg.n8n ?? {};

check(Array.isArray(declared.nodes) && declared.nodes.length > 0, 'package.json declares n8n.nodes');
check(Array.isArray(declared.credentials), 'package.json declares n8n.credentials');

/** Instantiate every declared class, the way n8n's loader does. */
const loadDeclared = (paths, kind) => {
	const loaded = [];
	for (const relative of paths ?? []) {
		const absolute = join(ROOT, relative);

		if (!existsSync(absolute)) {
			check(false, `${kind} ${relative} exists`, 'run `npm run build` first, or the path is wrong');
			continue;
		}
		check(true, `${kind} ${relative} exists`);

		let module;
		try {
			module = require(absolute);
		} catch (error) {
			check(false, `${kind} ${relative} requires cleanly`, error.message);
			continue;
		}

		// n8n takes the class whose name matches the file basename. A renamed
		// class with an unrenamed file — or the reverse — dies here.
		const expected = basename(relative).replace(/\.(node|credentials)\.js$/, '');
		const exported = Object.keys(module);
		if (!exported.includes(expected)) {
			check(
				false,
				`${kind} ${relative} exports a class named ${expected}`,
				`exports: ${exported.join(', ') || 'nothing'}`,
			);
			continue;
		}
		check(true, `${kind} ${relative} exports a class named ${expected}`);

		try {
			loaded.push({ relative, absolute, instance: new module[expected]() });
		} catch (error) {
			check(false, `${kind} ${expected} constructs`, error.message);
		}
	}
	return loaded;
};

const nodes = loadDeclared(declared.nodes, 'node');
const credentials = loadDeclared(declared.credentials, 'credential');

const credentialNames = new Set(credentials.map((c) => c.instance.name));

for (const { relative, absolute, instance } of nodes) {
	const { description } = instance;
	const label = description?.name ?? relative;

	check(Boolean(description?.name), `${label} has description.name`);
	check(Boolean(description?.displayName), `${label} has description.displayName`);

	// n8n derives the node type as `<package>.<name>`, and the codex file beside
	// the compiled node must agree or the docs links silently point nowhere.
	const codexPath = absolute.replace(/\.js$/, '.json');
	if (!existsSync(codexPath)) {
		check(false, `${label} has a codex file beside it`, `expected ${basename(codexPath)}`);
	} else {
		check(true, `${label} has a codex file beside it`);
		const codex = JSON.parse(await readFile(codexPath, 'utf8'));
		const expectedType = `${pkg.name}.${description.name}`;
		check(
			codex.node === expectedType,
			`${label} codex names the right node type`,
			`codex says "${codex.node}", expected "${expectedType}"`,
		);
	}

	// Icons are referenced as `file:...` relative to the compiled node.
	const icons = typeof description.icon === 'string' ? [description.icon] : Object.values(description.icon ?? {});
	for (const icon of icons) {
		if (typeof icon !== 'string' || !icon.startsWith('file:')) continue;
		const iconPath = resolve(dirname(absolute), icon.slice('file:'.length));
		check(existsSync(iconPath), `${label} icon ${icon} resolves`, iconPath);
	}

	// Every credential a node asks for has to be one this package ships, or n8n
	// shows the node with a credential it can never satisfy.
	for (const credential of description.credentials ?? []) {
		check(
			credentialNames.has(credential.name),
			`${label} requires credential "${credential.name}" that this package ships`,
			`ships: ${[...credentialNames].join(', ')}`,
		);
	}
}

for (const { instance } of credentials) {
	check(Boolean(instance.name), 'credential has a name');
	check(Boolean(instance.displayName), `credential ${instance.name} has a displayName`);
	check(
		Array.isArray(instance.properties) && instance.properties.length > 0,
		`credential ${instance.name} declares properties`,
	);
}

const passed = checks.filter((c) => c.ok).length;

if (failures.length > 0) {
	console.error(`❌ ${failures.length} of ${checks.length} load checks failed:\n`);
	for (const failure of failures) console.error(`   ${failure}`);
	process.exit(1);
}

console.log(`✅ Package loads the way n8n loads it (${passed} checks)`);
console.log(`   nodes: ${nodes.map((n) => n.instance.description.name).join(', ')}`);
console.log(`   credentials: ${[...credentialNames].join(', ')}`);
