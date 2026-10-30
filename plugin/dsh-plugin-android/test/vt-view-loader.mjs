/**
 * Loads the DOM view factory out of the plugin bundle's `@vt-view` marker
 * block, so the tests exercise the shipped bytes.
 */
import { readFileSync } from "node:fs";

const BEGIN = "/* ==== @vt-view:begin";
const END = "@vt-view:end ==== */";

export function vtViewSource(path) {
	const text = readFileSync(path, "utf8");
	const start = text.indexOf(BEGIN);
	if (start === -1) return text;
	const stop = text.indexOf(END, start);
	if (stop === -1) throw new Error(`vt-view: unterminated marker block in ${path}`);
	return text.slice(start, stop + END.length);
}

export function createVtViewFactory(path) {
	return new Function(`${vtViewSource(path)}\nreturn createVtView;`)();
}

export const DEFAULT_SOURCE = process.env.DSH_VT_SOURCE
	?? new URL("../lib/client.js", import.meta.url).pathname;
export const createVtView = createVtViewFactory(DEFAULT_SOURCE);
