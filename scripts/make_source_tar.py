#!/usr/bin/env python3
"""Pack the source tree into one tarball, without the things that are not source.

What ships: the repository's contents — app/ payload/ plugin/ profile/ patches/
scripts/ docs/ and the version ledgers. What does not:

    lab/        a 543 MB npm tree used to run a second harness for UI work
    build/ out/ generated payloads and APKs (1.4 GB + 181 MB)
    keystore/   the signing identity. It is not in the repository either: losing
                it means never shipping an update to an installed app again, and
                leaking it means anyone can sign updates as this app.

A note inside the archive says all of that, so whoever opens it later is not left
guessing why the tree looks incomplete.

Usage: make_source_tar.py [--root DIR] [--out FILE]
"""
from __future__ import annotations

import io
import sys
import tarfile
import time
from pathlib import Path

SKIP_DIRS = {"lab", "build", "out", "keystore", ".git", "node_modules", "__pycache__"}
SKIP_SUFFIX = (".apk", ".aab", ".zip", ".log", ".p12", ".jks", ".keystore")

NOTE = """DHA — source snapshot

This archive holds the repository's source, not its build outputs:

  lab/        omitted — a 543 MB npm tree used to run a second harness locally
  build/ out/ omitted — generated payloads, APKs and hot packages
  keystore/   omitted on purpose — the app's signing identity. It is not in the
              repository either. Never share it: whoever holds it can sign an
              update that an installed app will accept.

To build, see docs/BUILD.md. The short version:

    sh scripts/assemble_payload.sh
    python3 scripts/make_payload_zip.py build/rootfs-ubuntu build/payload-assets/payload.zip
    sh scripts/build_apk.sh            # full APK
    SLIM=1 sh scripts/build_apk.sh     # shell-only APK

Versioning, release channels, and build details are documented in CHANGELOG.md,
OPEN_SOURCE_COMPLIANCE.md, and docs/BUILD.md.
"""


def main() -> None:
    options = sys.argv[1:]
    root = Path(options[options.index("--root") + 1]).resolve() if "--root" in options \
        else Path(__file__).resolve().parent.parent
    version = (root / "VERSION").read_text(encoding="utf-8").strip() \
        if (root / "VERSION").is_file() else "0.0.0"
    terminal = (root / "ROOTFS_VERSION").read_text(encoding="utf-8").strip() \
        if (root / "ROOTFS_VERSION").is_file() else "1"
    out = Path(options[options.index("--out") + 1]).resolve() if "--out" in options \
        else root / f"DHA-source-{version}-t{terminal}.tar.gz"

    included = skipped = 0
    with tarfile.open(out, "w:gz", compresslevel=9) as archive:
        note = NOTE.encode("utf-8")
        info = tarfile.TarInfo("DHA/PACKAGE-NOTE.txt")
        info.size, info.mtime, info.mode = len(note), int(time.time()), 0o644
        archive.addfile(info, io.BytesIO(note))

        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root)
            if any(part in SKIP_DIRS for part in relative.parts):
                skipped += 1
                continue
            if relative.name.endswith(SKIP_SUFFIX):
                skipped += 1
                continue
            if path.is_symlink():
                # A link is only meaningful next to its target; keep it as a link.
                entry = tarfile.TarInfo(f"DHA/{relative.as_posix()}")
                entry.type, entry.linkname = tarfile.SYMTYPE, str(path.readlink())
                entry.mtime, entry.mode = int(path.lstat().st_mtime), 0o777
                archive.addfile(entry)
                included += 1
                continue
            if not path.is_file():
                continue
            archive.add(path, arcname=f"DHA/{relative.as_posix()}")
            included += 1

    print(f"wrote {out} ({out.stat().st_size / 1048576:.2f} MB, {included} files, {skipped} paths skipped)")


if __name__ == "__main__":
    main()
