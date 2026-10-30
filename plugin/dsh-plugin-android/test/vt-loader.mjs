/**
 * VT core loader shared by the terminal tests.
 *
 * The emulator ships inside the plugin bundle between `@vt-core:begin/end`
 * markers: the bundle is hand-written, so the marker block IS the source and
 * the tests read the shipped bytes rather than a copy that could drift.
 * `DSH_VT_SOURCE` overrides the file for working on the block in isolation.
 */
import { readFileSync } from "node:fs";

const BEGIN = "/* ==== @vt-core:begin";
const END = "@vt-core:end ==== */";

export function vtCoreSource(path) {
	const text = readFileSync(path, "utf8");
	const start = text.indexOf(BEGIN);
	if (start === -1) return text;
	const stop = text.indexOf(END, start);
	if (stop === -1) throw new Error(`vt-core: unterminated marker block in ${path}`);
	return text.slice(start, stop + END.length);
}

export function loadVtCore(path) {
	const source = vtCoreSource(path);
	return new Function(`${source}\nreturn createVtCore;`)()();
}

export const DEFAULT_SOURCE = process.env.DSH_VT_SOURCE
	?? new URL("../lib/client.js", import.meta.url).pathname;
