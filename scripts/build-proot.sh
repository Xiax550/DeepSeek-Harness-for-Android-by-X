#!/usr/bin/env bash
# Rebuild the OpenMinis PRoot fork from pinned public source.
#
# This is for future binary replacements. The libproot.so shipped in DHA
# 1.2.50 is verified against the official OpenMinis 1.13 APK; see
# docs/BUILD-PROOT.md.
set -euo pipefail

OPENMINIS_REPO="${OPENMINIS_REPO:-https://github.com/OpenMinis/OpenMinis.git}"
OPENMINIS_REF="${OPENMINIS_REF:-4ef29002e88db1e20e462ec2ff46916e8a7dcb45}"
EXPECTED_PROOT_COMMIT="${EXPECTED_PROOT_COMMIT:-8cf13e997cdc9472997aae19df8050c073c9a86c}"
EXPECTED_BUILD_SCRIPT_BLOB="${EXPECTED_BUILD_SCRIPT_BLOB:-5d83e99e3214b95acbf8ac76bb32f290801c493b}"
OUT_DIR="${OUT_DIR:-$(pwd)/out}"
WORK_DIR="${WORK_DIR:-$(pwd)/.build/proot}"

info() { printf '[proot] %s\n' "$*"; }
die() { printf '[proot] %s\n' "$*" >&2; exit 1; }

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  for candidate in \
    "$HOME/Library/Android/sdk/ndk/28.0.12433566" \
    "$HOME/Android/Sdk/ndk/28.0.12433566"; do
    [ -d "$candidate" ] && ANDROID_NDK_HOME="$candidate" && break
  done
fi
[ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ] \
  || die "Set ANDROID_NDK_HOME to Android NDK r28 or newer."
export ANDROID_NDK_HOME

NDK_VERSION="$(sed -n 's/^Pkg\.Revision *= *//p' "$ANDROID_NDK_HOME/source.properties" 2>/dev/null || echo unknown)"
info "NDK: $ANDROID_NDK_HOME (r$NDK_VERSION)"

mkdir -p "$OUT_DIR" "$WORK_DIR"
if [ ! -d "$WORK_DIR/.git" ]; then
  git init "$WORK_DIR"
  git -C "$WORK_DIR" remote add origin "$OPENMINIS_REPO"
fi
git -C "$WORK_DIR" remote set-url origin "$OPENMINIS_REPO"
git -C "$WORK_DIR" fetch --depth 1 origin "$OPENMINIS_REF"
git -C "$WORK_DIR" checkout --detach FETCH_HEAD

SRC_COMMIT="$(git -C "$WORK_DIR" rev-parse HEAD)"
[ "$SRC_COMMIT" = "$OPENMINIS_REF" ] \
  || die "OpenMinis commit mismatch: got $SRC_COMMIT, expected $OPENMINIS_REF"

git -C "$WORK_DIR" submodule sync -- deps/proot
git -C "$WORK_DIR" submodule update --init --depth 1 -- deps/proot
PROOT_COMMIT="$(git -C "$WORK_DIR/deps/proot" rev-parse HEAD)"
[ "$PROOT_COMMIT" = "$EXPECTED_PROOT_COMMIT" ] \
  || die "PRoot commit mismatch: got $PROOT_COMMIT, expected $EXPECTED_PROOT_COMMIT"

BUILD_SCRIPT_BLOB="$(git -C "$WORK_DIR" hash-object deps/build_proot.sh)"
[ "$BUILD_SCRIPT_BLOB" = "$EXPECTED_BUILD_SCRIPT_BLOB" ] \
  || die "build_proot.sh mismatch: got $BUILD_SCRIPT_BLOB"
[ -f "$WORK_DIR/deps/talloc/talloc.c" ] || die "talloc source is missing."

info "OpenMinis commit: $SRC_COMMIT"
info "PRoot commit: $PROOT_COMMIT"
info "Building static talloc 2.4.2 + PRoot (API 26, arm64-v8a)"
(
  cd "$WORK_DIR/deps"
  ./build_proot.sh clean
)

PROOT_LIB="$WORK_DIR/src/android/app/src/main/jniLibs/arm64-v8a/libproot.so"
[ -f "$PROOT_LIB" ] || die "Build did not produce $PROOT_LIB"
cp "$PROOT_LIB" "$OUT_DIR/libproot.so"
for loader in libproot-loader.so libproot-loader32.so; do
  source_loader="$WORK_DIR/src/android/app/src/main/jniLibs/arm64-v8a/$loader"
  [ -f "$source_loader" ] && cp "$source_loader" "$OUT_DIR/$loader"
done

sha256sum "$OUT_DIR/libproot.so" > "$OUT_DIR/libproot.so.sha256"

{
  echo "upstream: $OPENMINIS_REPO"
  echo "openminis commit: $SRC_COMMIT"
  echo "proot commit: $PROOT_COMMIT"
  echo "build script blob: $BUILD_SCRIPT_BLOB"
  echo "ndk version: r$NDK_VERSION"
  echo "android api: 26"
  echo "abi: arm64-v8a"
  echo "built at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "sha256: $(cut -d' ' -f1 "$OUT_DIR/libproot.so.sha256")"
} > "$OUT_DIR/build-info.txt"

strings "$OUT_DIR/libproot.so" | grep -q 'STMicroelectronics' \
  || die "The GPL copyright line is missing; do not publish this artifact."

cat <<EOF
Build complete:
  $OUT_DIR/libproot.so
  sha256 $(cut -d' ' -f1 "$OUT_DIR/libproot.so.sha256")

A rebuilt ELF is not expected to be byte-identical across NDK versions.
Update THIRD_PARTY.md, run the sandbox smoke test on a physical device, and
publish build-info.txt with the binary and corresponding source.
EOF
