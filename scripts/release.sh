#!/bin/sh
# Publish a GitHub release: tag, notes, APK, hot package, checksums.
#
# Needs GITHUB_TOKEN with contents:write — a fine-grained token scoped to this
# repository is enough. Set it in the app under Settings → Environments; this
# script never prints it and never writes it anywhere.
#
# The asset names matter: update.json points at versioned files such as
#   releases/download/v1.2.50/DHA-1.2.50-arm64.apk
#   releases/download/v1.2.50/DHA-1.2.50-hot.zip
# so renaming them would break in-app updates.
#
# Reentrant on purpose: a run that dies between creating the release and
# uploading the assets is fixed by running the same command again.
#
# Usage: release.sh            # uses VERSION
#        release.sh 1.2.0      # bumps VERSION first
#
# Env:
#   DSH_RELEASE_TAG   publish to this tag instead of v<VERSION>. It must carry the
#                     same version: the tag decides where the assets land, and a
#                     mismatch either creates a tag at the default branch's HEAD
#                     or attaches this build to a different release.
#   DSH_SLIM_ONLY=1   the 2 MB slim APK is ready but the full one is not: publish
#                     what exists and let the release-full workflow attach the
#                     full APK afterwards (it triggers on `release: published`).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO="${DSH_REPO:-}"

# Before anything is bumped or uploaded: two releases running at once would
# delete each other's assets. See scripts/_release_lock.sh.
. "$ROOT/scripts/_release_lock.sh"

VERSION="${1:-$(cat "$ROOT/VERSION")}"

if [ "${1:-}" != "" ]; then
  echo "$VERSION" > "$ROOT/VERSION"
fi
TAG="${DSH_RELEASE_TAG:-v$VERSION}"
# The tag decides the release; if it disagrees with VERSION, the notes (rendered
# from VERSION) describe a different build than the one being uploaded.
TAG_VERSION="${TAG#v}"
[ "$TAG_VERSION" = "$VERSION" ] || {
  echo "DSH_RELEASE_TAG=$TAG 与 VERSION=$VERSION 不一致：拒绝发布" >&2
  exit 1
}
APK="$ROOT/out/DHA.apk"
SLIM_APK="$ROOT/out/DHA-slim.apk"
HOT="$ROOT/out/dsh-hot.zip"
SOURCE="$ROOT/out/DHA-${VERSION}-source.tar.gz"
SUMS="$ROOT/out/SHA256SUMS.txt"
APK_NAME="DHA-${VERSION}-arm64.apk"
SLIM_NAME="DHA-${VERSION}-slim.apk"
HOT_NAME="DHA-${VERSION}-hot.zip"
SOURCE_NAME="$(basename "$SOURCE")"

echo "== 发布 $TAG =="
if [ ! -f "$APK" ]; then
  if [ "${DSH_SLIM_ONLY:-0}" = "1" ] && [ -f "$SLIM_APK" ]; then
    echo "   瘦包先行：本次不带全量 APK，release-full workflow 会在发布后补上"
  else
    echo "缺少 $APK，先跑 scripts/build_apk.sh" >&2
    echo "（只想先发瘦包让 CI 补全量：DSH_SLIM_ONLY=1 sh scripts/release.sh）" >&2
    exit 1
  fi
fi
[ -f "$HOT" ] || cp "$ROOT/build/hot-assets/hot.zip" "$HOT"
python3 "$ROOT/scripts/make_source_tar.py" --root "$ROOT" --out "$SOURCE"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  cat >&2 <<EOF
没有 GITHUB_TOKEN，改用手动发布（大约三次点击）：

  1. 打开 https://github.com/$REPO/releases/new?tag=$TAG
  2. 标题填 DHA $VERSION，正文用
     python3 scripts/release_notes.py $VERSION 生成（内容取自 CHANGELOG.md）
  3. 把这三个文件拖进去，然后 Publish：
       $APK   (完整 APK，上传名 $APK_NAME)
       $HOT   (几十 KB)
       $SOURCE (对应源码)
EOF
  exit 1
fi

[ -n "$REPO" ] || { echo '缺少 DSH_REPO，例如 owner/repository' >&2; exit 1; }

AUTH="Authorization: Bearer $GITHUB_TOKEN"
ACCEPT="Accept: application/vnd.github+json"
API="https://api.github.com/repos/$REPO"

asset_id() {
  curl -fS -H "$AUTH" "$API/releases/$RELEASE_ID/assets" | python3 -c '
import json, sys
target = sys.argv[1]
for asset in json.load(sys.stdin):
    if asset.get("name") == target:
        print(asset.get("id"))
        break
' "$1"
}

body_json() {
  # The body is the changelog entry, rendered — there is no second copy of the
  # release description anywhere. No entry, no release: release_notes.py exits
  # non-zero rather than publishing a release described only by its commits.
  python3 "$ROOT/scripts/release_notes.py" "$VERSION" --channel app \
    | python3 -c '
import json, sys
tag = sys.argv[1]
print(json.dumps({"tag_name": tag, "name": tag, "body": sys.stdin.read(),
                  "draft": False, "prerelease": False}, ensure_ascii=False))
' "$TAG"
}

BODY=$(body_json)

RELEASE_FILE="$ROOT/build/release.json"
STATUS=$(curl -sS -o "$RELEASE_FILE" -w '%{http_code}' \
  -H "$AUTH" -H "$ACCEPT" "$API/releases/tags/$TAG")
case "$STATUS" in
  200) ;;
  404) : > "$RELEASE_FILE" ;;
  *) echo "读取 release 失败：HTTP $STATUS" >&2; exit 1 ;;
esac
RELEASE_ID=$(python3 -c '
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding="utf-8")).get("id", ""))
except Exception:
    print("")
' "$RELEASE_FILE")

if [ -n "$RELEASE_ID" ]; then
  echo "   已存在（id $RELEASE_ID）：更新说明并补齐资产"
  printf '%s' "$BODY" | curl -fS -X PATCH -H "$AUTH" -H "$ACCEPT" \
    --data-binary @- "$API/releases/$RELEASE_ID" > /dev/null
else
  RELEASE_ID=$(printf '%s' "$BODY" | curl -fS -X POST -H "$AUTH" -H "$ACCEPT" \
    --data-binary @- "$API/releases" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(data.get("id", ""))
if not data.get("id"):
    print(data, file=sys.stderr)
')
  [ -n "$RELEASE_ID" ] || { echo "创建失败" >&2; exit 1; }
  echo "   新建 release id $RELEASE_ID"
fi

sum_line() {
  file=$1
  name=$2
  [ -f "$file" ] || return 0
  printf '%s  %s\n' "$(sha256sum "$file" | cut -d' ' -f1)" "$name"
}
{
  sum_line "$APK" "$APK_NAME"
  sum_line "$SLIM_APK" "$SLIM_NAME"
  sum_line "$HOT" "$HOT_NAME"
  sum_line "$SOURCE" "$SOURCE_NAME"
} > "$SUMS"

upload_asset() {
  file=$1
  name=$2
  type=$3
  old=$(asset_id "$name")
  if [ -n "$old" ]; then
    curl -fS -X DELETE -H "$AUTH" "$API/releases/assets/$old" > /dev/null
  fi
  printf '   %-32s %6s  ' "$name" "$(du -h "$file" | cut -f1)"
  response=$(curl -fS -X POST -H "$AUTH" -H "Content-Type: $type" \
    --data-binary "@$file" \
    "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$name")
  printf '%s' "$response" | python3 -c '
import json, sys
data = json.load(sys.stdin)
if data.get("state") != "uploaded":
    raise SystemExit("upload did not complete: " + json.dumps(data, ensure_ascii=False))
print(data.get("browser_download_url") or data.get("message"))
'
}

echo "== 上传资产 =="
[ -f "$APK" ] && upload_asset "$APK" "$APK_NAME" application/vnd.android.package-archive
[ -f "$SLIM_APK" ] && upload_asset "$SLIM_APK" "$SLIM_NAME" application/vnd.android.package-archive
upload_asset "$HOT" "$HOT_NAME" application/zip
upload_asset "$SOURCE" "$SOURCE_NAME" application/gzip
upload_asset "$SUMS" SHA256SUMS.txt text/plain

set -- "$APK_NAME" "$HOT_NAME" "$SOURCE_NAME" SHA256SUMS.txt
[ -f "$SLIM_APK" ] && set -- "$@" "$SLIM_NAME"
curl -fS -H "$AUTH" "$API/releases/$RELEASE_ID/assets" | python3 -c '
import json, sys
required = set(sys.argv[1:])
assets = json.load(sys.stdin)
names = {asset.get("name") for asset in assets if asset.get("state") == "uploaded"}
missing = required - names
if missing:
    raise SystemExit("missing uploaded assets: " + ", ".join(sorted(missing)))
print("verified remote assets:", len(required))
' "$@"

echo "== 完成 =="
echo "https://github.com/$REPO/releases/tag/$TAG"
