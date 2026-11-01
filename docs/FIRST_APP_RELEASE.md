# Replacement First App Release

Status: PREPARATION ONLY. Not published. Maintainer artwork declaration recorded
on 2026-11-02 in `../ARTWORK_RIGHTS.md`; binary/source verification is still required.

## Target

- Repository: `Xiax550/DeepSeek-Harness-for-Android-by-X`.
- Authenticated GitHub inspection on 2026-11-02 returned no current Releases.
  Historical app `v1.2.50` (id `429100059`) and runtime `t3` (id `429138520`)
  must not be treated as currently available or as deleted by this preparation.
- Preserve or restore the runtime `t3` download route required by the sandbox.
- Replacement app: `1.2.58`, versionCode `10271`; hot version must be read from
  the final rebuild (internal tested candidate: `1.2.58-t3-sp16`).
- Intended title: `DHA 1.2.58 - 首个正式应用发布`.
- Keep monotonic Android and hot version numbers; first-release wording does not
  reset application identity, signing key, source history or versionCode.

## Safe Order

1. Confirm artwork authorization under `../ARTWORK_RIGHTS.md`.
2. Synchronize the actual tested source into the public checkout, excluding
   credentials, signing keys, user profiles, memory databases and device logs.
   This release plan alone does not mean the public checkout matches 1.2.58.
3. Generate the exact runtime npm and Ubuntu dependency inventory and provide
   the license/source materials required by `../OPEN_SOURCE_COMPLIANCE.md`.
   `RUNTIME_INVENTORY.json` now records 763 npm and 156 installed Debian entries;
   it is metadata evidence, not an independent legal audit.
4. Rebuild after changing embedded notices. A previously tested APK containing
   stale license notices must not be relabeled as the final compliant binary.
5. Verify signatures, hashes, source correspondence, tests and device checks.
   Current device tests do not cover real model tasks without a configured key.
6. Back up the old Release JSON, notes and all assets to local release staging.
7. Publish and verify the replacement assets and matching source; keep all app
   download URLs pinned to `releases/download/v1.2.58/`, not `latest` or `t3`.
8. Update the public update manifest through the normal protected-branch PR and
   required CI checks. Confirm downloads and upgrade path work.
9. Delete only the old app Release after replacement verification. Retain its
   tag and source history for provenance unless separately instructed otherwise.
   Do not delete runtime `t3`, the repository, branches or user data.

## Required Assets

- `DHA-1.2.58-arm64.apk`.
- Slim and hot packages only if separately built and verified.
- Corresponding project source archive and `proot-src-8cf13e99.tar.gz`.
- Release notes with actual verification coverage and remaining limitations.
- Runtime dependency inventory and `SHA256SUMS.txt` covering actual assets.

Do not publish links to unbuilt assets. The app installed during the device test
is an internal candidate, not proof that the public release checklist is complete.
