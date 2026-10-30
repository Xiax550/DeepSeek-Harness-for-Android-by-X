#!/bin/sh
# Fetch the pnpm binary the payload ships (issue #4: "预装 pnpm").
#
# Why it is fetched instead of committed: the self-contained linux-arm64 pnpm is
# 41 MB. In git it would sit in the history of every clone forever, and it only
# ever changes when pnpm itself is upgraded — the wrong thing to keep in a source
# repository. The *pinned* version and both hashes live here, so the artifact is
# reproducible: the tarball is verified against npm's own sha512 of the published
# package, then the extracted binary against the sha256 measured from the build
# that shipped (see THIRD_PARTY.md).
#
# Usage: fetch-pnpm.sh [output-path]     (default payload/usr/local/bin/pnpm)
# Idempotent: exits immediately when the output already has the right sha256.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/payload/usr/local/bin/pnpm}"

PNPM_VERSION="12.11.2"
# npm's dist.integrity for @pnpm/exe.linux-arm64@12.11.2 (sha512, base64).
PNPM_INTEGRITY="6e8ZAQUwFXAWHHHv5FesWqf/kEK04wuitBv5f/gxzkC0DiBfaixr+f+6JQede8SF4Ji5LcMwVFJbzAtffpWxEg=="
# sha256 of `package/pnpm` inside that tarball, as shipped in 1.2.0.
PNPM_SHA256="a6829768356de0660b9f83036a1525374fde9494dc5af7c7b3f0c4410c8f084c"
TARBALL="https://registry.npmjs.org/@pnpm/exe.linux-arm64/-/exe.linux-arm64-$PNPM_VERSION.tgz"

if [ -f "$OUT" ] && [ "$(sha256sum "$OUT" | cut -d' ' -f1)" = "$PNPM_SHA256" ]; then
  echo "pnpm: $OUT is up to date (pnpm $PNPM_VERSION, $(wc -c < "$OUT") bytes)"
  exit 0
fi

for tool in node curl; do
  command -v "$tool" >/dev/null || { echo "pnpm: need $tool to fetch the binary" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "pnpm: downloading @pnpm/exe.linux-arm64@$PNPM_VERSION"
curl -fsSL "$TARBALL" -o "$TMP/pnpm.tgz"

# Verify the tarball against npm's published sha512 (base64), then the binaries
# against the pinned sha256 — the second check is what actually guards the file
# we install, and it survives npm re-packing a tarball.
node - "$TMP/pnpm.tgz" "$PNPM_INTEGRITY" <<'JS'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const [file, want] = process.argv.slice(2);
const got = createHash("sha512").update(readFileSync(file)).digest("base64");
if (got !== want) {
  console.error(`pnpm: tarball integrity mismatch (got sha512-${got})`);
  process.exit(1);
}
JS

tar xzf "$TMP/pnpm.tgz" -C "$TMP" package/pnpm
GOT="$(sha256sum "$TMP/package/pnpm" | cut -d' ' -f1)"
[ "$GOT" = "$PNPM_SHA256" ] || {
  echo "pnpm: binary sha256 mismatch (got $GOT, want $PNPM_SHA256)" >&2
  exit 1
}

mkdir -p "$(dirname "$OUT")"
cp "$TMP/package/pnpm" "$OUT"
chmod 755 "$OUT"
echo "pnpm: installed $OUT (pnpm $PNPM_VERSION, $(wc -c < "$OUT") bytes, sha256 verified)"
