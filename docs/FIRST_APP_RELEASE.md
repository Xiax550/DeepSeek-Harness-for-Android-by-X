# First Formal App Release

The first formal Android app release was published on 2026-11-02 as DHA `1.2.58`
(version code `10271`), with hot version `1.2.58-t3-sp17`. Its application
download URLs are pinned to the `v1.2.58` release tag; the runtime `t3` package
uses its own tag.

## First-release verification

The release was cover-installed on Xiaomi `23127PN0CC` running Android 16
without clearing app data. Focused checks covered launch, repeated new-session
navigation, settings, plugin-market loading, compact floating input, natural
sit/sleep/wake transitions and the in-app update check. No DHA fatal exception
was found in the inspected logs. This was not exhaustive testing of every model,
voice provider, plugin or long-running task.

The first-release source, signing identity and Android version history remain
intact. Historical Release asset availability is not asserted here.

## Current source candidate

This branch contains the `1.2.59` source update (version code `10275`), including
the character motion refinements and session-navigation crash guard. The
candidate passed repeated browser regression and an on-device 24-cycle
existing-session/new-session stress test on OnePlus PLF110. It is not a published
binary release until matching signed assets and checksums are attached through
the release workflow.

## Privacy and attribution

The artwork declaration is recorded in `ARTWORK_RIGHTS.md`. Personal photos,
private conversations, API keys, signing keys, device screenshots and device
logs are not part of the public source tree.
