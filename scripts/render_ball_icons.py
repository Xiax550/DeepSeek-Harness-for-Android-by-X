"""Render the floating ball's marks from SVG into the payload as PNGs.

Why raster: BallService.icon() reads a *file* the user picked, and
VectorDrawable.createFromXml() only accepts a parser produced from compiled
resources — handed Xml.newPullParser() it throws

    ClassCastException: android.util.XmlPullAttributes cannot be cast to
    android.content.res.XmlBlock$Parser

and the ball silently falls back to the built-in whale. That is why the presets
ship as PNGs (BitmapFactory.decodeFile, which works everywhere) while these SVGs
stay the editable source, next to assets/whale.svg.

Usage: python3 scripts/render_ball_icons.py [size]
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "ball"
TARGET = ROOT / "payload" / "opt" / "dsh" / "android" / "ball"
SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 192


def main() -> None:
    if shutil.which("rsvg-convert") is None:
        sys.exit("rsvg-convert is required (apt install librsvg2-bin)")
    TARGET.mkdir(parents=True, exist_ok=True)
    for svg in sorted(SOURCE.glob("*.svg")):
        out = TARGET / (svg.stem + ".png")
        subprocess.run(["rsvg-convert", "-w", str(SIZE), "-h", str(SIZE),
                        "-o", str(out), str(svg)], check=True)
        print(f"{svg.name} -> {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
    # The XML presets this replaced cannot work (see the docstring): drop them so a
    # stale copy never ships and nobody re-tries the file-parsed vector path.
    for stale in TARGET.glob("*.xml"):
        stale.unlink()
        print("removed dead preset", stale.relative_to(ROOT))


if __name__ == "__main__":
    main()
