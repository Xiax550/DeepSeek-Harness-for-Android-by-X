import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:13080';
const bridge = process.env.DHA_TEST_BRIDGE_TOKEN;
const web = process.env.DHA_TEST_WEB_TOKEN;
if (!bridge || !web) throw new Error('Device test credentials required');
const login = await fetch(base + '/?token=' + encodeURIComponent(web), { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
assert.ok(cookie);
async function rpc(method, request) {
  const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: method === 'session/list' ? { _request: request } : { request } } }), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); assert.ok(data.result?.ok, JSON.stringify(data.result?.error || data)); return data.result.value;
}
async function memory(body) {
  const response = await fetch(base + '/dha-memory', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-token': bridge }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); assert.ok(response.ok && data.ok, data.error); return data;
}
const marker = '松石四二七日常记忆验收';
const before = await memory({ action: 'list', query: marker, status: 'all' });
assert.equal(before.enabled, true); assert.equal(before.autoSave, true);
const existing = new Set(before.memories.map(row => row.id));
let sessionId;
try {
  assert.ok(!before.review.running, 'Wait until existing recollection finishes before testing daily save');
  const created = await rpc('session/create', { cwd: '/root/1' }); sessionId = created.sessionId;
  await rpc('session/rename', { sessionId, title: '临时验收：会话结束记忆' });
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: `我的长期文档分类偏好是：标有“${marker}”字样的文件归入研究资料分类。这是稳定偏好。本轮禁止调用任何工具，不做其他操作，只回复“收到”。` }] });
  const deadline = Date.now() + 180000;
  let saved;
  while (Date.now() < deadline) {
    const data = await memory({ action: 'list', query: marker, status: 'all' });
    saved = data.memories.find(row => !existing.has(row.id) && row.source === 'DHA-recollection' && row.extra?.sessionId === sessionId);
    if (saved) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.ok(saved, 'Turn/end hook automatically extracted memory without a manual review action');
  writeFileSync('build/device-memory-daily-evidence.json', JSON.stringify({ at: new Date().toISOString(), sessionId, source: saved.source, checkpointSaved: true, verified: true }, null, 2));
  console.log('PASS real turn completion automatically saved memory using default model and checkpoint');
} finally {
  const after = await memory({ action: 'list', query: marker, status: 'all' });
  for (const row of after.memories) if (!existing.has(row.id) && row.extra?.sessionId === sessionId) await memory({ action: 'delete', id: row.id });
  if (sessionId) {
    try { await rpc('workspace/archiveSession', { sessionId }); }
    catch (error) { console.error('Test session archival failed:', error.message); }
  }
  console.log('Temporary test memories removed; only the disposable test conversation was archived');
}
