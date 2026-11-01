import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const token = process.env.DHA_TEST_BRIDGE_TOKEN;
if (!token) throw new Error('Device bridge credential required');
const evidence = { at: new Date().toISOString(), checks: [] };
async function api(body, valid = true) {
  const response = await fetch('http://127.0.0.1:13080/dha-memory', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  if (valid) assert.ok(response.ok && data.ok, data.error);
  else assert.equal(response.status, 400);
  return data;
}
const check = text => { evidence.checks.push(text); console.log('PASS:', text); };
const before = await api({ action: 'list', status: 'all' });
let id;
try {
  const created = await api({ action: 'save', workspace: '/tmp/dha-scope-validation-a', memory: { content: '临时作用域验收，请勿保留', project: '作用域验收', workspace: '*' } });
  id = created.result.id;
  assert.equal(created.result.workspace, '*');
  check('New memory uses the explicit global scope instead of the active list filter');
  const changed = await api({ action: 'save', id, memory: { workspace: '/tmp/dha-scope-validation-b' } });
  assert.equal(changed.result.workspace, '/tmp/dha-scope-validation-b');
  assert.equal(changed.result.created_at, created.result.created_at);
  assert.equal(changed.result.source, created.result.source);
  check('Global to workspace scope edit preserves identity and original fields');
  const read = await api({ action: 'list', workspace: '/tmp/dha-scope-validation-b' });
  assert.equal(read.memories.find(row => row.id === id).workspace, '/tmp/dha-scope-validation-b');
  const hidden = await api({ action: 'list', workspace: '/tmp/dha-scope-validation-a' });
  assert.ok(!hidden.memories.some(row => row.id === id));
  check('Fresh reads and workspace filtering respect the saved scope');
  await api({ action: 'save', id, memory: { workspace: 'relative' } }, false);
  const restored = await api({ action: 'save', id, memory: { workspace: '*' } });
  assert.equal(restored.result.workspace, '*');
  check('Invalid scope rejected; workspace to global scope succeeds');
} finally {
  if (id) await api({ action: 'delete', id });
  const after = await api({ action: 'list', status: 'all' });
  assert.equal(after.totalCount, before.totalCount);
  assert.equal(after.count, before.count);
  evidence.count = after.count; evidence.totalCount = after.totalCount;
  check('Temporary memory removed and original memory counts unchanged');
  writeFileSync('build/device-memory-scope-evidence.json', JSON.stringify(evidence, null, 2));
}
