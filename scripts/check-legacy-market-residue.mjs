#!/usr/bin/env node
/**
 * Release assertion: the retired in-house market must not come back.
 *
 * `@local/dsh-market` was replaced by the public npm package `dshmarket` in
 * 1.2.0. Both bundles insert a Loader row with the **same id** (`dsh-market`),
 * so shipping both is not redundant — it is a composition conflict. A stale
 * build tree (`build/rootfs*`) is the realistic way the old package sneaks back
 * into a release, which is exactly what this check is for.
 *
 *   node scripts/check-legacy-market-residue.mjs                 # payload + profile
 *   node scripts/check-legacy-market-residue.mjs --build         # also build/rootfs*
 *   node scripts/check-legacy-market-residue.mjs --root out      # arbitrary artifact dir
 *
 * Exit status: 1 when anything that can ship is still referencing the old
 * bundle, 0 otherwise. Mentions that are *part of the migration itself*
 * (repair-profile's rename map, its tests, documentation) are reported as INFO,
 * not failures — the check must not punish the code that removes the package.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The retired package. */
const LEGACY = '@local/dsh-market';
/** The package that replaced it. */
const REPLACEMENT = 'dshmarket';

const args = process.argv.slice(2);
const roots = [];
let scanBuild = false;
for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--build') scanBuild = true;
    else if (arg === '--root') { roots.push(args[index + 1]); index += 1; }
}
if (roots.length === 0) roots.push('payload', 'profile');
if (scanBuild) roots.push('build/rootfs', 'build/rootfs-ubuntu');

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['.git', '.pnpm', 'node_modules/.cache']);

/** Every file under a root, with vendored package directories reported as units. */
function* walk(root, base = root) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            // A vendored copy of the legacy package is a finding in itself, and
            // walking into it would bury that under a hundred file mentions.
            if (entry.name === 'dsh-market' && join(root, '').endsWith(join('@local', ''))) {
                yield { path, kind: 'package-dir', dir: relative(base, path) };
                continue;
            }
            yield* walk(path, base);
        } else if (entry.isFile()) {
            yield { path, kind: 'file', dir: relative(base, path) };
        }
    }
}

const fatal = [];
const info = [];

/** Text files only; binaries are not where a bundle name hides. */
function readText(path) {
    try {
        if (statSync(path).size > 4 * 1024 * 1024) return undefined;
        return readFileSync(path, 'utf8');
    } catch {
        return undefined;
    }
}

for (const root of roots) {
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        console.log(`SKIP  ${root}（不存在）`);
        continue;
    }
    let files = 0;
    for (const item of walk(root)) {
        files += 1;
        if (item.kind === 'package-dir') {
            fatal.push(`${item.dir}/  ← 发行内容里还带着退役的包目录`);
            continue;
        }
        if (!/\.(json|mjs|cjs|js|yml|yaml)$/u.test(item.path)) continue;
        if (item.path.includes('node_modules/@local/')) continue;
        const text = readText(item.path);
        if (text === undefined || !text.includes(LEGACY)) continue;

        // A manifest that still selects the old bundle ships it; a mention in
        // migration code does not.
        let manifestHit = false;
        try {
            const parsed = JSON.parse(text);
            const bundles = parsed?.dsh?.profile?.bundles;
            const deps = parsed?.dependencies;
            manifestHit = (Array.isArray(bundles) && bundles.includes(LEGACY))
                || (deps !== null && typeof deps === 'object' && Object.hasOwn(deps ?? {}, LEGACY));
        } catch {
            manifestHit = false;
        }
        if (manifestHit) {
            fatal.push(`${item.dir}  ← profile 依赖/bundle 列表里还选着 ${LEGACY}`);
            continue;
        }
        if (/^\s*name:\s*['"]?@local\/dsh-market['"]?\s*$/mu.test(text)) {
            fatal.push(`${item.dir}  ← Loader patch 里还插着 ${LEGACY} 这一行`);
            continue;
        }
        info.push(item.dir);
    }
    console.log(`SCAN  ${root}（${String(files)} 项）`);
}

if (info.length > 0) {
    console.log(`\nINFO  ${String(info.length)} 处提到 ${LEGACY}，属于迁移本身或文档，不算失败：`);
    for (const item of info.slice(0, 12)) console.log(`      ${item}`);
    if (info.length > 12) console.log(`      … 另有 ${String(info.length - 12)} 处`);
}

if (fatal.length > 0) {
    console.error(`\nFAIL  发行内容里仍有退役的 ${LEGACY}（它和 ${REPLACEMENT} 的 Loader 行 id 相同，会合成冲突）：`);
    for (const item of fatal) console.error(`      ${item}`);
    console.error(`\n修法：删掉该目录 / 从 profile 的 dependencies 与 dsh.profile.bundles 里去掉这一行，然后重跑本检查。`);
    process.exit(1);
}

console.log(`\nPASS  发行内容里没有退役的 ${LEGACY}。`);
console.log(`      提醒：本检查只覆盖给定的 root；打包前请对**最终产物**（payload zip / 热包 / APK 内容）再跑一次 --root。`);
