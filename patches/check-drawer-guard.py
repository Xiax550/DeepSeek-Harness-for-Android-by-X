#!/usr/bin/env python3
"""Assert the drawer guard in patches/android-mobile.js (issue #1).

The session-row click listener runs in the capture phase, so it decides *before*
the app sees the click. Two behaviours have to hold at once:

  * a click on the row BODY selects the session and dismisses the drawer
    (that is why the listener exists at all);
  * a click on a CONTROL inside the row — the ⋯ button or anything in the menu it
    opens — must NOT dismiss the drawer, because that unmounts the menu's anchor
    and the menu flashes and disappears.

Run:  python3 patches/check-drawer-guard.py
Exit: 0 when both hold, 1 with the reason otherwise.
"""
import re
import sys
from pathlib import Path

SOURCE = Path(__file__).with_name("android-mobile.js")


def main() -> int:
    text = SOURCE.read_text(encoding="utf-8")
    problems = []

    guard = re.search(
        r"""if\s*\(\s*target\.closest\(\s*['"]button,\s*\[role="menuitem"\],\s*"""
        r"""\[aria-haspopup="menu"\],\s*\[role="menu"\]['"]\s*\)\s*!==\s*null\s*\)\s*return\s*;""",
        text)
    if guard is None:
        problems.append("the control guard is missing or no longer matches the expected shape")

    if "target.closest('[class*=\"_sessionRow\"]') === null) return;" not in text:
        problems.append("the session-row test is gone: row clicks would stop selecting")

    if "dismissDrawer();" not in text:
        problems.append("dismissDrawer() is no longer called: the drawer would never close")

    # The guard has to come BEFORE the dismiss call in the same listener.
    if guard is not None:
        listener = text[text.index("document.addEventListener("):]
        listener = listener[:listener.index("true\n      );") if "true\n      );" in listener else len(listener)]
        if listener.find("target.closest('button") > listener.find("dismissDrawer();"):
            problems.append("the guard is after the dismiss call: it cannot protect the menu")

    if problems:
        for problem in problems:
            print("FAIL " + problem)
        return 1
    print("drawer guard OK: row body selects + closes, controls inside the row neither")
    print("  guard: " + guard.group(0)[:96] + " …")
    return 0


if __name__ == "__main__":
    sys.exit(main())
