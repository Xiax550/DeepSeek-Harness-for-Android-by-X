#!/usr/bin/env python3
"""Decide whether the release-full workflow should build anything.

GitHub has no "a release asset was uploaded" event, so "detect a slim upload and
produce the full APK" is expressed as: react to `release: published` (which fires
when `release.sh` creates the release) and build **only if that release has the
slim APK and not the full one**. This script is that decision, kept out of the
YAML so it can be tested on its own — the workflow just prints the KEY=VALUE lines
into $GITHUB_OUTPUT.

Usage:
  ci_plan.py --event workflow_dispatch --tag v1.2.1
  ci_plan.py --event release --tag v1.2.1 --assets-json /tmp/assets.json

`--assets-json` is the release's asset array (e.g. `toJSON(github.event.release.assets)`):
either a JSON list, or an object with an "assets" list.

Output (stdout, one per line):

  tag        the git tag to check out and publish to (no leading "v" stripped)
  build      true | false
  reason     why, in words, for the run log
  have_slim  true | false
  have_full  true | false

Always exits 0: this is a plan, not a gate. The workflow decides with `if:`.
"""
from __future__ import annotations

import argparse
import json
import sys

FULL = "dsh-android.apk"
SLIM = "dsh-android-slim.apk"
HOT = "dsh-hot.zip"
# Anything the app channel publishes. A release without at least one of these is
# some other channel's release — a `t<N>` terminal release carries payload.zip and
# nothing else, and it must not start a 15-minute APK build.
APP_MARKERS = (SLIM, HOT)


def asset_names(document: object) -> list[str]:
    if document is None:
        return []
    if isinstance(document, dict):
        document = document.get("assets", [])
    if not isinstance(document, list):
        return []
    names = []
    for item in document:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            names.append(item["name"])
        elif isinstance(item, str):
            names.append(item)
    return names


def plan(event: str, tag: str, assets: list[str]) -> dict[str, str]:
    have_slim = SLIM in assets
    have_full = FULL in assets

    if not tag:
        return {"tag": "", "build": "false", "reason": "没有拿到 tag，无法发布",
                "have_slim": str(have_slim).lower(), "have_full": str(have_full).lower()}

    if event == "workflow_dispatch":
        reason = "手动触发" + ("（release 已有全量包，仍按手动请求重建）" if have_full else "")
        build = True
    elif event == "release":
        if not any(marker in assets for marker in APP_MARKERS):
            reason = ("这个 release 不是应用通道发的（没有 %s/%s）—— 终端 release 之类，跳过"
                      % (SLIM, HOT))
            build = False
        elif have_full:
            reason = "release 里已经有 %s，不重复构建（重跑工作流是幂等的）" % FULL
            build = False
        elif have_slim:
            reason = "检测到只有 %s、没有 %s —— 补一个全量包上去" % (SLIM, FULL)
            build = True
        else:
            reason = "有 %s 但没有 %s，也按发布处理" % (HOT, FULL)
            build = True
    else:
        return {"tag": tag, "build": "false", "reason": "未知事件 %s" % event,
                "have_slim": str(have_slim).lower(), "have_full": str(have_full).lower()}

    return {"tag": tag, "build": "true" if build else "false", "reason": reason,
            "have_slim": str(have_slim).lower(), "have_full": str(have_full).lower()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True)
    parser.add_argument("--tag", default="")
    parser.add_argument("--assets-json", default="")
    args = parser.parse_args()

    assets: list[str] = []
    if args.assets_json:
        try:
            assets = asset_names(json.loads(open(args.assets_json, encoding="utf-8").read()))
        except Exception as error:  # a malformed payload must not pretend there are assets
            print(f"::warning::读不出资产列表（{error}）—— 当作空列表", file=sys.stderr)

    result = plan(args.event, args.tag, assets)
    for key in ("tag", "build", "reason", "have_slim", "have_full"):
        print(f"{key}={result[key]}")


if __name__ == "__main__":
    main()
