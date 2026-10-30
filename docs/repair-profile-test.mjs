/**
 * repair-profile.mjs checks: additive, idempotent, never destructive — now including
 * the dshmarket swap (public npm package replaces the self-built @local/dsh-market).
 *
 * The states that matter for the swap:
 *   only public   nothing to migrate; the other rows are topped up
 *   both          the retired bundle row goes, its dependency row and files stay
 *   only local    the public row is added, then the retired row goes
 *   files absent  nothing is added and the retired row is KEPT (a working market
 *                 beats a tidy bundle list)
 *
 * Run: node docs/repair-profile-test.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const SCRIPT = join(ROOT, "payload/opt/dsh/android/repair-profile.mjs");
const SEED = "/tmp/repair-test-seed";
let checks = 0;
let failures = 0;

function check(condition, what, detail) {
	checks++;
	if (condition) return;
	failures++;
	console.error(`FAIL  ${what}`);
	if (detail !== undefined) console.error(`      ${detail}`);
}

function makeSeed() {
	rmSync(SEED, { recursive: true, force: true });
	mkdirSync(join(SEED, "profiles", "web"), { recursive: true });
	cpSync(join(ROOT, "profile/package.json"), join(SEED, "profiles", "web", "package.json"));
	cpSync(join(ROOT, "profile/cordis.patch.yml"), join(SEED, "profiles", "web", "cordis.patch.yml"));
}

function run(home) {
	return execFileSync(process.execPath, [SCRIPT, SEED, home], { encoding: "utf8" });
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** A guest whose profile already exists, with the given rows and installed packages. */
function homeWith(name, { dependencies, bundles, packages }) {
	const home = `/tmp/repair-test-${name}`;
	rmSync(home, { recursive: true, force: true });
	const dir = join(home, ".dsh", "profiles", "web");
	mkdirSync(join(dir, "node_modules"), { recursive: true });
	for (const pkg of packages) {
		mkdirSync(join(dir, "node_modules", pkg), { recursive: true });
		writeFileSync(join(dir, "node_modules", pkg, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
	}
	writeFileSync(join(dir, "package.json"), JSON.stringify({
		name: "dsh-profile-web", private: true, dependencies, dsh: { profile: { bundles } },
	}, null, 2));
	writeFileSync(join(dir, "cordis.patch.yml"), "# user patch layer\n- id: ui-theme\n  config:\n    preference: light\n");
	return { home, dir };
}

const BASE = "@deepseek-ai/dsh-base";
const WEB = "@deepseek-ai/dsh-web-app";
const LOCAL_MARKET = "@local/dsh-market";
const OTHER_LOCAL = ["@local/agent-browser-viewer", "@local/dsh-ball-summarizer"];
const ALL_PACKAGES = ["dshmarket", "dsh-plugin-android", ...OTHER_LOCAL, LOCAL_MARKET];
const MY_OWN = "@deepseek-ai/dsh-experimental-voice-input-bundle";

makeSeed();

/* 1. only the public package: nothing to migrate, other rows topped up */
{
	const { home, dir } = homeWith("public-only", {
		dependencies: { dshmarket: "file:./node_modules/dshmarket" },
		bundles: [BASE, WEB, "dshmarket"],
		packages: ALL_PACKAGES,
	});
	const out = run(home);
	const doc = readJson(join(dir, "package.json"));
	check(out.includes("added bundle @local/agent-browser-viewer"), "tops up the other rows");
	check(out.includes(LOCAL_MARKET) === false, "says nothing about the retired package");
	check(doc.dsh.profile.bundles.includes("dshmarket"), "keeps the public row");
	check(!doc.dsh.profile.bundles.includes(LOCAL_MARKET), "no retired row is introduced");
	const patch = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
	check(!/^\s+dha-local\s*:/m.test(patch), "does not add the retired local provider");
	check(!patch.includes("127.0.0.1:8398"), "does not add a llama-server route");
}

/* 2. both rows (an upgraded device): the retired bundle row goes, nothing else does */
{
	const { home, dir } = homeWith("both", {
		dependencies: {
			dshmarket: "file:./node_modules/dshmarket",
			[LOCAL_MARKET]: "file:./node_modules/@local/dsh-market",
		},
		bundles: [BASE, WEB, "dshmarket", LOCAL_MARKET, MY_OWN],
		packages: ALL_PACKAGES,
	});
	const out = run(home);
	const doc = readJson(join(dir, "package.json"));
	check(out.includes(`retired bundle row ${LOCAL_MARKET}`), "reports the retirement");
	check(!doc.dsh.profile.bundles.includes(LOCAL_MARKET), "retired bundle row is gone");
	check(doc.dsh.profile.bundles.includes("dshmarket"), "public row survives");
	check(doc.dsh.profile.bundles.includes(MY_OWN), "the user's own row survives");
	check(doc.dependencies[LOCAL_MARKET] === "file:./node_modules/@local/dsh-market",
		"the dependency row is left alone (hand-reversible)");
	check(existsSync(join(dir, "node_modules", LOCAL_MARKET, "package.json")), "and its files are not deleted");
	const before = readFileSync(join(dir, "package.json"), "utf8");
	check(run(home).includes("nothing to repair"), "second run is a no-op");
	check(readFileSync(join(dir, "package.json"), "utf8") === before, "…byte-identical");
}

/* 3. only the self-built market: public row added, then the retired row goes */
{
	const { home, dir } = homeWith("local-only", {
		dependencies: { [LOCAL_MARKET]: "file:./node_modules/@local/dsh-market" },
		bundles: [BASE, WEB, LOCAL_MARKET],
		packages: ALL_PACKAGES,
	});
	const out = run(home);
	const doc = readJson(join(dir, "package.json"));
	check(out.includes("added bundle dshmarket"), "adds the public bundle row");
	check(out.includes(`retired bundle row ${LOCAL_MARKET}`), "retires the self-built row");
	check(doc.dsh.profile.bundles.includes("dshmarket"), "public row present");
	check(!doc.dsh.profile.bundles.includes(LOCAL_MARKET), "self-built row gone");
	check(doc.dependencies.dshmarket === "file:./node_modules/dshmarket", "public dependency added");
}

/* 4. conservative: the public package is not on disk -> keep the working market */
{
	const { home, dir } = homeWith("files-absent", {
		dependencies: { [LOCAL_MARKET]: "file:./node_modules/@local/dsh-market" },
		bundles: [BASE, WEB, LOCAL_MARKET],
		packages: ["dsh-plugin-android", ...OTHER_LOCAL, LOCAL_MARKET],   // no dshmarket
	});
	const out = run(home);
	const doc = readJson(join(dir, "package.json"));
	check(out.includes("kept retired"), "keeps the retired row when the replacement is missing");
	check(out.includes("skipped bundle dshmarket"), "and does not add a row without files");
	check(doc.dsh.profile.bundles.includes(LOCAL_MARKET), "the old market still loads");
	check(!doc.dsh.profile.bundles.includes("dshmarket"), "no row without files");
}

/* 5. package installed but its bundle row is off: restore the built-in market */
{
	const { home, dir } = homeWith("market-disabled", {
		dependencies: { dshmarket: "file:./node_modules/dshmarket" },
		bundles: [BASE, WEB],
		packages: ALL_PACKAGES,
	});
	const out = run(home);
	const doc = readJson(join(dir, "package.json"));
	const patch = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
	check(out.includes("added bundle dshmarket"), "re-enables the installed market bundle");
	check(doc.dsh.profile.bundles.includes("dshmarket"), "market bundle row is present");
	check(/^\s*-\s*id:\s*dsh-market\s*$/m.test(patch), "adds the market config row");
	check(/region:\s*china/m.test(patch), "defaults the market download route to china");
}

/* 6. migrate only an automatically probed global region */
{
	const { home, dir } = homeWith("market-auto-region", {
		dependencies: { dshmarket: "file:./node_modules/dshmarket" },
		bundles: [BASE, WEB, "dshmarket"],
		packages: ALL_PACKAGES,
	});
	mkdirSync(join(dir, ".dsh-market"), { recursive: true });
	const statePath = join(dir, ".dsh-market", "state.json");
	writeFileSync(statePath, JSON.stringify({ region: "global", regionAuto: true, disabled: [] }, null, 2));
	const out = run(home);
	const state = readJson(statePath);
	check(out.includes("migrated the legacy"), "reports the legacy-region migration");
	check(state.region === "china", "legacy global is migrated to china");
	check(state.regionAuto === false, "migration records an explicit effective route");
	check(existsSync(join(dir, ".dsh-market", ".dha-region-default-v1")), "migration marker is written");
}

/* 7. a global region selected after migration must survive */
{
	const { home, dir } = homeWith("market-manual-region", {
		dependencies: { dshmarket: "file:./node_modules/dshmarket" },
		bundles: [BASE, WEB, "dshmarket"],
		packages: ALL_PACKAGES,
	});
	mkdirSync(join(dir, ".dsh-market"), { recursive: true });
	const statePath = join(dir, ".dsh-market", "state.json");
	const before = JSON.stringify({ region: "global", disabled: [] }, null, 2);
	writeFileSync(statePath, before);
	writeFileSync(join(dir, ".dsh-market", ".dha-region-default-v1"), "migrated\n");
	run(home);
	check(readFileSync(statePath, "utf8") === before, "manual global choice is byte-identical");
}

/* 8. broken profile: untouched, exit 0 */
{
	const home = "/tmp/repair-test-broken";
	rmSync(home, { recursive: true, force: true });
	mkdirSync(join(home, ".dsh", "profiles", "web"), { recursive: true });
	const dir = join(home, ".dsh", "profiles", "web");
	writeFileSync(join(dir, "package.json"), "{ not json at all");
	writeFileSync(join(dir, "cordis.patch.yml"), "# nothing here\n");
	const before = readFileSync(join(dir, "package.json"), "utf8");
	let exitCode = 0;
	let out = "";
	try {
		out = run(home);
	} catch (error) {
		exitCode = error.status ?? 1;
		out = String(error.stdout ?? "");
	}
	check(exitCode === 0, "malformed package.json does not fail the boot");
	check(readFileSync(join(dir, "package.json"), "utf8") === before, "…and the file is byte-identical");
	check(readFileSync(join(dir, "cordis.patch.yml"), "utf8").includes("android-sandbox"), "the plugin row is still added");
}

/* 9. remove the retired standalone and pi-ai local-model rows */
{
	const { home, dir } = homeWith("local-model-adapter-migration", {
		dependencies: { dshmarket: "file:./node_modules/dshmarket" },
		bundles: [BASE, WEB, "dshmarket"],
		packages: ALL_PACKAGES,
	});
	const patchPath = join(dir, "cordis.patch.yml");
	writeFileSync(patchPath, [
		"# user patch layer",
		"- insert:",
		"    - id: dha-local-model",
		"      name: '@deepseek-ai/dsh-llm-pi-ai'",
		"      config:",
		"        providers: {}",
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      dha-local:",
		"        displayName: DHA 本地模型",
		"        baseURL: http://127.0.0.1:8398/v1",
		""
	].join("\n"));
	run(home);
	const patch = readFileSync(patchPath, "utf8");
	check(!patch.includes("dha-local-model"), "removes the obsolete standalone adapter");
	check(!/^\s+dha-local\s*:/m.test(patch), "removes the local provider route");
	check(!/^\s*-\s*id:\s*llm-pi-ai\s*$/m.test(patch), "removes the now-empty pi-ai row");
}

/* 10. the shipped seed itself must not reference the retired package */
{
	const seed = JSON.parse(readFileSync(join(ROOT, "profile/package.json"), "utf8"));
	check(!Object.keys(seed.dependencies).includes(LOCAL_MARKET), "seed profile has no retired dependency");
	check(!seed.dsh.profile.bundles.includes(LOCAL_MARKET), "seed profile has no retired bundle row");
	check(seed.dsh.profile.bundles.includes("dshmarket"), "seed profile selects the public market");
}

/* 11. remove only dha-local and preserve unrelated pi-ai providers. */
{
	const { home, dir } = homeWith("local-provider-removal", {
		dependencies: { dshmarket: "file:./node_modules/dshmarket" },
		bundles: [BASE, WEB, "dshmarket"],
		packages: ALL_PACKAGES,
	});
	const patchPath = join(dir, "cordis.patch.yml");
	writeFileSync(patchPath, [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      dha-local:",
		"        defaultContextWindow: 32768",
		"        defaultMaxTokens: 512",
		"        models:",
		"          - id: local-vision",
		"            name: SmolVLM 256M 本地",
		"            contextWindow: 32768",
		"            maxTokens: 512",
		"      openai-compatible:",
		"        displayName: User provider",
		"        baseURL: https://example.invalid/v1",
		"        models:",
		"          - id: user-image-model",
		"            name: User image model",
		"            inputModalities: [text, image]",
		"      second-provider:",
		"        displayName: Second provider",
		"        apiKeyEnv: SECOND_KEY",
		"- id: agent-default-model",
		"  config:",
		"    provider: openai-compatible",
		"    model: user-image-model",
		""
	].join("\n"));
	run(home);
	const patch = readFileSync(patchPath, "utf8");
	check(!/^\s+dha-local\s*:/m.test(patch), "removes the retired local provider");
	check(!patch.includes("local-vision") && !patch.includes("SmolVLM"), "removes local model declarations");
	check(patch.includes("openai-compatible:"), "keeps an unrelated provider");
	check(patch.includes("https://example.invalid/v1"), "keeps unrelated provider settings");
	check(patch.includes("user-image-model") && patch.includes("inputModalities: [text, image]"),
		"keeps custom model catalog entries");
	check(patch.includes("second-provider:") && patch.includes("SECOND_KEY"),
		"keeps every user provider");
	check(/^\s*-\s*id:\s*agent-default-model\s*$/m.test(patch),
		"keeps the selected default model row");
	check(/^\s*-\s*id:\s*llm-pi-ai\s*$/m.test(patch), "keeps the pi-ai row while it has another provider");
}

rmSync(SEED, { recursive: true, force: true });
console.log(`repair-profile: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
