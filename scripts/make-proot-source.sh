#!/usr/bin/env bash
# Build the GPL corresponding-source bundle for the PRoot ELF used by DHA.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/out/proot-src-8cf13e99.tar.gz}"
APP_REPO="${OPENMINIS_REPO:-https://github.com/OpenMinis/OpenMinis.git}"
APP_COMMIT="${OPENMINIS_REF:-4ef29002e88db1e20e462ec2ff46916e8a7dcb45}"
PROOT_REPO="${PROOT_REPO:-https://github.com/OpenMinis/proot.git}"
PROOT_COMMIT="${PROOT_COMMIT:-8cf13e997cdc9472997aae19df8050c073c9a86c}"
PROOT_SHA256="${PROOT_SHA256:-f6b0381ab9a066fa620fef0001737fd3cfaf9d22474f013ac48d7861411374ac}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bundle="$tmp/DHA-PROOT-SOURCE"
mkdir -p "$bundle/openminis/deps" "$bundle/proot" "$(dirname "$OUT")"

git init -q "$tmp/app"
git -C "$tmp/app" remote add origin "$APP_REPO"
git -C "$tmp/app" fetch -q --depth 1 origin "$APP_COMMIT"
git -C "$tmp/app" archive FETCH_HEAD deps/build_proot.sh deps/talloc |
  tar -x -C "$bundle/openminis"

git init -q "$tmp/proot"
git -C "$tmp/proot" remote add origin "$PROOT_REPO"
git -C "$tmp/proot" fetch -q --depth 1 origin "$PROOT_COMMIT"
git -C "$tmp/proot" archive FETCH_HEAD |
  tar -x -C "$bundle/proot"

cat > "$bundle/BUILD-INFO.txt" <<EOF
DHA bundled PRoot corresponding source

PRoot ELF sha256: $PROOT_SHA256
PRoot ELF size: 266152
OpenMinis source: $APP_REPO
OpenMinis commit: $APP_COMMIT
PRoot source: $PROOT_REPO
PRoot commit: $PROOT_COMMIT
Build recipe: openminis/deps/build_proot.sh
talloc source: openminis/deps/talloc
Android API: 26
ABI: arm64-v8a
License: GPL-2.0-or-later; see proot/COPYING

The current ELF was matched byte-for-byte against the same entry in the
official OpenMinis 1.13 release APK. Building again with another NDK version
may produce a different ELF; record the new hash if the binary is replaced.
EOF

tar -czf "$OUT" -C "$tmp" DHA-PROOT-SOURCE
sha256sum "$OUT" > "$OUT.sha256"
echo "wrote $OUT"
echo "wrote $OUT.sha256"
