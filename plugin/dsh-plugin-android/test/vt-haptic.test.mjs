/**
 * Haptic helper tests: bridge first, vibration second, one tick per tap.
 *
 * Usage: node test/vt-haptic.test.mjs
 */
import { createVtHapticFactory } from "./vt-haptic-loader.mjs";

const createVtHaptic = createVtHapticFactory(
	process.env.DSH_VT_SOURCE ?? new URL("../lib/client.js", import.meta.url).pathname
);

let failures = 0;
let checks = 0;

function ok(condition, message, detail) {
	checks++;
	if (condition) return;
	failures++;
	console.error(`FAIL  ${message}`);
	if (detail !== undefined) console.error(detail);
}

function equal(actual, expected, message) {
	ok(actual === expected, message, `  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function makeHarness(options = {}) {
	const calls = [];
	const vibrations = [];
	let clock = 1000;
	const haptic = createVtHaptic({
		call: options.call === undefined
			? (path, body) => {
				calls.push([path, body]);
				return Promise.resolve({ ok: true });
			}
			: options.call,
		vibrate: options.vibrate === undefined ? (ms) => vibrations.push(ms) : options.vibrate,
		now: () => clock,
		minIntervalMs: options.minIntervalMs
	});
	return {
		haptic,
		calls,
		vibrations,
		advance: (ms) => {
			clock += ms;
		}
	};
}

/* 1. a tap goes to the app bridge as a tap-kind haptic */
{
	const harness = makeHarness();
	equal(harness.haptic.tap(), true, "a tap is attempted");
	equal(harness.calls.length, 1, "the bridge is called once");
	equal(harness.calls[0][0], "/haptic", "the route is the haptic route");
	equal(JSON.stringify(harness.calls[0][1]), JSON.stringify({ kind: "tap" }), "and it asks for a light tap, not a buzz");
	equal(harness.vibrations.length, 0, "the fallback stays unused while the bridge answers");
}

/* 2. rapid taps collapse into one tick (holding a key must not buzz) */
{
	const harness = makeHarness();
	for (let i = 0; i < 8; i++) harness.haptic.tap();
	equal(harness.calls.length, 1, "eight fast taps are one haptic call");
	harness.advance(60);
	harness.haptic.tap();
	equal(harness.calls.length, 2, "a tap after the debounce goes through again");
}

/* 3. a bridge that rejects falls back to a short vibration */
{
	const harness = makeHarness({
		call: () => Promise.reject(new Error("HTTP 404"))
	});
	harness.haptic.tap();
	await new Promise((resolve) => setTimeout(resolve, 5));
	equal(harness.vibrations.length, 1, "the fallback fired once");
	ok(harness.vibrations[0] <= 20, "and it is a tap-length vibration", `  ms: ${harness.vibrations[0]}`);
}

/* 4. no bridge at all: vibrate directly, never throw */
{
	const harness = makeHarness({ call: null });
	harness.haptic.tap();
	equal(harness.vibrations.length, 1, "without a bridge the vibration path is used");
	equal(harness.haptic.hasBridge(), false, "and the helper reports that there is no bridge");
}

/* 5. a throwing vibrate cannot break the key row */
{
	const harness = makeHarness({
		call: null,
		vibrate: () => {
			throw new Error("no permission");
		}
	});
	harness.haptic.tap();
	ok(true, "a throwing vibrate is swallowed");
}

/* 6. a throwing bridge call falls back instead of propagating */
{
	const harness = makeHarness({
		call: () => {
			throw new Error("bridge爆炸");
		}
	});
	harness.haptic.tap();
	equal(harness.vibrations.length, 1, "a synchronous bridge failure falls back to vibration");
}

console.log(`vt-haptic: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
