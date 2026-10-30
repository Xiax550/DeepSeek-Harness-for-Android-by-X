/**
 * repair-profile.mjs — top up the seeded profile on a guest that already has one.
 *
 * `start-dsh.sh` copies the whole seed only when `profiles/web/package.json` is
 * missing, because that file is *user data*: the bundle list in it is whatever
 * the user has made of their profile. Two consequences, both seen in the wild:
 *
 *   1. A build that adds a bundle row (the two `@local` plugins here) can never
 *      reach a device that already installed an earlier build — the seed is not
 *      copied again, so the packages sit on disk unloaded.
 *   2. The 1.1.5 fresh-install bug (issue #3) left profiles without the
 *      `android-sandbox` patch row, which is what registers the app's plugin —
 *      and both of the ways to fix that live inside the plugin that never
 *      loaded, so the user cannot dig themselves out.
 *
 * So this repairs per file, additively: missing files are copied from the seed,
 * missing rows are appended, and *nothing that already exists is rewritten*.
 * Every failure is logged and swallowed — a profile repair must never be the
 * reason a sandbox does not boot.
 *
 * Usage: node repair-profile.mjs [seed-dir] [home-dir]
 *        defaults: /opt/dsh/dsh-home-seed and $DSH_HOME (then $HOME, then /root)
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const seed = process.argv[2] ?? "/opt/dsh/dsh-home-seed";
const home = process.argv[3] ?? process.env.DSH_HOME ?? process.env.HOME ?? "/root";
const builtinRoot = process.argv[4] ?? "/opt/dsh/android/builtin-meow-memory";
const profile = join(home, ".dsh", "profiles", "web");
const seedProfile = join(seed, "profiles", "web");

/**
 * Bundle rows this build promises, `name -> file: specifier`. Kept in step with
 * `profile/package.json` (the seed) and with
 * `payload/home/.dsh/profiles/web/node_modules/@local/`.
 */
const BUNDLES = {
	"dshmarket": "file:./node_modules/dshmarket",
	"meow-memory": "0.31.0",
	"@local/agent-browser-viewer": "file:./node_modules/@local/agent-browser-viewer",
	"@local/dsh-ball-summarizer": "file:./node_modules/@local/dsh-ball-summarizer"
};

/**
 * Rows that used to ship and no longer do: `retired -> replacement`.
 *
 * Only the *bundle* row is dropped — the dependency row and the directory stay, so
 * the change is reversible by hand (put the name back into `dsh.profile.bundles`) and
 * nothing the user might have edited is deleted. The self-built market was replaced
 * by the public npm package `dshmarket` (see THIRD_PARTY.md), and we only drop the
 * old row once the replacement is actually in place: if `dshmarket` cannot be added
 * (missing files, unparsable profile), the old row is left exactly as it was — a
 * device with a working market beats a tidy bundle list.
 */
const RETIRED = {
	"@local/dsh-market": "dshmarket"
};

/** The patch row the app's settings page and terminal button live behind. */
const PATCH_MARKER = "android-sandbox";

let changed = 0;

function log(line) {
	console.log(`repair-profile: ${line}`);
}

/**
 * Is this bundle's package actually on disk?
 *
 * A row without files is worse than a missing row: the loader fails on the whole
 * bundle and the user loses the feature (the market tab, say) with no way to tell
 * why. The hot overlay writes these packages, so the check also makes the repair
 * self-healing - the row lands on the next boot after the files arrive.
 */
function installed(name) {
	return existsSync(join(profile, "node_modules", name, "package.json"));
}

/** Compare the numeric release prefix; prerelease labels are deliberately ignored. */
function releaseParts(version) {
	if (typeof version !== "string") return [];
	return version.split(/[.+-]/u).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function olderVersion(left, right) {
	const a = releaseParts(left);
	const b = releaseParts(right);
	if (a.length !== 3 || b.length !== 3) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] < b[i];
	}
	return false;
}

/**
 * Seed the bundled release only as a minimum. A package the market has already
 * updated past this build's version must survive every later app launch.
 */
function seedBuiltin(name) {
	const source = join(builtinRoot);
	const target = join(profile, "node_modules", name);
	if (!existsSync(join(source, "package.json"))) return;
	let builtinVersion = "";
	let installedVersion = "";
	try {
		builtinVersion = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
		if (existsSync(join(target, "package.json"))) {
			installedVersion = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;
		}
	} catch {
		return;
	}
	if (installedVersion !== "" && !olderVersion(installedVersion, builtinVersion)) return;
	mkdirSync(join(profile, "node_modules"), { recursive: true });
	if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	cpSync(source, target, { recursive: true, force: true });
	changed += 1;
	log(`seeded ${name} ${builtinVersion}${installedVersion === "" ? "" : ` over ${installedVersion}`}`);
}

/** Copy a seed file in place when the guest has none. */
function seedFile(name) {
	const target = join(profile, name);
	if (existsSync(target)) return false;
	const source = join(seedProfile, name);
	if (!existsSync(source)) return false;
	mkdirSync(profile, { recursive: true });
	copyFileSync(source, target);
	changed += 1;
	log(`seeded ${name}`);
	return true;
}

/** package.json: append the missing dependency and bundle rows, keep the rest. */
function repairPackageJson() {
	if (seedFile("package.json")) return;
	const target = join(profile, "package.json");
	let document;
	try {
		document = JSON.parse(readFileSync(target, "utf8"));
	} catch (error) {
		log(`package.json is not JSON (${error.message}); left as it is`);
		return;
	}
	if (document === null || typeof document !== "object" || Array.isArray(document)) return;
	const dependencies = document.dependencies ?? (document.dependencies = {});
	if (dependencies === null || typeof dependencies !== "object") return;
	const dsh = document.dsh ?? (document.dsh = {});
	const profileSection = dsh !== null && typeof dsh === "object"
		? (dsh.profile ?? (dsh.profile = {}))
		: null;
	if (profileSection === null || typeof profileSection !== "object") return;
	const bundles = Array.isArray(profileSection.bundles) ? profileSection.bundles : (profileSection.bundles = []);
	let touched = false;
	for (const [name, specifier] of Object.entries(BUNDLES)) {
		const migrateLocalMeow = name === "meow-memory"
			&& typeof dependencies[name] === "string"
			&& dependencies[name].startsWith("file:");
		if (dependencies[name] === undefined || migrateLocalMeow) {
			dependencies[name] = specifier;
			touched = true;
			log(`${migrateLocalMeow ? "restored registry" : "added"} dependency ${name}`);
		}
		if (!bundles.includes(name)) {
			if (!installed(name)) {
				log(`skipped bundle ${name}: package not on disk yet`);
				continue;
			}
			bundles.push(name);
			touched = true;
			log(`added bundle ${name}`);
		}
	}
	// Retire rows that no longer ship — but only when the replacement is present,
	// and only the bundle row (the dependency row and the directory stay, so the
	// user can undo this by hand; see RETIRED).
	for (const [old, replacement] of Object.entries(RETIRED)) {
		if (!bundles.includes(old)) continue;
		if (!bundles.includes(replacement) || !installed(replacement)) {
			log(`kept retired ${old}: replacement ${replacement} is not ready`
				+ (installed(replacement) ? "" : " (package not on disk)"));
			continue;
		}
		profileSection.bundles = bundles.filter((row) => row !== old);
		touched = true;
		log(`retired bundle row ${old} (replaced by ${replacement}; dependency row and files kept)`);
	}
	if (!touched) return;
	// Re-serialising keeps every existing key and value; only the missing rows
	// are new. Two-space indent matches what the harness writes.
	writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
	changed += 1;
}

/** cordis.patch.yml: the app's plugin row, appended verbatim from the seed. */
function repairPatchFile() {
	if (seedFile("cordis.patch.yml")) return;
	const target = join(profile, "cordis.patch.yml");
	let text;
	try {
		text = readFileSync(target, "utf8");
	} catch {
		return;
	}
	if (text.includes(PATCH_MARKER)) return;
	const block = seedPatchBlock();
	if (block === null) {
		log("the seed has no android-sandbox row to copy");
		return;
	}
	const separator = text === "" || text.endsWith("\n") ? "" : "\n";
	writeFileSync(target, `${text}${separator}\n${block}\n`);
	changed += 1;
	log(`appended the ${PATCH_MARKER} row`);
}

/**
 * The Android PRoot executor can compose a sandbox mode and approval policy
 * that match no named preset. permission-presets then refuses to start unless
 * a valid default is explicit, leaving the entire Permissions settings row
 * disabled. Add only the missing default; an existing user choice wins.
 */
function repairPermissionConfig() {
	const target = join(profile, "cordis.patch.yml");
	if (!existsSync(target)) return;
	let text;
	try {
		text = readFileSync(target, "utf8");
	} catch {
		return;
	}
	const block = [
		"- id: permission",
		"  config:",
		"    defaultPreset: danger-full-access",
		"    presets:",
		"      read-only:",
		"        sandbox: read-only",
		"        approval: ask",
		"      workspace-write:",
		"        sandbox: workspace-write",
		"        approval: ask",
		"      danger-full-access:",
		"        sandbox: danger-full-access",
		"        approval: never"
	];
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.trim() === "- id: permission");
	let current = [];
	if (start >= 0) {
		let end = start + 1;
		while (end < lines.length && !/^- /.test(lines[end])) end++;
		current = lines.slice(start, end);
	}
	const joined = current.join("\n");
	const complete = /^\s+defaultPreset\s*:/m.test(joined)
		&& /^\s+read-only\s*:/m.test(joined)
		&& /^\s+workspace-write\s*:/m.test(joined)
		&& /^\s+danger-full-access\s*:/m.test(joined);
	if (complete) return;
	if (start >= 0) {
		lines.splice(start, current.length, ...block);
	} else {
		while (lines.length > 0 && lines.at(-1) === "") lines.pop();
		lines.push("", "# DHA: make the permission preset service start on PRoot.",
			...block, "");
	}
	writeFileSync(target, lines.join("\n"));
	changed += 1;
        log("restored the complete permission preset configuration");
}

/**
 * A fresh profile should open in light mode instead of inheriting the phone's
 * system theme. Only add the row when the user has never chosen a theme.
 */
function repairThemeDefault() {
        const target = join(profile, "cordis.patch.yml");
        if (!existsSync(target)) return;
        let text;
        try {
                text = readFileSync(target, "utf8");
        } catch {
                return;
        }
        if (/^\s*-\s*id:\s*ui-theme\s*$/m.test(text)) return;
        const block = [
                "# DHA: default to light mode instead of following the phone theme.",
                "- id: ui-theme",
                "  name: \"@deepseek-ai/dsh-client-ui-theme\"",
                "  config:",
                "    preference: light"
        ];
        while (text.endsWith("\n")) text = text.slice(0, -1);
        writeFileSync(target, `${text}${text ? "\n\n" : ""}${block.join("\n")}\n`);
        changed += 1;
        log("defaulted the appearance preference to light");
}

function topLevelBlocks(lines) {
        const blocks = [];
        for (let index = 0; index < lines.length; index++) {
                if (!/^- /.test(lines[index])) continue;
                let end = index + 1;
                while (end < lines.length && !/^- /.test(lines[end])) end++;
                blocks.push({ start: index, end, lines: lines.slice(index, end) });
                index = end - 1;
        }
        return blocks;
}

/**
 * Remove the retired on-device multimodal provider from profiles written by
 * 1.2.31 through 1.2.36. Other pi-ai providers and user configuration remain
 * byte-for-byte intact.
 */
function removeLegacyLocalModelPatch() {
        const target = join(profile, "cordis.patch.yml");
        if (!existsSync(target)) return;
        let text;
        try {
                text = readFileSync(target, "utf8");
        } catch {
                return;
        }
        let lines = text.split("\n");
        let touched = false;

        // Very early builds inserted a second pi-ai adapter just for the local
        // model. It is invalid once the provider disappears, so remove that row.
        for (const block of topLevelBlocks(lines).reverse()) {
                const body = block.lines.join("\n");
                if (body.includes("- id: dha-local-model")
                    && !body.includes("- id: android-sandbox")) {
                        lines.splice(block.start, block.end - block.start);
                        touched = true;
                        log("removed the obsolete standalone local-model adapter");
                }
        }

        let block = topLevelBlocks(lines).find((candidate) =>
                candidate.lines.some((line) => line.trim() === "- id: llm-pi-ai"));
        if (block !== undefined) {
                const routeStart = lines.findIndex((line, index) =>
                        index >= block.start && index < block.end
                        && /^\s+dha-local\s*:\s*$/.test(line));
                if (routeStart >= 0) {
                        const indent = lines[routeStart].match(/^\s*/)?.[0].length ?? 0;
                        let routeEnd = routeStart + 1;
                        while (routeEnd < block.end) {
                                const line = lines[routeEnd];
                                const nextIndent = line.match(/^\s*/)?.[0].length ?? 0;
                                if (line.trim() !== "" && nextIndent <= indent) break;
                                routeEnd++;
                        }
                        lines.splice(routeStart, routeEnd - routeStart);
                        touched = true;
                        log("removed the retired local multimodal provider");
                }

                block = topLevelBlocks(lines).find((candidate) =>
                        candidate.lines.some((line) => line.trim() === "- id: llm-pi-ai"));
                if (block !== undefined) {
                        const providers = lines.findIndex((line, index) =>
                                index >= block.start && index < block.end
                                && /^\s+providers:\s*$/.test(line));
                        if (providers >= 0) {
                                const providerIndent = lines[providers].match(/^\s*/)?.[0].length ?? 0;
                                let hasProvider = false;
                                for (let index = providers + 1; index < block.end; index++) {
                                        const line = lines[index];
                                        if (line.trim() === "" || line.trim().startsWith("#")) continue;
                                        const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
                                        if (lineIndent <= providerIndent) break;
                                        if (lineIndent === providerIndent + 2) {
                                                hasProvider = true;
                                                break;
                                        }
                                }
                                if (!hasProvider) {
                                        lines.splice(providers, 1);
                                        touched = true;
                                }
                        }
                }

                block = topLevelBlocks(lines).find((candidate) =>
                        candidate.lines.some((line) => line.trim() === "- id: llm-pi-ai"));
                if (block !== undefined) {
                        const config = lines.findIndex((line, index) =>
                                index >= block.start && index < block.end
                                && /^\s+config:\s*$/.test(line));
                        if (config >= 0) {
                                const configIndent = lines[config].match(/^\s*/)?.[0].length ?? 0;
                                let hasChild = false;
                                for (let index = config + 1; index < block.end; index++) {
                                        const line = lines[index];
                                        if (line.trim() === "" || line.trim().startsWith("#")) continue;
                                        const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
                                        if (lineIndent <= configIndent) break;
                                        hasChild = true;
                                        break;
                                }
                                if (!hasChild) {
                                        lines.splice(config, 1);
                                        touched = true;
                                }
                        }
                }

                block = topLevelBlocks(lines).find((candidate) =>
                        candidate.lines.some((line) => line.trim() === "- id: llm-pi-ai"));
                if (block !== undefined) {
                        const useful = block.lines.some((line) => {
                                const value = line.trim();
                                return value !== ""
                                        && !value.startsWith("#")
                                        && !/^-\s*id:\s*llm-pi-ai\s*$/.test(value)
                                        && !/^name:\s*/.test(value);
                        });
                        if (!useful) {
                                lines.splice(block.start, block.end - block.start);
                                touched = true;
                        }
                }
        }
        if (touched) {
                writeFileSync(target, `${lines.join("\n").replace(/\n*$/u, "")}\n`);
                changed += 1;
        }
}

/**
 * The public catalog is hosted on GitHub Pages. A direct global request can
 * stall on mainland mobile networks, which makes the market look as though it
 * never opens. Configure the market's built-in China route for new profiles.
 * An existing top-level row belongs to the user and is left untouched.
 */
function repairMarketPatch() {
        const target = join(profile, "cordis.patch.yml");
        if (!existsSync(target)) return;
        let text;
        try {
                text = readFileSync(target, "utf8");
        } catch {
                return;
        }
        if (/^\s*-\s*id:\s*dsh-market\s*$/m.test(text)) return;
        const block = [
                "# DHA: use the npm mirror for the initial plugin catalog on mainland networks.",
                "- id: dsh-market",
                "  config:",
                "    region: china"
        ];
        while (text.endsWith("\n")) text = text.slice(0, -1);
        writeFileSync(target, `${text}${text ? "\n\n" : ""}${block.join("\n")}\n`);
        changed += 1;
        log("defaulted the plugin-market download region to china");
}

/**
 * The market used to probe the network and persist "global" as an automatic
 * choice. Migrate only that automatic value. A user who explicitly chose global
 * has `regionAuto` cleared, so their choice is preserved.
 */
function repairAutomaticMarketRegion() {
        const target = join(profile, ".dsh-market", "state.json");
        if (!existsSync(target)) return;
        const marker = join(profile, ".dsh-market", ".dha-region-default-v1");
        if (existsSync(marker)) return;
        let state;
        try {
                state = JSON.parse(readFileSync(target, "utf8"));
        } catch (error) {
                log(`plugin-market state is not JSON (${error.message}); left as it is`);
                return;
        }
        if (state === null || typeof state !== "object" || Array.isArray(state)) return;
        if (state.region === "global") {
                state.region = "china";
                state.regionAuto = false;
                writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
                log("migrated the legacy plugin-market region to china");
        }
        writeFileSync(marker, "DHA 1.2.25 default market region migration\n");
        changed += 1;
}

/** The seed's entry that mentions the marker, taken whole (its `- ` line to the next). */
function seedPatchBlock() {
	const source = join(seedProfile, "cordis.patch.yml");
	if (!existsSync(source)) return null;
	let text;
	try {
		text = readFileSync(source, "utf8");
	} catch {
		return null;
	}
	if (!text.includes(PATCH_MARKER)) return null;
	const lines = text.split("\n");
	const marker = lines.findIndex((line) => line.includes(PATCH_MARKER));
	if (marker < 0) return null;
	let start = marker;
	while (start > 0 && !/^- /.test(lines[start])) start -= 1;
	if (!/^- /.test(lines[start])) return null;
	let end = start + 1;
	while (end < lines.length && !/^- /.test(lines[end])) end += 1;
	return lines.slice(start, end).join("\n").replace(/\s+$/u, "");
}

try {
        seedBuiltin("meow-memory");
        repairPackageJson();
        repairPatchFile();
        repairMarketPatch();
        repairAutomaticMarketRegion();
        repairPermissionConfig();
        repairThemeDefault();
        removeLegacyLocalModelPatch();
} catch (error) {
	log(`skipped (${error.message})`);
}
log(changed === 0 ? "nothing to repair" : `${changed} file(s) topped up`);
