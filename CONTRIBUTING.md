# Contributing to DHA

Thanks for helping improve DHA (DeepSeek Harness Android).

## Before opening an issue

- Search existing issues and the troubleshooting notes in `README.zh-CN.md`.
- Reproduce with the latest release when possible.
- For a security problem, follow `SECURITY.md` instead of opening a public issue.
- Remove API keys, cookies, session logs, phone numbers, and other private data
  from screenshots and logs.

## Pull requests

1. Keep the change focused on one problem.
2. Read the relevant build or architecture notes in `docs/`.
3. Describe the user-visible behavior, the root cause, and how it was tested.
4. Include a real-device model and Android version when the change affects the
   sandbox, WebView, accessibility service, floating ball, voice, or display.
5. Do not add generated APKs, payload archives, signing keys, credentials, or
   session data to the repository.

Useful checks:

```sh
node docs/repair-profile-test.mjs
sh docs/run-unit-tests.sh
sh -n payload/opt/dsh/android/start-dsh.sh
```

On Windows, a slim build is the quickest way to validate Java and resource
changes:

```powershell
& (Get-Content scripts\build_apk.ps1 -Raw) -Slim
```

## Licensing of contributions

By submitting a contribution, you agree that it may be distributed under the
repository's MIT license, and you confirm that you have the right to submit it.
Do not copy code, models, artwork, fonts, or other assets from an incompatible
license. New third-party material must be recorded in `THIRD_PARTY.md` with its
source, version or revision, license, and any required attribution.

Files that carry their own license remain under that license. See
`OPEN_SOURCE_COMPLIANCE.md` and `LICENSES/README.md`.

## Code style

- Preserve the existing small, dependency-light Android implementation.
- Keep protocol and path handling explicit; avoid shell-string interpolation.
- Add a short comment only when a non-obvious constraint explains the code.
- Do not silently rewrite user profile settings. Migrations must be additive,
  idempotent, and must preserve explicit user choices.

