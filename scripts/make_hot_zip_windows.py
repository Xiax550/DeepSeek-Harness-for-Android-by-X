#!/usr/bin/env python3
"""Build the hot package on Windows.

Two deltas from upstream's make_hot_zip.py, both deliberate and documented:

1. Upstream runs `sh scripts/build_linkfix.sh` first, to rebuild the guest-side
   link()/chown() shim. That needs a POSIX shell, which a Windows checkout does not
   have -- and the shim is already a committed artefact under
   payload/opt/dsh/android/liblinkfix.so, so nothing has to be rebuilt here.

2. **The baked package uses the same monotonic `sp` scheme as Linux.**
   Identical content keeps the recorded number; changed content increments it. This
   prevents a newly built APK from baking an older package that `HotVersion` would
   discard. Text files are normalized to LF before packing so Windows and Linux
   checkouts produce the same content hash.

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
    sp = upstream.next_sp(root, app, terminal, content, base=True)
    hot = version.hot_version(app, terminal, sp)

    with zipfile.ZipFile(out, "a", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            zipfile.ZipInfo("hot.json", date_time=time.localtime()[:6]),
            json.dumps({"version": hot, "app": app, "terminal": terminal, "sp": sp,
                        "hash": content, "files": written,
                        "built": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=2),
        )
    print(f"wrote {out} ({out.stat().st_size} bytes, {written} files)")
    print(f"  version {hot}  (monotonic sp, tracked in HOT)")
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
    upstream.write_tracker(root, app, terminal, sp, content)


if __name__ == "__main__":
    main()
