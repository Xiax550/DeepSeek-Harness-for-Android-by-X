# Security policy

## Supported versions

Security fixes are provided for the latest published DHA release. Older builds
may receive a fix only when the issue also affects the current release.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting or a private Security Advisory for
this repository. Do not disclose the issue in a public issue before a fix is
available.

Include:

- affected DHA version and Android version;
- the security impact and realistic attack path;
- minimal reproduction steps;
- relevant logs with API keys, tokens, cookies, and personal data removed.

Never attach a signing key, `keystore/`, `.credentials.yaml`, conversation
databases, uploaded files, or an unredacted full application-data backup.

## Scope

Security-sensitive surfaces include the localhost control bridge, the PRoot
sandbox boundary, file mounts, WebView bridges, Shizuku and accessibility
commands, update verification, plugin installation, and privileged shell tools.

Issues in third-party dependencies should also be reported upstream when
appropriate. This project will track and document vulnerable bundled versions
that affect DHA users.

## Release handling

Security releases may be published before public issue details. Checksums and
the corresponding source archive are attached to each app release.

