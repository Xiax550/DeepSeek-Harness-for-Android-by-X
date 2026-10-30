#!/usr/bin/env python3
"""Point main's update.json at a newly published app version.

Why this exists: `update.json` is what the app polls to decide whether an update
exists (`app.versionCode` is compared against the installed one). CI published a
release and left the manifest untouched, so a CI-built APK was invisible to every
device until somebody happened to run sync_repo.sh — the exact gap that makes
"CI releases" look like they worked when they did not.

Only `app.version` and `app.versionCode` are touched. `terminal` and `hot` belong
to their own release channels (`release_terminal.sh` / `release_hot.sh` own
them), and rewriting them from a checkout of an older tag is how those two fields
silently regress.

Usage:
  ci_patch_update_json.py --repo owner/name --version 1.2.1 --code 10213
  ci_patch_update_json.py --repo owner/name --version 1.2.1 --code 10213 --check
  ci_patch_update_json.py --document update.json --version 1.2.1 --code 10213 --check

Token: GITHUB_TOKEN (or GH_TOKEN) — needs contents:write.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

PATH = "update.json"


def patch(document: dict, version: str, code: int) -> tuple[dict, bool]:
    """Set the app channel's version/versionCode. Returns (document, changed).

    Pure, so the interesting half of this script is testable without a network:
    `--document` runs it against a local file.
    """
    app = document.get("app")
    if not isinstance(app, dict):
        raise SystemExit("update.json 里没有 app 段，拒绝改")
    changed = app.get("version") != version or app.get("versionCode") != code
    app["version"] = version
    app["versionCode"] = code
    return document, changed


def api(url: str, token: str, method: str = "GET", payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/vnd.github+json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body else {}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--version", required=True)
    parser.add_argument("--code", type=int, required=True)
    parser.add_argument("--document", default="", help="本地 update.json（离线检查用）")
    parser.add_argument("--check", action="store_true", help="只报告，不写回")
    args = parser.parse_args()

    if args.document:
        document = json.loads(open(args.document, encoding="utf-8").read())
        document, changed = patch(document, args.version, args.code)
        print(f"{'需要改' if changed else '无需改动'}：app.version={document['app']['version']} "
              f"app.versionCode={document['app']['versionCode']}")
        if changed and not args.check:
            open(args.document, "w", encoding="utf-8").write(
                json.dumps(document, indent=2, ensure_ascii=False) + "\n")
            print(f"已写回 {args.document}")
        return

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not token:
        sys.exit("缺少 GITHUB_TOKEN/GH_TOKEN")
    if not args.repo:
        sys.exit("缺少 --repo owner/name")

    api_url = f"https://api.github.com/repos/{args.repo}/contents/{PATH}?ref={args.branch}"
    try:
        current = api(api_url, token)
    except urllib.error.HTTPError as error:
        sys.exit(f"读不到 {PATH}（HTTP {error.code}）—— 不新建，先确认仓库里确实有它")

    document = json.loads(base64.b64decode(current["content"]).decode("utf-8"))
    document, changed = patch(document, args.version, args.code)
    if not changed:
        print(f"{PATH} 已经是 app {args.version} ({args.code})，无需改动")
        return
    if args.check:
        print(f"需要改：app.version -> {args.version}，app.versionCode -> {args.code}")
        return

    payload = {
        "message": f"update.json: app {args.version} ({args.code})",
        "content": base64.b64encode(
            (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        ).decode("ascii"),
        "sha": current["sha"],
        "branch": args.branch,
    }
    result = api(f"https://api.github.com/repos/{args.repo}/contents/{PATH}", token,
                 method="PUT", payload=payload)
    print(f"{PATH} 已更新：app {args.version} ({args.code})，commit {result.get('commit', {}).get('sha', '?')[:12]}")


if __name__ == "__main__":
    main()
