"""Read an exact payload ZIP without executing it; emit a dependency inventory.

Package metadata is evidence, not a legal audit. Dependencies without license
metadata are explicitly reported instead of assigned an invented license.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


def deb822(text):
    records = []
    for block in re.split(r'\r?\n\s*\r?\n', text.strip()):
        item, key = {}, None
        for line in block.splitlines():
            if line[:1].isspace() and key:
                item[key] += '\n' + line[1:]
            elif ': ' in line:
                key, value = line.split(': ', 1)
                item[key] = value
        if item:
            records.append(item)
    return records


def inventory(payload):
    digest = hashlib.file_digest(payload.open('rb'), 'sha256').hexdigest()
    result = {'format': 'DHA-payload-inventory-1', 'payloadSha256': digest,
              'scope': 'Exact base payload; application hot overlay inventoried separately in source/hot.json.',
              'limitations': ['Metadata is not independent license verification.',
                              'This inventory is not itself corresponding source or a source offer.'],
              'npm': [], 'debian': [], 'metadataErrors': []}
    with zipfile.ZipFile(payload) as archive:
        names = set(archive.namelist())
        for name in sorted(names):
            if not name.endswith('/package.json'):
                continue
            try:
                data = json.loads(archive.read(name))
            except (ValueError, UnicodeError) as error:
                result['metadataErrors'].append({'path': name, 'error': type(error).__name__})
                continue
            if not data.get('name') or not data.get('version'):
                continue
            parent = name.rsplit('/', 1)[0]
            notices = sorted(p for p in names if p.startswith(parent + '/')
                             and '/' not in p[len(parent) + 1:]
                             and re.match(r'(?i)(licen[sc]e|copying|notice|copyright)', p.rsplit('/', 1)[-1]))
            result['npm'].append({'path': parent, 'name': data['name'], 'version': data['version'],
                                  'license': data.get('license', data.get('licenses', 'NOASSERTION')),
                                  'repository': data.get('repository'),
                                  'packageJsonSha256': hashlib.sha256(archive.read(name)).hexdigest(),
                                  'noticeFiles': notices})
        for data in deb822(archive.read('var/lib/dpkg/status').decode('utf-8')):
            if data.get('Status') != 'install ok installed':
                continue
            package = data['Package']
            copyright_path = 'usr/share/doc/' + package + '/copyright'
            result['debian'].append({'name': package, 'version': data.get('Version'),
                'architecture': data.get('Architecture'),
                'source': data.get('Source', package),
                'copyrightFile': copyright_path if copyright_path in names else None})
    result['missingNpmLicenseMetadata'] = [p['path'] for p in result['npm'] if p['license'] == 'NOASSERTION']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('payload', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = inventory(args.payload)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"Inventory: {len(result['npm'])} npm entries, {len(result['debian'])} installed Debian packages; "
          f"{len(result['missingNpmLicenseMetadata'])} missing license metadata; "
          f"{len(result['metadataErrors'])} malformed manifests")


if __name__ == '__main__':
    main()
