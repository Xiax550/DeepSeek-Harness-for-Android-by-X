#!/bin/sh
# trim_runtime.sh — drop what the *harness* tree never loads at runtime.
#
# Same reasoning as trim_vendor.sh, but aimed at the ~500 packages installed into
# the payload's /opt/dsh/node_modules: source maps, type declarations, TypeScript
# sources, docs and test trees are not runtime. Nothing package.json promises
# (main / module / browser / exports / bin / types) is ever deleted — if a path is
# named there, it and everything above it stay.
#
# Measured on the hand-built tree on 2026-10-16: 110.5 MiB of dev-only files, plus
# sharp's wasm/musl halves (~9 MiB here, ~27 MiB when npm happened to install both).
#
# Usage: trim_runtime.sh [node_modules-root] [--dry-run]
set -eu

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)/build/rootfs-ubuntu/opt/dsh/node_modules}"
DRY=""
[ "${2:-}" = "--dry-run" ] && DRY="1"
[ -d "$ROOT" ] || { echo "trim_runtime: no such directory: $ROOT" >&2; exit 1; }

python3 - "$ROOT" "$DRY" <<'PY'
import json
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1])
dry = len(sys.argv) > 2 and sys.argv[2]
DEV_DIRS = {"test", "tests", "__tests__", "coverage", "docs", "examples", ".github"}
DEV_SUFFIXES = (".map", ".d.ts", ".d.mts", ".d.cts", ".ts", ".tsx", ".mts", ".cts")
DOC_PREFIXES = ("readme", "changelog", "history", "contributing")
DOC_SUFFIXES = (".md", ".markdown", ".txt", ".rst")

# sharp's CPU/libc-specific halves are dead weight on a glibc arm64 guest: the loader
# reads package.json and never looks at the musl build or the wasm fallback, so these
# go wholesale. Decided up front so their (real) entry points are not mistaken for
# something the trim broke.
img = root / "@img"
drop_whole = [child for child in sorted(img.iterdir())
              if child.is_dir() and ("wasm32" in child.name or "linuxmusl" in child.name)] if img.is_dir() else []


def entry_points(directory):
    """Relative paths package.json promises to resolve; None if it is unreadable."""
    try:
        document = json.loads((directory / "package.json").read_text(encoding="utf-8"))
    except Exception:
        return None
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

    for key in ("main", "module", "browser", "types", "typings", "bin", "exports"):
        walk(document.get(key))
    return paths


def protected(relative, keep):
    return any(relative == path or relative.startswith(path + "/") or path.startswith(relative + "/")
               for path in keep)


def packages():
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name.startswith(".") or child in drop_whole:
            continue
        if child.name.startswith("@"):
            for scoped in sorted(child.iterdir()):
                if scoped.is_dir() and scoped not in drop_whole:
                    yield scoped
        else:
            yield child


removed_bytes = 0
removed_files = 0
removed_dirs = 0
skipped = []
kept_entries = []          # declared paths that exist now: the trim must not remove them

for package in packages():
    keep = entry_points(package)
    if keep is None:
        skipped.append(package.name)
        continue
    for path in keep:
        if (package / path).exists():
            kept_entries.append(package / path)

    for path in sorted(list(package.rglob("*")), key=lambda p: len(p.parts), reverse=True):
        relative = path.relative_to(package).as_posix()
        if protected(relative, keep):
            continue
        if path.is_dir():
            if path.name not in DEV_DIRS:
                continue
            size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
            removed_bytes += size
            removed_dirs += 1
            if not dry:
                shutil.rmtree(path, ignore_errors=True)
        elif path.is_file():
            name = path.name.lower()
            if not (name.endswith(DEV_SUFFIXES)
                    or (name.startswith(DOC_PREFIXES) and name.endswith(DOC_SUFFIXES))):
                continue
            try:
                removed_bytes += path.stat().st_size
            except OSError:
                continue
            removed_files += 1
            if not dry:
                try:
                    path.unlink()
                except OSError as error:
                    print(f"trim_runtime: {relative}: {error}", file=sys.stderr)

for package in drop_whole:
    size = sum(f.stat().st_size for f in package.rglob("*") if f.is_file())
    removed_bytes += size
    removed_dirs += 1
    print(f"  drop @img/{package.name} ({size / 1048576:.1f} MiB)")
    if not dry:
        shutil.rmtree(package, ignore_errors=True)

# Regression guard: every entry point that existed before must still exist. If this
# fires, protected() has a hole — a package would load nothing, in the payload, on a
# device, after a 300 MB download.
missing = [p for p in kept_entries if not p.exists()]
if missing:
    print("trim_runtime: refused to leave a package whose entry point it deleted:", file=sys.stderr)
    for path in missing[:10]:
        print(f"  {path}", file=sys.stderr)
    raise SystemExit(1)

print(f"trim_runtime{'(dry run)' if dry else ''}: freed {removed_bytes / 1048576:.1f} MiB"
      f" ({removed_files} files, {removed_dirs} directories) under {root}")
if skipped:
    print(f"trim_runtime: {len(skipped)} package(s) left untouched (no readable package.json): "
          + ", ".join(skipped[:8]) + ("…" if len(skipped) > 8 else ""))
PY
