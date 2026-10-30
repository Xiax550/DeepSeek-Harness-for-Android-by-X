import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

const prootSha = 'f6b0381ab9a066fa620fef0001737fd3cfaf9d22474f013ac48d7861411374ac';
const appCommit = '4ef29002e88db1e20e462ec2ff46916e8a7dcb45';
const prootCommit = '8cf13e997cdc9472997aae19df8050c073c9a86c';

for (const path of ['THIRD_PARTY.md', 'DEPENDENCIES.md', 'docs/BUILD-PROOT.md', 'OPEN_SOURCE_COMPLIANCE.md']) {
  const text = read(path);
  assert.ok(text.includes(prootSha), `${path} contains the ELF hash`);
  assert.ok(text.includes(appCommit), `${path} contains the OpenMinis commit`);
  assert.ok(text.includes(prootCommit), `${path} contains the PRoot commit`);
}

const licenseFiles = readdirSync(join(root, 'LICENSES')).filter((name) => name.endsWith('.txt')).sort();
assert.equal(licenseFiles.length, 10);
const shellPacker = read('scripts/build_apk.sh');
for (const name of licenseFiles) {
  assert.ok(shellPacker.includes(`LICENSES/${name}`), `Unix APK packer includes ${name}`);
}
const windowsPacker = read('scripts/build_apk.ps1');
assert.match(windowsPacker, /Get-ChildItem .*LICENSES.*-Filter \*\.txt/);

const update = JSON.parse(read('update.json'));
assert.match(update.hot.manifest, /^https:\/\/cdn\.jsdelivr\.net\/gh\/Xiax550\/DeepSeek-Harness-for-Android-by-X@main\//);
const generator = read('scripts/make_update_manifest.py');
assert.ok(generator.includes('"Xiax550/DeepSeek-Harness-for-Android-by-X"'));
assert.ok(generator.includes('cdn.jsdelivr.net/gh/'));

for (const path of ['scripts/build-proot.sh', 'scripts/make-proot-source.sh']) {
  const text = read(path);
  assert.ok(text.includes(appCommit), `${path} pins the OpenMinis commit`);
  assert.ok(text.includes(prootCommit), `${path} pins the PRoot commit`);
}
const bundle = read('scripts/make-proot-source.sh');
assert.ok(bundle.includes('proot-src-8cf13e99.tar.gz'));
assert.ok(bundle.includes('COPYING'));

const attributes = read('.gitattributes');
for (const pattern of ['*.xml text eol=lf', '*.txt text eol=lf', '*.json text eol=lf',
  'SOURCE_SHA256SUMS.txt text eol=lf', 'SOURCE_FILE_MANIFEST.txt text eol=lf']) {
  assert.ok(attributes.includes(pattern), `.gitattributes contains ${pattern}`);
}

console.log('Compliance regression: PRoot pins, license packing, mirrors and source bundle passed.');
