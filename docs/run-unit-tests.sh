#!/bin/sh
# run-unit-tests.sh — the JVM-side tests: no device, no APK, no Android SDK.
#
# Everything under test is deliberately Android-free (HotVersion, PayloadMarker,
# UnpackPlan, RecoveryPlan, BallSide), so plain javac/java runs the same checks CI would:
#
#   * HotVersion     — hot-replay decision table (apply sp2 → restart → still sp2)
#   * PayloadMarker  — "is the runtime on disk the one this shell should use"
#   * UnpackPlan     — install-progress phases, 5 Hz pacing and the wording
#   * RecoveryPlan   — recovery mode: token rules, port range, when to auto-enter
#   * BallSide       — stable left/right facing at the screen's centre
#   * ThemeChoice    — explicit light beats system and stale dark defaults
#   * MountPath      — safe guest paths for user bind mounts
#   * ScreenshotPaths — only task-created screenshot destinations are tracked
#   * ScreenAwakePolicy — background plugins cannot wake a sleeping display
#   * ScreenAwakeLeases — task ids make duplicated turn events harmless
#   * BallOutput        — floating-ball text is Chinese-only and reasoning-free
#
# Usage: sh docs/run-unit-tests.sh [workdir]      (default: build/unit-tests)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build/unit-tests}"

command -v javac >/dev/null || { echo "need javac (apt-get install -y openjdk-21-jdk-headless)" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

javac -encoding UTF-8 -source 8 -target 8 -nowarn -d "$OUT" \
  "$ROOT/app/java/com/dha/harness/HotVersion.java" \
  "$ROOT/app/java/com/dha/harness/PayloadMarker.java" \
  "$ROOT/app/java/com/dha/harness/UnpackPlan.java" \
  "$ROOT/app/java/com/dha/harness/RecoveryPlan.java" \
  "$ROOT/app/java/com/dha/harness/BallSide.java" \
  "$ROOT/app/java/com/dha/harness/ThemeChoice.java" \
  "$ROOT/app/java/com/dha/harness/MountPath.java" \
  "$ROOT/app/java/com/dha/harness/ScreenshotPaths.java" \
  "$ROOT/app/java/com/dha/harness/ScreenAwakePolicy.java" \
  "$ROOT/app/java/com/dha/harness/ScreenAwakeLeases.java" \
  "$ROOT/app/java/com/dha/harness/BallOutput.java" \
  "$ROOT/app/java/com/dha/harness/BallResultPolicy.java" \
  "$ROOT/docs/unit/dev/dsh/android/HotVersionTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/PayloadMarkerTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/UnpackPlanTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/RecoveryPlanTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/BallSideTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/ThemeChoiceTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/MountPathTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/ScreenshotPathsTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/ScreenAwakePolicyTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/ScreenAwakeLeasesTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/BallOutputTest.java" \
  "$ROOT/docs/unit/dev/dsh/android/BallResultPolicyTest.java"

failed=0
for test in HotVersionTest PayloadMarkerTest UnpackPlanTest RecoveryPlanTest BallSideTest ThemeChoiceTest MountPathTest ScreenshotPathsTest ScreenAwakePolicyTest ScreenAwakeLeasesTest BallOutputTest BallResultPolicyTest; do
  if ! java -cp "$OUT" "com.dha.harness.$test"; then
    failed=1
  fi
done

[ "$failed" = "0" ] || { echo "unit tests FAILED" >&2; exit 1; }
echo "all unit tests passed"
