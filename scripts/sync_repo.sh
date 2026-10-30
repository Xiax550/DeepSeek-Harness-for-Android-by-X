#!/bin/sh
# Commit the current source tree and optionally push it.
#
# Usage:
#   sh scripts/sync_repo.sh "Describe the change"
#   DSH_GIT_REMOTE=git@github.com:you/dha.git sh scripts/sync_repo.sh "Initial release"
#
# The script intentionally does not copy to another checkout and never chooses a
# maintainer repository for the caller. A remote is pushed only when it already
# exists or DSH_GIT_REMOTE is explicitly provided.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MESSAGE="${1:-更新}"

cd "$ROOT"
git rev-parse --show-toplevel >/dev/null 2>&1 || {
  echo "当前目录不是 Git 仓库，请先运行 git init" >&2
  exit 1
}

if [ -n "${DSH_GIT_REMOTE:-}" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$DSH_GIT_REMOTE"
  else
    git remote add origin "$DSH_GIT_REMOTE"
  fi
fi

git add -A
if git diff --cached --quiet; then
  echo "无改动，无需提交"
  exit 0
fi

git -c user.name="${GIT_AUTHOR_NAME:-DHA contributor}" \
  -c user.email="${GIT_AUTHOR_EMAIL:-opensource@users.noreply.github.com}" \
  commit -m "$MESSAGE"

if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin "${DSH_GIT_BRANCH:-main}"
  echo "已推送：$(git log -1 --format='%h %s')"
else
  echo "已提交但未推送：请设置 DSH_GIT_REMOTE 后再推送"
fi
