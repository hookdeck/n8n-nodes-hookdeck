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
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(import.meta.url);

const failures = [];
const checks = [];

/**
 * Every file n8n reads at runtime, collected as the checks below resolve them.
 * Compared against the packed file list at the end: `dist` on disk is not what
 * users install, and the two drifted once already — `files` shipped a 299kB
 * screenshot the build had swept into dist, and nothing noticed because every
 * check ran against dist.
 */
const runtimeFiles = new Set();
const needsPacking = (absolute) => runtimeFiles.add(relative(ROOT, absolute).split(sep).join('/'));

const check = (ok, label, detail) => {
	checks.push({ ok, label });
	if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const declared = pkg.n8n ?? {};

check(Array.isArray(declared.nodes) && declared.nodes.length > 0, 'package.json declares n8n.nodes');
check(Array.isArray(declared.credentials), 'package.json declares n8n.credentials');

// ─── The version, which nothing else compares to anything ──────────────────────
//
// n8n's scanner has a `require-version` rule and it passed this package at
// 0.1.0 while npm served 0.2.0: it asserts the field exists and parses as
// semver, and compares it to nothing. It structurally cannot compare it — a
// scan sees one tree. Even the published path, which has both the tarball and
// the attested source, lints them separately and ANDs the results.
//
// The tag guard in publish.yml catches a release whose tag disagrees with this
// file. This catches the same mistake a step earlier, at PR time, where the fix
// is an edit rather than a deleted release and tag: a version with no CHANGELOG
// section is a bump nobody wrote notes for, which is the shape the 0.2.0 miss
// actually had.
//
// Pre-releases are exempt. 0.3.0-beta.1 ships before a 0.3.0 section exists,
// which is the point of shipping a beta.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
check(SEMVER.test(pkg.version ?? ''), 'package.json version is a semantic version', pkg.version);

const changelogPath = join(ROOT, 'CHANGELOG.md');
if (SEMVER.test(pkg.version ?? '') && !pkg.version.includes('-') && existsSync(changelogPath)) {
	const changelog = await readFile(changelogPath, 'utf8');
	check(
		changelog.includes(`## [${pkg.version}]`),
		`CHANGELOG.md has a section for ${pkg.version}`,
		'promote `## [Unreleased]` in the same PR that bumps the version',
	);
}

/**
 * The categories n8n supports. An unsupported one is not an error anywhere: the
 * editor drops it silently, the eslint ruleset has no rule that reads a codex
 * file, and the scanner lints those files with that ruleset. `Developer Tools`
 * survived two releases that way and came back as a review comment.
 *
 * https://docs.n8n.io/integrations/creating-nodes/build/reference/node-codex-files/
 */
const CODEX_CATEGORIES = new Set([
	'Data & Storage',
	'Finance & Accounting',
	'Marketing & Content',
	'Productivity',
	'Miscellaneous',
	'Sales',
	'Development',
	'Analytics',
	'Communication',
	'Utility',
]);

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
		needsPacking(absolute);

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
		needsPacking(codexPath);
		const codex = JSON.parse(await readFile(codexPath, 'utf8'));
		const expectedType = `${pkg.name}.${description.name}`;
		check(
			codex.node === expectedType,
			`${label} codex names the right node type`,
			`codex says "${codex.node}", expected "${expectedType}"`,
		);

		check(
			Array.isArray(codex.categories) && codex.categories.length > 0,
			`${label} codex declares a category`,
		);
		for (const category of codex.categories ?? []) {
			check(
				CODEX_CATEGORIES.has(category),
				`${label} codex category "${category}" is one n8n supports`,
				`allowed: ${[...CODEX_CATEGORIES].join(', ')}`,
			);
		}
	}

	// Icons are referenced as `file:...` relative to the compiled node.
	const icons = typeof description.icon === 'string' ? [description.icon] : Object.values(description.icon ?? {});
	for (const icon of icons) {
		if (typeof icon !== 'string' || !icon.startsWith('file:')) continue;
		const iconPath = resolve(dirname(absolute), icon.slice('file:'.length));
		check(existsSync(iconPath), `${label} icon ${icon} resolves`, iconPath);
		if (existsSync(iconPath)) needsPacking(iconPath);
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

// ─── What actually ships ───────────────────────────────────────────────────────
//
// `files` in package.json is an allowlist, so adding a node without extending it
// produces a package that loads perfectly from dist and is missing from n8n once
// installed. Ask npm for the real file list rather than reasoning about globs.
//
// `--ignore-scripts` because npm pack runs prepack/prepare, and this script is
// itself run from the build and release paths.
let packedFiles;
let packed;
try {
	const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	packed = JSON.parse(output)[0];
	packedFiles = new Set(packed.files.map((f) => f.path));
} catch (error) {
	check(false, 'npm pack lists the package contents', error.message);
}

if (packedFiles) {
	for (const file of [...runtimeFiles].sort()) {
		check(
			packedFiles.has(file),
			`${file} is included in the published package`,
			'not matched by "files" in package.json',
		);
	}

	// Not a correctness failure, so a warning rather than a check — but the 0.0.1
	// tarball was 71% build leftovers and a README screenshot, and nothing said so.
	//
	// Two signals, because the two offenders looked different: `dist/docs/images`
	// was in the wrong place, and `dist/tsconfig.tsbuildinfo` was in the right
	// place and simply enormous. npm always adds README, LICENSE and package.json.
	const ALWAYS_INCLUDED = /^(readme|licen[cs]e|package\.json|changelog)/i;
	const LARGE_FILE_BYTES = 100_000;

	const misplaced = packed.files
		.map((f) => f.path)
		.filter((p) => !ALWAYS_INCLUDED.test(p) && !/^dist\/(nodes|credentials)\//.test(p));
	const large = packed.files.filter((f) => f.size > LARGE_FILE_BYTES);

	for (const path of misplaced) {
		console.warn(`⚠️  Packed from outside dist/nodes and dist/credentials: ${path}`);
	}
	for (const file of large) {
		console.warn(`⚠️  Large file in the package: ${file.path} (${Math.round(file.size / 1024)}kB)`);
	}
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
