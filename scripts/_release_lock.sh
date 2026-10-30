#!/bin/sh
# One release at a time — shared by release.sh, release_hot.sh and release_terminal.sh.
#
# Every release path is "delete the asset with this name, upload a new one". Run
# two of them at once (or the same one twice) and the deletes and uploads
# interleave: the second run deletes the asset the first one just uploaded and
# then fails, leaving the release with a missing file and a red build log. That
# happened once; this is the mutex.
#
# The lock is advisory and local: it stops two releases started from this machine
# (the normal case — the same working tree, the same out/). It is not a
# distributed lock and the release scripts stay reentrant, so a run that dies
# midway is still fixed by running it again.
#
# Usage: . "$ROOT/scripts/_release_lock.sh"      (ROOT must already be set)
#        DSH_RELEASE_LOCK_DIR=... to move the lock file elsewhere.
set -eu

LOCK_DIR="${DSH_RELEASE_LOCK_DIR:-$ROOT/out}"
mkdir -p "$LOCK_DIR"
if command -v flock >/dev/null 2>&1; then
  # fd 9 is held for the life of the script; flock drops it on exit, including
  # on a crash, so a dead run never leaves a stuck lock behind.
  exec 9>"$LOCK_DIR/release.lock"
  if ! flock -n 9; then
    echo "另一个发布正在进行（$LOCK_DIR/release.lock）：等它跑完再发，别同时发两条通道" >&2
    exit 1
  fi
fi
