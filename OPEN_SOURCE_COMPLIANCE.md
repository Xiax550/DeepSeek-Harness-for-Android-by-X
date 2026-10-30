# Open-source compliance

This document defines which license applies to which part of DHA and the checks
required before publishing an APK, payload, hot package, or release asset.

## License boundaries

- Original DHA source code and project-owned artwork are MIT licensed. The
  upstream copyright notice remains in `LICENSE`.
- Bundled third-party code keeps its own license. MIT does not replace an
  AGPL, GPL, Apache, LGPL, or asset-specific license.
- Coopanion-derived floating-ball code is AGPL-3.0-or-later. Its separate
  character-art notice remains in
  `payload/opt/dsh/android/ball-web/coo/THIRD_PARTY_NOTICES.md`.
- The APK as a combined distribution is not described as "MIT only". It ships
  components under multiple licenses.
- The DHA and DeepSeek Harness names and marks are used descriptively. This
  project is unofficial and is not endorsed by DeepSeek.

The dependency versions, origins, purposes, and reproducibility limits are in
`DEPENDENCIES.md`. The detailed component/license inventory is in
`THIRD_PARTY.md`. License texts and source pointers are collected in
`LICENSES/README.md`.

## Release checklist

Before a public app release:

1. Run the unit tests and plugin-profile migration tests.
2. Verify the installed APK version, signature, package name, and launcher icon.
3. Generate and attach the corresponding source archive.
4. Include `LICENSE`, `NOTICE.md`, `DEPENDENCIES.md`, `THIRD_PARTY.md`,
   `OPEN_SOURCE_COMPLIANCE.md`, and `LICENSES/` in the source archive.
5. Confirm that every network-downloaded binary has a pinned checksum and a
   documented source, version, license, and corresponding-source location.
6. Generate an SBOM from the exact final payload, including the full npm tree
   and Ubuntu package inventory; the hand-maintained dependency overview is not
   a substitute for this release-specific inventory.
7. For AGPL components, provide the preferred form for modification and retain
   prominent notices that the app contains AGPL code.
8. Do not claim complete compliance while a component is marked "source
   unavailable" or "unverified" in `THIRD_PARTY.md`.

## Current release gate

The bundled PRoot binary identifies itself as PRoot, Copyright (C) 2015
STMicroelectronics, GPL v2 or later, and includes OpenMinis-specific source
paths. A public corresponding-source archive for that exact build is not
currently recorded. This is a release blocker for an APK distribution that
claims full GPL compliance.

The Coopanion-derived code is AGPL-3.0-or-later. A release must link to the
corresponding source revision and include the AGPL text and notices; publishing
only the APK is not sufficient.

The DHA icon was supplied by the maintainer as project artwork. Its source hash
and provenance are recorded in `assets/README.md`.
