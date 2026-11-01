import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app/java/com/dha/harness/WebBootPolicy.java', import.meta.url), 'utf8');
const expression = source.match(/PROBE = ([\s\S]*?);\r?\n/)[1];
const script = [...expression.matchAll(/"((?:\\.|[^"\\])*)"/g)]
  .map(match => JSON.parse('"' + match[1] + '"')).join('');
for (const [boot, expected] of [[null, 'ready'], [{textContent:'Loading plugins…'}, 'loading'],
  [{textContent:'HARNESS Failed to load plugins'}, 'failed']]) {
  const document = {querySelector(selector) { assert.equal(selector, '[data-dsh-boot]'); return boot; }};
  assert.equal(vm.runInNewContext(script, {document}), expected);
}
console.log('Web boot probe: loading, bootstrap failure and normal page passed');
