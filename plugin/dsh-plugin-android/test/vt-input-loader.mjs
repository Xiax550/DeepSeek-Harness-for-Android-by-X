/**
 * Loads the input controller out of the plugin bundle's `@vt-input` marker
 * block, so the tests exercise the shipped bytes.
 */
import { readFileSync } from "node:fs";

const BEGIN = "/* ==== @vt-input:begin";
const END = "@vt-input:end ==== */";

export function vtInputSource(path) {
	const text = readFileSync(path, "utf8");
	const start = text.indexOf(BEGIN);
	if (start === -1) return text;
	const stop = text.indexOf(END, start);
	if (stop === -1) throw new Error(`vt-input: unterminated marker block in ${path}`);
	return text.slice(start, stop + END.length);
}

export function createVtInputFactory(path) {
	return new Function(`${vtInputSource(path)}\nreturn createVtInput;`)();
}

export const DEFAULT_SOURCE = process.env.DSH_VT_SOURCE
	?? new URL("../lib/client.js", import.meta.url).pathname;
export const createVtInput = createVtInputFactory(DEFAULT_SOURCE);
