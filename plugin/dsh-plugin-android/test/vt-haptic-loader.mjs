/**
 * Loads the haptic helper out of the plugin bundle's `@vt-haptic` marker block.
 */
import { readFileSync } from "node:fs";

const BEGIN = "/* ==== @vt-haptic:begin";
const END = "@vt-haptic:end ==== */";

export function vtHapticSource(path) {
	const text = readFileSync(path, "utf8");
	const start = text.indexOf(BEGIN);
	if (start === -1) return text;
	const stop = text.indexOf(END, start);
	if (stop === -1) throw new Error(`vt-haptic: unterminated marker block in ${path}`);
	return text.slice(start, stop + END.length);
}

export function createVtHapticFactory(path) {
	return new Function(`${vtHapticSource(path)}\nreturn createVtHaptic;`)();
}
