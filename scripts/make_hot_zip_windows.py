#!/usr/bin/env python3
"""Build the hot package on Windows.

Two deltas from upstream's make_hot_zip.py, both deliberate and documented:

1. Upstream runs `sh scripts/build_linkfix.sh` first, to rebuild the guest-side
   link()/chown() shim. That needs a POSIX shell, which a Windows checkout does not
   have -- and the shim is already a committed artefact under
   payload/opt/dsh/android/liblinkfix.so, so nothing has to be rebuilt here.

2. **The baked package gets a content-derived `sp`, not a hardcoded 0.**
   Upstream's `next_sp()` returns 0 for every `--base` build, so re-releasing the same
   app version with *different* hot content produces an identical version string
   (`<app>-t<terminal>-sp0`). The app decides whether to re-apply by version equality
   (see HotVersion.shouldReplay), so it concludes "the APK already carries this" and
   skips the new content -- the fix silently ships nothing. That is exactly what
   happened to the xdg-user-dir shim.

   Deriving `sp` from the package's own content hash makes the version string change
   whenever the content does, while staying identical for identical content (a rebuild
   must not look like a new update). It also makes an APK's baked package rank ahead of
   any previously stored external one, which is the correct direction: HotVersion drops
   a stored package whose `sp` is not greater than the baked one.

   The change is self-consistent because only this packer writes baked packages for
   this fork, and it writes the same scheme every time.

Usage: make_hot_zip_windows.py <repo-root> <out.zip> [--check]
"""
from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import make_hot_zip as upstream  # noqa: E402  (path set up above)

# The sp value is written into the version string as plain digits, so it must stay a
# non-negative integer. Reserving the top of the range keeps this scheme's numbers well
# clear of the small 0,1,2,... sequence upstream's tracker hands out for hot releases.
SP_MODULUS = 9000
SP_OFFSET = 1000


def content_sp(content_hex: str) -> int:
    """A stable, content-derived sequence number."""
    return SP_OFFSET + (int(content_hex[:8], 16) % SP_MODULUS)


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    root = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve()
    check_only = "--check" in sys.argv[3:]

    # (source tree, prefix inside the archive) -- the same six trees upstream ships.
    trees = [
        (root / "payload" / "opt" / "dsh" / "android", "opt/dsh/android"),
        (root / "payload" / "opt" / "dsh" / "node_modules" / "@deepseek-ai" / "dsh-llm-pi-ai",
         "opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai"),
        (root / "payload" / "etc", "etc"),
        (root / "payload" / "usr" / "local" / "bin", "usr/local/bin"),
        (root / "payload" / "home", "@home"),
        (root / "plugin" / "dsh-plugin-android",
         "@home/.dsh/profiles/web/node_modules/dsh-plugin-android"),
        (root / "plugin" / "dsh-plugin-android", "opt/dsh/dsh-plugin-android"),
    ]

    missing = [t for t, _ in trees if not t.is_dir()]
    if missing:
        sys.exit("missing source trees: " + ", ".join(str(p) for p in missing))

    required_vendor = [
        root / "payload" / "home" / ".dsh" / "profiles" / "web" / "node_modules" / name / "package.json"
        for name in ("dshmarket", "undici", "js-yaml", "argparse")
    ]
    missing_vendor = [path for path in required_vendor if not path.is_file()]
    if missing_vendor:
        sys.exit("missing vendored plugin-market files: "
                 + ", ".join(str(path) for path in missing_vendor))

    # The shim has to be in a tree that travels, or the fix silently ships nothing.
    shim = root / "payload" / "usr" / "local" / "bin" / "xdg-user-dir"
    if not shim.is_file():
        sys.exit(f"missing the xdg-user-dir shim: {shim}")

    out.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for tree, prefix in trees:
            written += upstream.add_tree(archive, tree, prefix)

    # Baked packages use the fork's own scheme, computed before hot.json is written so
    # stamping the version cannot change the content it is derived from.
    version = upstream.version
    app, terminal = version.read(root)["app"], version.read(root)["terminal"]

    import hashlib
    import json
    import time

    digest = hashlib.sha256()
    with zipfile.ZipFile(out) as archive:
        for name in sorted(archive.namelist()):
            digest.update(name.encode("utf-8"))
            digest.update(archive.read(name))
    content = digest.hexdigest()[:16]
    sp = content_sp(content)
    hot = version.hot_version(app, terminal, sp)

    with zipfile.ZipFile(out, "a", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            zipfile.ZipInfo("hot.json", date_time=time.localtime()[:6]),
            json.dumps({"version": hot, "app": app, "terminal": terminal, "sp": sp,
                        "hash": content, "files": written,
                        "built": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=2),
        )

    print(f"wrote {out} ({out.stat().st_size} bytes, {written} files)")
    print(f"  version {hot}  (content-derived sp, upstream base would be sp0)")
    print(f"  content {content}")

    with zipfile.ZipFile(out) as archive:
        names = set(archive.namelist())
        stamped = json.loads(archive.read("hot.json"))
    for probe in ("usr/local/bin/xdg-user-dir",
                  "@home/.dsh/profiles/web/node_modules/dshmarket/package.json",
                  "@home/.dsh/skills/floating-ball/SKILL.md",
                  "opt/dsh/android/start-dsh.sh"):
        print(f"  {'ok  ' if probe in names else 'MISS'} {probe}")

    # Guard the two things that silently produce a useless package.
    if "usr/local/bin/xdg-user-dir" not in names:
        sys.exit("the xdg shim did not make it into the package")
    if "@home/.dsh/profiles/web/node_modules/dshmarket/package.json" not in names:
        sys.exit("the built-in plugin market did not make it into the package")
    if check_only and not re.fullmatch(rf"{re.escape(app)}-t{re.escape(terminal)}-sp\d+",
                                       stamped["version"]):
        sys.exit(f"unexpected version stamp: {stamped['version']}")


if __name__ == "__main__":
    main()
