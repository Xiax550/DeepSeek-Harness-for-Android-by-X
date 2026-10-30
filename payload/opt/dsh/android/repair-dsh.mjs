/**
 * repair-dsh.mjs — undo a publish-path bug in an already-installed sandbox.
 *
 * An earlier revision of patches/apply-hardlink-patch.py injected a
 * `linkOrCopy()` helper and then let one of its call-site rewrites match the
 * helper's own body, so the helper called itself:
 *
 *     async function linkOrCopy(source, target) {
 *         try { await linkOrCopy(source, target); }   // stack overflow
 *         catch (error) { ... }
 *     }
 *
 * Every path that publishes an immutable file goes through it — attachments
 * (images), the session log, the filesystem writer — so the visible symptom was
 * `Unable to persist attachment` and images that could not be read at all.
 *
 * The payload builds correctly now, but a sandbox that was unpacked from the
 * broken build keeps the file until something rewrites it; the rootfs is not
 * writable by a hot package, and re-sending 190 MB for a two-line fix is the
 * thing the terminal/hot split exists to avoid. So the repair happens here, at
 * boot, from the hot-overlaid start script: idempotent, logged, and a no-op on
 * a sandbox that never had the bug.
 *
 * Usage: node repair-dsh.mjs [node_modules-root]   (default /opt/dsh/node_modules)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILES = [
  ["@deepseek-ai/dsh-attachment-local", "lib/index.js", false],
  ["@deepseek-ai/dsh-session-persistence-jsonl", "lib/index.js", false],
  ["@deepseek-ai/dsh-session-persistence-jsonl", "lib/worker.cjs", true],
  ["@deepseek-ai/dsh-fs-local", "lib/index.js", false],
];

const root = process.argv[2] ?? "/opt/dsh/node_modules";
let repaired = 0;
let checked = 0;

for (const [pkg, relative, cjs] of FILES) {
  const path = join(root, pkg, relative);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  checked++;
  const start = source.indexOf("async function linkOrCopy(source, target) {");
  if (start < 0) continue;
  const end = source.indexOf("\n}", start);
  if (end < 0) continue;
  const body = source.slice(start, end);
  if (!body.includes("await linkOrCopy(source, target);")) continue;
  const call = cjs ? "await node_fs_promises.link(source, target);" : "await link(source, target);";
  writeFileSync(path, source.slice(0, start) + body.replace("await linkOrCopy(source, target);", call) + source.slice(end), "utf8");
  repaired++;
  console.log(`repair-dsh: fixed self-recursive linkOrCopy in ${pkg}/${relative}`);
}

/**
 * The Android PRoot composition can resolve a sandbox/approval pair that does
 * not match any preset. permission-presets then aborts unless the base layer
 * carries an explicit valid default. A profile patch cannot supply this: the
 * constructor reads the bundle config before the profile overlay changes what
 * clients see. Patch the installed base layer once; later boots are no-ops.
 */
function repairPermissionDefault() {
  const path = join(root, "@deepseek-ai", "dsh-base", "cordis.patch.yml");
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return;
  }
  let changed = false;
  let entry = source.indexOf("    - id: permission");
  if (entry < 0) return;
  let next = source.indexOf("\n    - id:", entry + 1);
  let end = next < 0 ? source.length : next;
  let block = source.slice(entry, end);
  if (!/^\s+defaultPreset\s*:/m.test(block)) {
    const config = block.indexOf("      config:");
    if (config < 0) return;
    const insertAt = entry + config + "      config:".length;
    source = source.slice(0, insertAt)
      + "\n        defaultPreset: danger-full-access"
      + source.slice(insertAt);
    changed = true;
    console.log("repair-dsh: added the explicit permission default to dsh-base");
  }
  entry = source.indexOf("    - id: permission");
  next = source.indexOf("\n    - id:", entry + 1);
  end = next < 0 ? source.length : next;
  block = source.slice(entry, end);
  if (!/^\s+read-only\s*:/m.test(block)) {
    const marker = "        presets:\n";
    const presets = block.indexOf(marker);
    if (presets >= 0) {
      const insertAt = entry + presets + marker.length;
      source = source.slice(0, insertAt)
        + "          read-only:\n"
        + "            sandbox: read-only\n"
        + "            approval: ask\n"
        + source.slice(insertAt);
      changed = true;
      console.log("repair-dsh: restored the read-only permission preset");
    }
  }
  if (!changed) return;
  writeFileSync(path, source, "utf8");
  repaired++;
}

repairPermissionDefault();

if (repaired === 0) {
  console.log(`repair-dsh: nothing to fix (${checked} files checked)`);
}
