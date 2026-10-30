import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const root = process.cwd();
const manifest = readFileSync('SOURCE_FILE_MANIFEST.txt', 'utf8')
	.split(/\r?\n/)
	.filter((path) => path.endsWith('.md'));
const missing = [];
let checked = 0;

for (const file of manifest) {
	const text = readFileSync(file, 'utf8');
	for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
		let target = match[1].trim().replace(/^<|>$/g, '');
		if (!target || /^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue;
		target = target.split('#')[0].split('?')[0];
		if (!target) continue;
		try {
			target = decodeURIComponent(target);
		} catch {
			// Keep malformed escape sequences literal so the missing-path report is useful.
		}
		const path = target.startsWith('/')
			? resolve(root, target.slice(1))
			: resolve(dirname(file), target);
		checked++;
		if (!existsSync(path)) missing.push(`${file} -> ${match[1]} (${relative(root, path)})`);
	}
}

assert.deepEqual([...new Set(missing)], [], `Missing local Markdown targets:\n${missing.join('\n')}`);
console.log(`Local Markdown links: ${checked} checked, 0 missing.`);
