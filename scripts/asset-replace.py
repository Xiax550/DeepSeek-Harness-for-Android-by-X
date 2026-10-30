#!/usr/bin/env python3
"""Replace release assets by name, with retries (this network drops TLS constantly).

Used for in-place asset replacement: the release, its tag and its other assets are
left alone. A 422 from GitHub means "that name is taken" — usually a request whose
response was lost after the server had stored the file — so each attempt deletes the
name first.

Usage: asset-replace.py <tag> <file> <asset-name> <content-type> [<file> <name> <type> ...]
       asset-replace.py v1.2.0 build/hot-assets/hot.zip dsh-hot.zip application/zip \\
                        out/SHA256SUMS SHA256SUMS text/plain
Token: /root/.dsh/gh-token (never printed, never put on a command line).
"""
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

REPO = os.environ.get("DHA_REPO", "Xiax550/DeepSeek-Harness-for-Android-by-X")
TOKEN = pathlib.Path("/root/.dsh/gh-token").read_text().strip()
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"}


def call(url, method="GET", headers=None, data=None, tries=6, quiet=False):
    last = None
    for attempt in range(1, tries + 1):
        request = urllib.request.Request(url, data=data, headers={**HEADERS, **(headers or {})}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=1800) as response:
                body = response.read()
                return response.status, (json.loads(body) if body else None)
        except urllib.error.HTTPError as error:
            last = f"HTTP {error.code}"
            if error.code in (401, 403, 404):
                raise
            if error.code == 422:
                return 422, None
        except Exception as error:                       # ssl / EOF / timeout
            last = type(error).__name__
        if not quiet:
            print(f"    retry {attempt}/{tries} ({last})", flush=True)
        time.sleep(min(20, 4 * attempt))
    raise SystemExit(f"gave up on {url}: {last}")


def main():
    args = sys.argv[1:]
    if len(args) < 4 or len(args) % 3 != 1:
        raise SystemExit(__doc__)
    tag, rest = args[0], args[1:]
    status, release = call(f"https://api.github.com/repos/{REPO}/releases/tags/{tag}")
    release_id = release["id"]
    print(f"release {tag} id={release_id}")

    for index in range(0, len(rest), 3):
        path, name, content_type = pathlib.Path(rest[index]), rest[index + 1], rest[index + 2]
        data = path.read_bytes()
        print(f"  {name} <- {path} ({len(data)} bytes)")
        for attempt in range(1, 7):
            status, assets = call(f"https://api.github.com/repos/{REPO}/releases/{release_id}/assets")
            old = [a for a in assets if a["name"] == name]
            if old:
                call(f"https://api.github.com/repos/{REPO}/releases/assets/{old[0]['id']}",
                     method="DELETE", quiet=True)
                print(f"    deleted old {name} (id {old[0]['id']})")
            status, created = call(
                f"https://uploads.github.com/repos/{REPO}/releases/{release_id}/assets?name={name}",
                method="POST", headers={"Content-Type": content_type}, data=data,
            )
            if status == 201:
                print(f"    {created['name']} {created['size']} bytes {created.get('digest')}")
                break
            print(f"    attempt {attempt}: HTTP {status}")
            time.sleep(6)
        else:
            raise SystemExit(f"upload failed: {name}")

    status, final = call(f"https://api.github.com/repos/{REPO}/releases/{release_id}")
    print("\n=== assets")
    for asset in final["assets"]:
        print(f"  {asset['name']:22} {asset['size']:>11} bytes  {asset.get('digest')}")


if __name__ == "__main__":
    main()
