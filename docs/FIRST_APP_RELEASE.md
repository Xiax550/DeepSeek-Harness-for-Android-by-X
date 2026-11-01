# First Formal App Release

Published on 2026-11-02: `v1.2.58`, Android versionCode `10271`,
hot version `1.2.58-t3-sp17`.

## Distribution

- App release: <https://github.com/Xiax550/DeepSeek-Harness-for-Android-by-X/releases/tag/v1.2.58>.
- The release includes full/slim APKs, the hot package, corresponding source,
  PRoot source, runtime inventory, checksums and verification notes.
- Runtime `t3` remains available for slim installations and is not the latest
  application release. Application download URLs are pinned to `v1.2.58`.
- Historical app releases were already absent when inspected; this publication
  did not delete them or reset source history, signing identity or versionCode.
- The release tag identifies the tested application source. Later documentation
  cleanups on `main` do not replace the published binaries or move that tag.

## Verification

Cover-installed on a Xiaomi 23127PN0CC running Android 16 without clearing app
data. Tested launch, repeated new-session navigation, settings, plugin-market
loading, compact floating input, natural sit/sleep/wake transitions and the
in-app update check. No DHA fatal exception was found in the inspected logs.

A plugin-bootstrap failure found during testing led to bounded WebView recovery;
policy/detector tests passed and final device launches passed. The forced-failure
retry branch itself was not demonstrated on the phone.

Published download endpoints returned HTTP 200. The primary raw update endpoint
returned HTTP 502 during desktop verification; the fallback route and the actual
phone's update check succeeded. Two desktop plugin tests require the unavailable
`/opt/dsh` runtime; they were not passing end-to-end desktop tests. This is not an
exhaustive model, voice, plugin or long-running-task verification.

## Privacy and Attribution

The maintainer's ChatGPT-assisted artwork declaration is in
[ARTWORK_RIGHTS.md](../ARTWORK_RIGHTS.md). Personal photographs, ChatGPT
conversation screenshots, device logs, signing keys and user memory were not
included in the public source/release. Local device evidence remains private.

See [OPEN_SOURCE_COMPLIANCE.md](../OPEN_SOURCE_COMPLIANCE.md) for dependency and
corresponding-source obligations. These records are not a blanket legal audit.
