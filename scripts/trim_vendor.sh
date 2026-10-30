#!/bin/sh
# trim_vendor.sh — drop what the vendored packages never load at runtime.
#
# Same reasoning as trim_payload.sh (which does this for the harness): what ships in
# the payload is the *runtime*, and a plugin's TypeScript sources, type declarations
# and docs are not part of it. `dshmarket` alone carries 2.2 MB of `src/`, undici
# 0.6 MB of `docs/` + `types/`.
#
# NEVER deleted: anything package.json points at — `main`, `module`, `browser`,
# `types`/`typings` and every `exports` condition (dshmarket's `types` conditions map
# into lib/types/, so those .d.ts files are part of its contract).
#
# After changing this, verify: the entry points resolve, and an isolated instance
# still answers GET /dsh-market/api/v1/capabilities with 200.
#
# Usage: trim_vendor.sh [node_modules-root]   (default: the payload profile)
set -eu

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)/payload/home/.dsh/profiles/web/node_modules}"
[ -d "$ROOT" ] || { echo "trim_vendor: no such directory: $ROOT" >&2; exit 1; }

python3 - "$ROOT" <<'PY'
import json
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1])
PACKAGES = ("dshmarket", "undici", "js-yaml", "argparse")
DEV_DIRS = {"test", "tests", "__tests__", "coverage", "docs", "examples", ".github", "src", "types"}
DEV_SUFFIXES = (".map", ".d.ts", ".d.mts", ".d.cts")


def protected(directory):
    """Relative paths package.json promises to resolve."""
    document = json.loads((directory / "package.json").read_text())
    paths = set()

    def walk(value):
        if isinstance(value, str):
            if value.startswith("./"):
                paths.add(value[2:])
        elif isinstance(value, dict):
            for inner in value.values():
                walk(inner)
        elif isinstance(value, list):
            for inner in value:
                walk(inner)

    for key in ("main", "module", "browser", "types", "typings"):
        walk(document.get(key))
    walk(document.get("exports"))
    return paths


def is_protected(relative, keep):
    return any(relative == path or relative.startswith(path + "/") or path.startswith(relative + "/")
               for path in keep)


def size(directory):
    total = sum(f.stat().st_size for f in directory.rglob("*") if f.is_file())
    return f"{total / 1048576:.1f}MB"


print(f"before: {size(root)}")
for name in PACKAGES:
    directory = root / name
    if not directory.is_dir():
        print(f"  skip {name} (not vendored here)")
        continue
    before = size(directory)
    keep = protected(directory)
    removed = 0

    for file in sorted(directory.rglob("*")):
        if not file.is_file():
            continue
        relative = file.relative_to(directory).as_posix()
        if is_protected(relative, keep):
            continue
        if file.name.endswith(DEV_SUFFIXES) or (file.suffix == ".md" and not file.name.startswith("LICENSE")):
            file.unlink()
            removed += 1

    for candidate in sorted((d for d in directory.rglob("*") if d.is_dir()), reverse=True):
        relative = candidate.relative_to(directory).as_posix()
        if candidate.name not in DEV_DIRS:
            continue
        if is_protected(relative, keep):
            continue
        shutil.rmtree(candidate, ignore_errors=True)
        removed += 1

    # the contract must have survived, or the trim is wrong
    missing = [path for path in sorted(keep) if "*" not in path and not (directory / path).exists()]
    if missing:
        print(f"  ERROR {name}: entry point missing after trim: {missing}", file=sys.stderr)
        sys.exit(1)
    print(f"  {name}: {before} -> {size(directory)} ({removed} entries removed)")

print(f"after:  {size(root)}")
PY
