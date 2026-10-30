/**
 * Loads the tab roster out of the plugin bundle's `@vt-store` marker block.
 */
import { readFileSync } from "node:fs";

const BEGIN = "/* ==== @vt-store:begin";
const END = "@vt-store:end ==== */";

export function vtStoreSource(path) {
	const text = readFileSync(path, "utf8");
	const start = text.indexOf(BEGIN);
	if (start === -1) return text;
	const stop = text.indexOf(END, start);
	if (stop === -1) throw new Error(`vt-store: unterminated marker block in ${path}`);
	return text.slice(start, stop + END.length);
}

export function createTerminalStoreFactory(path) {
	return new Function(`${vtStoreSource(path)}\nreturn createTerminalStore;`)();
}
