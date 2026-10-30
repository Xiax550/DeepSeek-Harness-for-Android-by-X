#!/bin/sh
# Fetch the PRoot runtime library the APK embeds (lib/arm64-v8a/libproot.so).
#
# The build machine this project grew up on keeps it at
# /var/minis/mounts/Download/libproot.so, a path a CI runner does not have, and the
# repository deliberately carries no binaries. So the file is published once as a
# release asset and fetched here against a pinned sha256.
#
# Provenance: the pinned ELF is byte-identical to the PRoot entry in the public
# OpenMinis 1.13 APK. It is GPL-2.0-or-later and its exact corresponding source
# is recorded in docs/BUILD-PROOT.md. Run scripts/make-proot-source.sh and attach
# the resulting source bundle to releases containing this binary.
#
# Usage: fetch-proot.sh [output-path]   (default build/proot/libproot.so)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build/proot/libproot.so}"

# sha256 of the file shipped in 1.2.0 and also present in OpenMinis 1.13.
PROOT_SHA256="f6b0381ab9a066fa620fef0001737fd3cfaf9d22474f013ac48d7861411374ac"
PROOT_URL="https://github.com/itiswdwa/lanfeiyu/releases/download/v1.2.0/libproot.so"

if [ -f "$OUT" ] && [ "$(sha256sum "$OUT" | cut -d' ' -f1)" = "$PROOT_SHA256" ]; then
  echo "proot: $OUT is up to date ($(wc -c < "$OUT") bytes)"
  exit 0
fi

command -v curl >/dev/null || { echo "proot: need curl" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
echo "proot: downloading libproot.so"
curl -fsSL "$PROOT_URL" -o "$OUT.tmp"

GOT="$(sha256sum "$OUT.tmp" | cut -d' ' -f1)"
[ "$GOT" = "$PROOT_SHA256" ] || {
  echo "proot: sha256 mismatch (got $GOT, want $PROOT_SHA256)" >&2
  rm -f "$OUT.tmp"
  exit 1
}
mv "$OUT.tmp" "$OUT"
echo "proot: installed $OUT ($(wc -c < "$OUT") bytes, sha256 verified)"
