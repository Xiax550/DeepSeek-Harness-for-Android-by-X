#!/usr/bin/env python3
"""Regression checks for versioned release assets and CI configuration."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def main() -> int:
    ci_plan = module("ci_plan", ROOT / "scripts/ci_plan.py")

    cases = [
        ("release", ["DHA-1.2.50-arm64.apk"], "false", "full APK already exists"),
        ("release", ["DHA-1.2.50-slim.apk"], "true", "slim-first triggers full build"),
        ("release", ["DHA-1.2.50-hot.zip"], "true", "hot-only app release triggers full build"),
        ("release", ["payload.zip", "payload.manifest"], "false", "terminal release is ignored"),
        ("workflow_dispatch", [], "true", "manual run always builds"),
    ]
    checks = 0
    for event, assets, expected, label in cases:
        result = ci_plan.plan(event, "v1.2.50", assets)
        actual = result["build"]
        if actual != expected:
            raise SystemExit(f"{label}: build={actual}, expected {expected}")
        print(f"PASS {label}: build={actual}")
        checks += 1

    manifest = json.loads((ROOT / "update.json").read_text(encoding="utf-8"))
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    expected = [
        ("app", "url", f"DHA-{version}-arm64.apk"),
        ("app", "slim", f"DHA-{version}-slim.apk"),
        ("hot", "url", f"DHA-{version}-hot.zip"),
    ]
    for section, field, name in expected:
        url = manifest[section][field]
        if not url.endswith(name):
            raise SystemExit(f"update.json {section}.{field} does not end with {name}: {url}")
        print(f"PASS update.json {section}.{field}: {name}")
        checks += 1

    tracker = json.loads((ROOT / "HOT").read_text(encoding="utf-8"))
    if manifest["hot"]["version"] != tracker["version"]:
        raise SystemExit("update.json hot.version does not match HOT tracker")
    print(f"PASS hot tracker/update.json: {tracker['version']}")
    checks += 1

    workflow = (ROOT / ".github/workflows/release-full.yml").read_text(encoding="utf-8")
    required = [
        "keystore/dha.p12",
        "REQUIRE_KEYSTORE: \"1\"",
        "DHA-${version}-arm64.apk",
        "DHA-${version}-slim.apk",
        "DHA-${version}-hot.zip",
        "--document update.json",
    ]
    for needle in required:
        if needle not in workflow:
            raise SystemExit(f"release workflow missing: {needle}")
        print(f"PASS workflow contains: {needle}")
        checks += 1
    if "keystore/dsh.p12" in workflow:
        raise SystemExit("release workflow still references the wrong keystore name")
    for action in ("actions/checkout@v7", "actions/setup-java@v6", "actions/setup-node@v7",
                   "actions/cache@v6", "android-actions/setup-android@v4",
                   "docker/setup-qemu-action@v4"):
        if action not in workflow:
            raise SystemExit(f"release workflow action is outdated or missing: {action}")
        print(f"PASS workflow action: {action}")
        checks += 1

    release = (ROOT / "scripts/release.sh").read_text(encoding="utf-8")
    for needle in ("APK_NAME=\"DHA-${VERSION}-arm64.apk\"",
                   "SLIM_NAME=\"DHA-${VERSION}-slim.apk\"",
                   "HOT_NAME=\"DHA-${VERSION}-hot.zip\"",
                   "SHA256SUMS.txt"):
        if needle not in release:
            raise SystemExit(f"release.sh missing: {needle}")
        print(f"PASS release.sh contains: {needle}")
        checks += 1

    print(f"release-config: {checks} checks, 0 failure(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
