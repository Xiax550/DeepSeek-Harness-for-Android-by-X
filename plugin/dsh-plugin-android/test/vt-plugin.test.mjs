/**
 * Plugin wiring smoke test: load the bundle, run apply() against a fake host.
 *
 * The marker-block suites cover the emulator, the input path, the view and the
 * tab roster. This one covers what is left — the code that is not in a block:
 * the factory body, apply(), the slot registrations and the plugin-level
 * terminal store. A typo there would take the whole plugin (and the rail button)
 * down in the WebView, and a browser is exactly what the sandbox does not have.
 *
 * It does not render React: it asserts that apply() completes, that the panel is
 * registered with a store that reuses sessions, and that the locale dictionary
 * carries the strings the panel asks for.
 *
 * Usage: node test/vt-plugin.test.mjs
 */
import { readFileSync } from "node:fs";

const SOURCE = process.env.DSH_VT_SOURCE ?? new URL("../lib/client.js", import.meta.url).pathname;
const text = readFileSync(SOURCE, "utf8");

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

/* --------------------------------------------------------------- fake host */

const registrations = [];
const localeRegistrations = [];
const effects = [];

function fakeContext() {
	const slots = {
		register(definition, component) {
			registrations.push({ definition, component });
			return () => {};
		},
		inject(name, factory) {
			const generator = factory();
			if (generator !== undefined && typeof generator.next === "function") {
				for (let step = generator.next(); !step.done; step = generator.next()) {
					/* the generator registers on its first yield */
				}
			}
			return () => {};
		}
	};
	const locale = {
		bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
		register: (namespace, dictionaries) => {
			localeRegistrations.push({ namespace, dictionaries });
			return () => {};
		}
	};
	return {
		slots,
		locale,
		remote: {
			session: {
				on: () => () => {}
			},
			on: () => () => {}
		},
		effect(callback, label) {
			const disposer = callback();
			effects.push({ label, disposer });
			return () => {};
		},
		on: () => () => {},
		get: () => undefined,
		logger: {
			warn: () => {},
			info: () => {},
			error: () => {}
		}
	};
}

/* The module format the shell uses: a loader that calls the factory. */
let bundle = null;
const moduleLoader = {
	load(record) {
		bundle = record;
	}
};

/* `require` for the modules the bundle asks for. Only what apply() touches. */
const requires = {
	react: {
		createElement: (type, props, ...children) => ({ type, props, children }),
		useRef: () => ({ current: null }),
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect: () => {},
		useLayoutEffect: () => {},
		useSyncExternalStore: () => undefined,
		lazy: () => () => null,
		Suspense: () => null,
		Fragment: "Fragment"
	},
	"react/jsx-runtime": {
		jsx: () => null,
		jsxs: () => null,
		Fragment: "Fragment"
	},
	"@deepseek-ai/dsh-client-ui-primitives": null
};

function fakeRequire(name) {
	if (name === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("not shipped in this test");
	if (requires[name] === undefined) throw new Error(`unexpected require: ${name}`);
	return requires[name];
}

globalThis.window = { __ModuleLoader__: moduleLoader };
let applied = null;
let applyError = null;
try {
	/* eslint-disable-next-line no-new-func */
	new Function("window", `${text}\n`)(globalThis.window);
	ok(bundle !== null, "the bundle registers itself with the module loader");
	equal(bundle.id, "dsh-plugin-android", "under its own id");
	equal(typeof bundle.factory, "function", "with a factory");
	const module = bundle.factory(fakeRequire);
	equal(typeof module.apply, "function", "the factory exports apply()");
	ok(Array.isArray(module.inject), "and an inject list", JSON.stringify(module.inject));
	applied = module;
} catch (error) {
	applyError = error;
	failures++;
	console.error(`FAIL  loading the bundle threw: ${error && error.stack}`);
}

if (applied !== null) {
	try {
		applied.apply(fakeContext());
	} catch (error) {
		applyError = error;
		failures++;
		console.error(`FAIL  apply() threw: ${error && error.stack}`);
	}
}

if (applyError === null) {
	ok(true, "apply() completed against a fake host");
	/* the locale dictionaries carry everything the terminal asks for */
	const dictionary = localeRegistrations.find((entry) => entry.dictionaries.zh !== undefined);
	ok(dictionary !== undefined, "the plugin registered its dictionaries");
	const zh = dictionary === undefined ? {} : dictionary.dictionaries.zh;
	const required = [
		"termTitle", "termClear", "termConnected", "termConnecting", "termDisconnected",
		"termUnavailable", "termReconnect", "termError", "termExited", "termInputLabel",
		"termCopy", "termCopied", "termCopyHint", "termPasteHint", "termJumpToBottom",
		"termTabName", "termNewTab", "termCloseTab", "termTabLimit", "termKeyboardHint",
		"termKeyEsc", "termKeyTab", "termKeyCtrl", "termKeyLeft", "termKeyUp", "termKeyDown",
		"termKeyRight", "termKeyInterrupt"
	];
	const missing = required.filter((key) => typeof zh[key] !== "string");
	equal(missing.length, 0, "every terminal string the panel asks for exists", `  missing: ${missing.join(", ")}`);
	/* the panel was registered into the main slot with a store */
	const main = registrations.find((entry) => entry.definition.name === "main" && entry.definition.key === "android-terminal");
	ok(main !== undefined, "the terminal panel is registered in the main slot");
	if (main !== undefined) {
		equal(typeof main.definition.inject, "function", "with an inject function");
		const props = main.definition.inject("session");
		equal(typeof props.t, "function", "which supplies the translator");
		const store = props.store;
		ok(store !== null && typeof store === "object", "and the plugin-level terminal store");
		if (store !== null && typeof store === "object") {
			for (const method of ["ensure", "openTab", "activate", "close", "closeAll", "session", "snapshot", "subscribe", "touch"]) {
				equal(typeof store[method], "function", `the store exposes ${method}()`);
			}
			/* no DshAndroid in this fake host: ensure() must not create anything */
			ok(store.count() === 0, "an empty roster in a host without a PTY endpoint");
			equal(store.ensure(), null, "ensure() opens nothing without an endpoint");
			equal(store.count(), 0, "and leaves the roster empty");
		}
	}
	/* disposers exist for the effects the plugin registered */
	ok(effects.length >= 3, "the plugin registered its effects", `  effects: ${effects.length}`);
	const terminalEffect = effects.find((entry) => String(entry.label).includes("terminals"));
	ok(terminalEffect !== undefined, "including the one that closes terminals on dispose");
	if (terminalEffect !== undefined && typeof terminalEffect.disposer === "function") {
		terminalEffect.disposer();
		ok(true, "and its disposer runs");
	}
}

console.log(`vt-plugin: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
