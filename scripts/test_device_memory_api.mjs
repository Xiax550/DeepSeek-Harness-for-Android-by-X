import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:13080';
const token = process.env.DHA_TEST_WEB_TOKEN;
const bridgeToken = process.env.DHA_TEST_BRIDGE_TOKEN;
if (!token || !bridgeToken) throw new Error('Device test credentials required');
const login = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Device browser authentication succeeded');
const evidence = { at: new Date().toISOString(), checks: [], sessions: [] };
const check = message => { evidence.checks.push(message); console.log('PASS: ' + message); };
async function memory(body) {
  const response = await fetch(`${base}/dha-memory`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-dsh-token': bridgeToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  assert.ok(response.ok && data.ok, data.error || 'Memory API request failed');
  return data;
}
async function rpc(method, request) {
  const args = method === 'session/list' ? { _request: request } : { request };
  const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(30000) });
  const envelope = await response.json();
  assert.ok(envelope.result?.ok, JSON.stringify(envelope.result?.error || envelope));
  return envelope.result.value;
}
const original = await memory({ action: 'list' });
let fixtureId;
try {
  assert.ok(original.count >= 267);
  check('Imported 267 original memories on Xiaomi 14');
  let data = await memory({ action: 'configure', config: { enabled: false, autoRecall: false } });
  assert.equal(data.enabled, false); assert.equal(data.autoRecall, false);
  data = await memory({ action: 'list' });
  assert.equal(data.enabled, false); assert.equal(data.autoRecall, false);
  check('Both switches remain disabled on a fresh API read');
  await memory({ action: 'configure', config: { enabled: true, autoRecall: true } });
  const created = await memory({ action: 'save', workspace: '/root/1', memory: { content: 'DHA界面验收临时条目', level: 'fact', project: '内置记忆验收' } });
  fixtureId = created.result.id;
  await memory({ action: 'save', id: fixtureId, memory: { content: 'DHA界面验收条目已修改' } });
  data = await memory({ action: 'list', query: '条目已修改' });
  assert.equal(data.memories.length, 1);
  assert.equal(data.memories[0].id, fixtureId);
  await memory({ action: 'delete', id: fixtureId }); fixtureId = undefined;
  assert.equal((await memory({ action: 'list', query: '条目已修改' })).memories.length, 0);
  check('Native running API: create, edit, Chinese search and delete');
  const exported = await memory({ action: 'export' });
  assert.equal(exported.count, original.count); assert.match(exported.path, /DHA-memory-\d+\.json$/);
  check('Private JSON export contains every imported memory');

  const first = await rpc('session/create', { cwd: '/root/1' });
  evidence.sessions.push(first.sessionId);
  await rpc('session/rename', { sessionId: first.sessionId, title: '内置记忆验收：写入' });
  await rpc('session/prompt', { sessionId: first.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '这是DHA内置记忆真机验收。请只调用dha_memory_remember保存一条临时事实：DHA内置记忆验收暗号是青竹四七二九。project填内置记忆验收，level填fact，keywords填验收暗号和内置记忆。然后简短中文确认，不执行其他任务。' }] });
  check('Real model prompt admitted in a new session');
  async function history(sessionId) {
    const listed = await rpc('session/list', {});
    const mine = listed.items.find(item => item.sessionId === sessionId);
    if (!mine || typeof mine.projections?.asOfSeq !== 'number') return [];
    const page = await rpc('session/page', { address: { kind: 'session', sessionId }, throughSeq: mine.projections.asOfSeq, maxMessages: 100 });
    return page.records.map(record => record.event).filter(Boolean);
  }
  async function completed(sessionId) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const events = await history(sessionId);
      if (events.some(event => event.type === 'turn/end')) return events;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error('Real model turn did not finish within 150 seconds');
  }
  const firstEvents = await completed(first.sessionId);
  evidence.firstEvents = firstEvents;
  const saved = await memory({ action: 'list', query: '青竹四七二九' });
  assert.ok(saved.memories.some(row => row.project === '内置记忆验收'));
  check('Real model saved the test memory using the built-in tool');
  const second = await rpc('session/create', { cwd: '/root/1' });
  evidence.sessions.push(second.sessionId);
  await rpc('session/rename', { sessionId: second.sessionId, title: '内置记忆验收：跨会话读取' });
  await rpc('session/prompt', { sessionId: second.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'DHA内置记忆验收暗号是什么？请用dha_memory_search检索长期记忆后，只回答暗号，不执行其他任务。' }] });
  const secondEvents = await completed(second.sessionId);
  evidence.secondEvents = secondEvents;
  const assistant = secondEvents.filter(event => event.type.startsWith('assistant/') || event.type === 'message/committed');
  assert.ok(JSON.stringify(assistant).includes('青竹四七二九'), 'Second session assistant returned the stored passphrase');
  check('Another real session recalled the passphrase without being told its value');
} finally {
  if (fixtureId) await memory({ action: 'delete', id: fixtureId });
  const testing = await memory({ action: 'list', query: '青竹四七二九' });
  for (const row of testing.memories) if (row.project === '内置记忆验收' && row.source === 'DHA') await memory({ action: 'delete', id: row.id });
  await memory({ action: 'configure', config: { enabled: original.enabled, autoRecall: original.autoRecall } });
  evidence.finalCount = (await memory({ action: 'list' })).count;
  writeFileSync(new URL('../build/dha-memory-device-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log('Test memories removed; original settings restored; evidence written.');
}
