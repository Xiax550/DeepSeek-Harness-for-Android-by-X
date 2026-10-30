#!/usr/bin/env python3
"""Checks for release_notes.py's hot-package lookup (the one release_hot.sh uses).

Regression this guards: hot versions are `<app>-t<terminal>-sp<n>`, but the matcher
used to look for `<app>-sp`, so the `hot-history` channel — the body `release_hot.sh`
PATCHes onto the release — rendered "no hot package published yet" and would have
replaced the real notes with that placeholder.

Run: python3 docs/release-notes-test.py
"""
import importlib.util
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("release_notes", ROOT / "scripts/release_notes.py")
notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notes)

FIXTURE = """# Changelog

## [1.2.1] - 2026-10-15

### Fixed

- next version

## [1.2.0-t2-sp1] - 2026-10-14

### Fixed

- three-part hot package

## [1.2.0-t2-sp0] - 2026-10-14

### Fixed

- the sp0 of the same line

## [1.2.0] - 2026-10-14

### Fixed

- the app section

## [1.1.5-t2-sp2] - 2026-10-13

### Fixed

- previous app line

## [1.1.5-sp3] - 2026-10-12

### Fixed

- legacy two-part hot package
"""

checks = 0
failures = 0


def check(actual, expected, what):
    global checks, failures
    checks += 1
    if actual == expected:
        print(f"  [PASS] {what}: {actual}")
        return
    failures += 1
    print(f"  [FAIL] {what}: {actual}  <- expected {expected}")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "CHANGELOG.md"
        path.write_text(FIXTURE, encoding="utf-8")
        changelog = notes.Changelog(path)

        check(changelog.hot_versions("1.2.0"), ["1.2.0-t2-sp0", "1.2.0-t2-sp1"],
              "app=1.2.0 finds the three-part packages, sp ascending")
        check(changelog.hot_versions("1.1.5"), ["1.1.5-t2-sp2", "1.1.5-sp3"],
              "app=1.1.5 finds both the three-part and the legacy two-part package")
        check(changelog.hot_versions("1.2.1"), [],
              "app=1.2.1 does not pick up 1.2.0's packages")
        check(changelog.hot_versions("1.2"), [],
              "an incomplete app prefix matches nothing")

        # the channel must now render the packages instead of the placeholder
        rendered = notes.render(changelog, "1.2.0", "hot-history")
        check("no hot package published" in rendered, False,
              "hot-history renders packages, not the placeholder")
        check("1.2.0-t2-sp1" in rendered and "1.2.0-t2-sp0" in rendered, True,
              "hot-history contains both packages, newest section first is not required")
        # and the app channel must be untouched by the change
        app = notes.render(changelog, "1.2.0", "app")
        check(app.startswith("# dsh-android 1.2.0"), True, "app channel unchanged")

    # the real changelog must carry a section for every published hot package —
    # otherwise release_hot.sh would PATCH the release body with the placeholder
    real = notes.Changelog(ROOT / "CHANGELOG.md")
    published = "1.2.0-t2-sp1"
    check(published in real.versions(), True,
          f"CHANGELOG has a section for the published hot package {published}")
    body = notes.render(real, "1.2.0", "hot-history")
    check("no hot package published" in body, False,
          "the real hot-history body is the notes, not the placeholder")
    check(published in body, True, "the real hot-history body mentions the package")
    # and the single-package channel works for a three-part version
    check(notes.render(real, published, "hot").startswith(f"## 热更新包 {published}"), True,
          "the hot channel renders one three-part package")

    print(f"release_notes: {checks} checks, {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
