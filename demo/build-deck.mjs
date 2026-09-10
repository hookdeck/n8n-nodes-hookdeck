#!/usr/bin/env node
/**
 * Regenerate deck.html's slide list from NARRATION.md.
 *
 * The deck carries the frames and the narration baked in, so it cannot drift on
 * its own - but it does not update on its own either. Run this after editing
 * the script.
 *
 *   node demo/build-deck.mjs           # rewrite the deck
 *   node demo/build-deck.mjs --check   # fail if it would change anything
 *
 * Spoken lines live in ```text fences rather than blockquotes, so a scene's
 * script can be copied without stripping "> " off every line.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(HERE, 'NARRATION.md'), 'utf8');

const slides = [];
const sections = md.split(/(?=^## )/m).filter((s) => /^## \S+ — /.test(s));
for (const sec of sections) {
	const head = sec.match(/^## (\S+) — (.+?)$/m);
	if (!head) continue;
	const meta = sec.match(/^\*\*0:(\d\d), (\d+) words\.\*\*/m);
	const fence = sec.match(/```text\n([\s\S]*?)```/);
	if (!meta || !fence) continue;
	const frame = sec.match(/`stills\/([\w.-]+\.png)`/);
	slides.push({
		id: head[1],
		title: head[2].replace(/\s*·\s*`stills\/.*?`/, '').trim(),
		secs: meta[1],
		src: frame ? `stills/${frame[1]}` : null,
		notes: fence[1].trim().split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()),
	});
}
if (slides.length === 0) throw new Error('no scenes parsed from NARRATION.md');

const path = join(HERE, 'deck.html');
const html = readFileSync(path, 'utf8');
const open = html.indexOf('const SLIDES = ') + 'const SLIDES = '.length;
const close = html.indexOf(';\n\nconst $ =');
if (open < 15 || close < 0) throw new Error('could not find the slide array in deck.html');
const next = html.slice(0, open) + JSON.stringify(slides, null, 2) + html.slice(close);

if (process.argv.includes('--check')) {
	if (next !== html) {
		console.error('deck.html is out of date with NARRATION.md. Run: node demo/build-deck.mjs');
		process.exit(1);
	}
	console.log(`deck.html matches NARRATION.md (${slides.length} scenes)`);
} else {
	writeFileSync(path, next);
	console.log(`deck.html rebuilt from NARRATION.md (${slides.length} scenes)`);
}
