/**
 * Tab roster tests: the "点一下开一个终端" question, answered at the logic level.
 *
 * The panel remounts on every press of the sidebar's 终端 button; the roster lives
 * with the plugin, so these tests are about what a remount costs: `ensure()` five
 * times must open one session, and only an explicit new tab may open another.
 *
 * Usage: node test/vt-store.test.mjs
 */
import { createTerminalStoreFactory } from "./vt-store-loader.mjs";

const createTerminalStore = createTerminalStoreFactory(
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

function makeStore(options = {}) {
	let opened = 0;
	const closed = [];
	const store = createTerminalStore({
		maxTabs: options.maxTabs,
		open: () => {
			opened += 1;
			const id = `s${opened}`;
			return {
				id,
				title: `Terminal ${opened}`,
				status: "ready",
				close: () => closed.push(id)
			};
		}
	});
	return {
		store,
		opened: () => opened,
		closed
	};
}

/* 1. the reported waste: pressing the rail button five times opens one shell */
{
	const harness = makeStore();
	for (let i = 0; i < 5; i++) harness.store.ensure();
	equal(harness.opened(), 1, "five ensure() calls open exactly one session");
	equal(harness.store.count(), 1, "and the roster holds one tab");
	equal(harness.store.snapshot().tabs.length, 1, "the tab strip shows one tab");
}

/* 2. an explicit new tab is the only way to a second session */
{
	const harness = makeStore();
	harness.store.ensure();
	harness.store.openTab();
	harness.store.openTab();
	equal(harness.opened(), 3, "three explicit opens make three sessions");
	equal(harness.store.count(), 3, "all of them are in the roster");
}

/* 3. re-opening the panel with tabs present activates instead of opening */
{
	const harness = makeStore();
	harness.store.ensure();
	harness.store.openTab();
	harness.store.activate("s1");
	harness.store.ensure();
	equal(harness.opened(), 2, "ensure() with tabs present opens nothing");
	equal(harness.store.activeId(), "s1", "and keeps the active tab it had");
}

/* 4. the cap holds, and the panel is told */
{
	const harness = makeStore({
		maxTabs: 3
	});
	equal(harness.store.openTab(), "s1", "first tab opens");
	harness.store.openTab();
	harness.store.openTab();
	equal(harness.store.openTab(), null, "a fourth tab is refused");
	equal(harness.opened(), 3, "and no session was created for it");
	equal(harness.store.snapshot().canOpen, false, "the strip is told it cannot open more");
	harness.store.close("s1");
	equal(harness.store.snapshot().canOpen, true, "closing one makes room again");
}

/* 5. closing a tab ends its session and picks a neighbour */
{
	const harness = makeStore();
	harness.store.ensure();
	harness.store.openTab();
	harness.store.openTab();
	harness.store.activate("s2");
	harness.store.close("s2");
	equal(harness.closed.join(","), "s2", "closing the active tab closed its session");
	equal(harness.store.count(), 2, "two tabs remain");
	ok(harness.store.activeId() === "s3" || harness.store.activeId() === "s1", "a remaining tab became active", `  active: ${harness.store.activeId()}`);
	harness.store.close("nope");
	equal(harness.store.count(), 2, "closing an unknown tab changes nothing");
}

/* 6. closing the last tab leaves an empty roster (the panel opens a fresh one) */
{
	const harness = makeStore();
	harness.store.ensure();
	harness.store.close("s1");
	equal(harness.store.count(), 0, "the roster is empty");
	equal(harness.store.activeId(), null, "and has no active tab");
	harness.store.ensure();
	equal(harness.opened(), 2, "the next ensure opens one again");
}

/* 7. subscribers are told about every change, and one bad listener is contained */
{
	const harness = makeStore();
	let notifications = 0;
	const unsubscribe = harness.store.subscribe(() => {
		notifications += 1;
	});
	harness.store.subscribe(() => {
		throw new Error("bad listener");
	});
	harness.store.ensure();
	harness.store.openTab();
	harness.store.activate("s1");
	harness.store.close("s2");
	ok(notifications >= 4, "the panel was notified for each change", `  notifications: ${notifications}`);
	unsubscribe();
	const before = notifications;
	harness.store.touch();
	equal(notifications, before, "an unsubscribed listener stops hearing about changes");
}

/* 8. closeAll is what plugin disposal does: every session ends */
{
	const harness = makeStore();
	harness.store.ensure();
	harness.store.openTab();
	harness.store.closeAll();
	equal(harness.closed.length, 2, "every session was closed");
	equal(harness.store.count(), 0, "and the roster is empty");
}

/* 9. snapshot is plain data for React */
{
	const harness = makeStore();
	harness.store.ensure();
	const snapshot = harness.store.snapshot();
	equal(typeof snapshot.activeId, "string", "activeId is a string");
	equal(Array.isArray(snapshot.tabs), true, "tabs is an array");
	equal(Object.keys(snapshot.tabs[0]).sort().join(","), "id,status,title", "a tab carries only render data");
	equal(snapshot.maxTabs === undefined ? "unset" : typeof snapshot.maxTabs, "number", "maxTabs ships with the snapshot");
}

/* 10. a session that cannot be created does not corrupt the roster */
{
	let attempts = 0;
	const store = createTerminalStore({
		open: () => {
			attempts += 1;
			return null;
		}
	});
	equal(store.ensure(), null, "a failed open reports null");
	equal(store.count(), 0, "and leaves the roster empty");
	equal(attempts, 1, "the factory was asked once");
}

console.log(`vt-store: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
