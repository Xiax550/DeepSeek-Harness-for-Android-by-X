import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/memory-store.js';
import { MemoryReview, reviewSlot, reviewWindow, reviewDeadline, nextReviewChunk } from '../lib/memory-review.js';

const now = Date.parse('2026-10-31T16:00:00Z');
const message = (seq, text, role = 'user') => ({ seq, time: now - 10 * 86400000, type: `${role}/message`, data: { source: { kind: role }, content: [{ type: 'text', text }] } });
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dha-review-'));
  const db = new MemoryStore(join(dir, 'memory.db'));
  db.configure({ reviewCompact: false });
  const sessions = new Map(); const archived = new Set(), pinned = new Set(), running = new Set();
  const add = (id, cwd, text, updatedAt = now - 10 * 86400000) => sessions.set(id, { meta: { id, cwd, createdAt: now - 10 * 86400000 }, events: text === null ? [] : [message(0, text)], updatedAt });
  const calls = [];
  const services = {
    async list() { return [...sessions].map(([sessionId, s]) => ({ sessionId, updatedAt: s.updatedAt })); },
    async inspect(id) { return sessions.get(id); },
    isRunning: id => running.has(id), isPinned: id => pinned.has(id), isArchived: id => archived.has(id),
    async archive(id) { archived.add(id); },
    async generate(_policy, input) { const data = JSON.parse(input); calls.push(data); return JSON.stringify({ memories: data.messages.map(m => ({ content: '已确认：' + m.text, level: 'fact' })) }); }
  };
  const review = new MemoryReview({ store: db, services, directory: join(dir, 'backup'), now: () => now, ...options });
  t.after(async () => { await review.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, sessions, add, calls, review, services, archived, pinned, running };
}

test('time zone schedule crosses midnight and repeated DST hour only has one slot', () => {
  assert.equal(reviewSlot(Date.parse('2026-10-31T14:59:00Z'), '23:00', 'Asia/Shanghai'), '2026-10-30@23:00@Asia/Shanghai');
  assert.equal(reviewSlot(Date.parse('2026-10-31T15:00:00Z'), '23:00', 'Asia/Shanghai'), '2026-10-31@23:00@Asia/Shanghai');
  assert.equal(reviewSlot(Date.parse('2026-11-01T05:45:00Z'), '01:30', 'America/New_York'), reviewSlot(Date.parse('2026-11-01T06:45:00Z'), '01:30', 'America/New_York'));
});

test('default review budget permits 42 calls and leaves further work pending', async t => {
  const { add, review, calls } = fixture(t);
  assert.equal(review.maxCalls, 42);
  await assert.rejects(review.run(undefined, 43), /调用上限/);
  for (let i = 0; i < 43; i++) add('budget-' + i, '/root/test', '调用预算验证 ' + i);
  await review.run();
  assert.equal(calls.length, 42);
  assert.equal(review.status().pending, true);
  await review.run(undefined, 1);
  assert.equal(calls.length, 43);
});

test('end-of-turn save only processes its own session and preserves nightly schedule slot', async t => {
  const { add, review, db, calls } = fixture(t);
  add('one', '/root/a', '用户偏好中文'); add('two', '/root/b', '另一个工作区');
  db.setSetting('reviewState', { slot: 'nightly-existing' });
  await review.run(undefined, 1, 'one');
  assert.equal(calls.length, 1); assert.equal(calls[0].workspace, '/root/a');
  assert.equal(db.setting('reviewState').slot, 'nightly-existing');
  assert.equal(db.setting('reviewCursor:two', null), null);
  await review.run(undefined, 1, 'one'); assert.equal(calls.length, 1);
});

test('configuration validates atomically and persists across reopening', async t => {
  const { db, dir } = fixture(t);
  assert.throws(() => db.configure({ enabled: false, reviewTime: '24:30' }));
  assert.equal(db.config().enabled, true);
  for (const value of [0, 366, 1.5, '7']) assert.throws(() => db.configure({ reviewRetentionDays: value }));
  assert.throws(() => db.configure({ reviewTimeZone: 'invalid' }));
  assert.throws(() => db.configure({ reviewEndTime: '25:00' }));
  assert.throws(() => db.configure({ reviewTime: '22:00', reviewEndTime: '22:00' }));
  db.configure({ reviewTime: '01:10', reviewEnabled: true, reviewCleanup: true, reviewTimeZone: 'Asia/Shanghai', reviewRetentionDays: 12 });
  const second = new MemoryStore(join(dir, 'memory.db'));
  assert.equal(second.config().reviewTime, '01:10');
  assert.equal(second.config().reviewCleanup, true);
  db.configure({ reviewTime: '23:30', reviewEndTime: '05:45' });
  assert.equal(second.config().reviewEndTime, '05:45');
  second.close();
});

test('time range includes start, excludes end and has a stable slot across midnight', () => {
  const config = { reviewTime: '23:00', reviewEndTime: '06:00', reviewTimeZone: 'Asia/Shanghai' };
  const start = Date.parse('2026-10-31T15:00:00Z');
  assert.equal(reviewWindow(start - 1, config).inWindow, false);
  assert.equal(reviewWindow(start, config).inWindow, true);
  assert.equal(reviewWindow(start + 6 * 3600000, config).slot, reviewWindow(start, config).slot);
  assert.equal(reviewWindow(start + 7 * 3600000, config).inWindow, false);
  assert.equal(reviewDeadline(start + 7 * 3600000 - 25000, config), 25000);
  assert.equal(reviewDeadline(start - 1, config), 0);
  const daytime = { ...config, reviewTime: '10:00', reviewEndTime: '11:00' };
  assert.equal(reviewWindow(Date.parse('2026-10-31T02:30:00Z'), daytime).inWindow, true);
  assert.equal(reviewWindow(Date.parse('2026-10-31T03:00:00Z'), daytime).inWindow, false);
});

test('range deadline handles a daylight-saving jump at the closing boundary', () => {
  const config = { reviewTime: '01:00', reviewEndTime: '03:00', reviewTimeZone: 'America/New_York' };
  assert.equal(reviewDeadline(Date.parse('2026-03-08T06:58:30Z'), config), 90000);
});

test('scheduled review never catches up outside the allowed time range', async t => {
  const { db, review, add, calls } = fixture(t, { now: () => Date.parse('2026-10-31T04:00:00Z') });
  db.configure({ reviewEnabled: true, reviewTimeZone: 'Asia/Shanghai', reviewTime: '23:00', reviewEndTime: '06:00' });
  add('a', '/a', '工作日内容'); await review.tick(); assert.equal(calls.length, 0);
  await assert.rejects(review.run('scheduled-slot'), /不在回忆时间段/);
  await review.run(); assert.equal(calls.length, 1);
});

test('scheduled model call is cancelled at the end of the range without advancing its cursor', async t => {
  const { db, review, add, services } = fixture(t, { now: () => Date.parse('2026-10-31T21:59:59.990Z') });
  db.configure({ reviewTime: '23:00', reviewEndTime: '06:00', reviewTimeZone: 'Asia/Shanghai' });
  add('deadline', '/a', '未完成的批次');
  services.generate = (_p, _input, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(review.run('scheduled-slot'));
  assert.equal(db.setting('reviewCursor:deadline', null), null);
  assert.equal(review.status().pending, true);
  assert.equal(review.status().running, false);
});

test('scheduled catch-up runs once per local night and honors disabled state', async t => {
  const { db, add, review, calls } = fixture(t);
  add('a', '/a', '补记内容');
  await review.tick(); assert.equal(calls.length, 0);
  db.configure({ reviewEnabled: true, reviewTimeZone: 'Asia/Shanghai' });
  await review.tick(); assert.equal(calls.length, 1);
  const started = review.status().startedAt;
  await review.tick(); assert.equal(review.status().startedAt, started); assert.equal(calls.length, 1);
});

test('scheduled failures back off rather than retry every minute', async t => {
  const { db, add, review, services } = fixture(t);
  db.configure({ reviewEnabled: true, reviewTimeZone: 'Asia/Shanghai' }); add('a', '/a', '内容');
  let attempts = 0; services.generate = async () => { attempts++; throw new Error('network unavailable'); };
  await assert.rejects(review.tick()); await review.tick();
  assert.equal(attempts, 1); assert.ok(review.status().retryAfter > now);
});

test('long messages have lossless chunk cursor and plugin/reasoning text is excluded', () => {
  const text = '中文'.repeat(15000);
  const events = [message(0, text), { ...message(1, '不应保存'), data: { source: { kind: 'plugin:dha-memory' }, content: [{ type: 'text', text: '不应保存' }] } }, { type: 'assistant/message', seq: 2, data: { content: [{ type: 'reasoning', text: '不要保存思考过程' }, { type: 'text', text: '结果' }] } }];
  let cursor; let result = '';
  for (let i = 0; i < 10; i++) { const chunk = nextReviewChunk(events, cursor); if (!chunk.messages.length) break; result += chunk.messages.map(m => m.text).join(''); cursor = chunk.cursor; }
  assert.equal(result, text + '结果');
});

test('all workspaces are processed, checkpoints prevent repeat extraction, running and subagents excluded', async t => {
  const { add, sessions, db, review, calls, running, services } = fixture(t);
  add('a', '/root/a', '喜欢中文'); add('b', '/root/b', '项目使用安卓'); add('busy', '/root/c', '尚在执行'); running.add('busy');
  add('sub', '/root/a', '子代理内容');
  const list = services.list; services.list = async () => (await list()).map(row => ({ ...row, ...(row.sessionId === 'sub' ? { origin: 'subagent' } : {}) }));
  await review.run();
  assert.equal(calls.length, 2); assert.equal(db.list().length, 2);
  assert.notEqual(db.list()[0].workspace, db.list()[1].workspace);
  await review.run(); assert.equal(calls.length, 2);
  sessions.get('a').events.push(message(1, '新增决定'));
  await review.run(); assert.equal(calls.length, 3); assert.equal(calls[2].messages[0].text, '新增决定');
});

test('call budget resumes mid-message without losing trailing content or duplicated work', async t => {
  const { add, db, review, calls, services } = fixture(t, { maxCalls: 1 });
  add('long', '/root/a', '甲'.repeat(25000));
  services.generate = async (_p, input) => { calls.push(JSON.parse(input)); return '{"memories":[]}'; };
  await review.run(); assert.equal(review.status().pending, true);
  await review.run(); await review.run();
  assert.equal(calls.flatMap(c => c.messages).reduce((n, m) => n + m.text.length, 0), 25000);
  assert.equal(db.setting('reviewCursor:long').offset, 25000);
  assert.equal(review.status().pending, false);
});

test('malformed model result saves neither memory nor checkpoint and a retry recovers', async t => {
  const { add, db, review, services } = fixture(t);
  add('a', '/root/a', '重要决定');
  const generate = services.generate;
  services.generate = async () => '{"memories":[{"content":"有效"},{"content":""}]}';
  await assert.rejects(review.run());
  assert.equal(db.list().length, 0); assert.equal(db.setting('reviewCursor:a', null), null);
  assert.equal(review.status().running, false);
  services.generate = generate; await review.run(); assert.equal(db.list().length, 1);
});

test('simultaneous starts coalesce and cancellation leaves the unprocessed cursor untouched', async t => {
  const { add, db, review, services } = fixture(t);
  add('a', '/root/a', '取消测试');
  services.generate = (_p, _i, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const first = review.run(); assert.equal(review.run(), first);
  await new Promise(resolve => setImmediate(resolve)); review.stop();
  await assert.rejects(first); assert.equal(db.setting('reviewCursor:a', null), null);
  db.configure({ enabled: false }); await assert.rejects(review.run(), /启用记忆/);
});

test('compaction preserves originals, protects workspace boundaries and is reversible', async t => {
  const { db, review, services, dir } = fixture(t);
  db.configure({ reviewCompact: true });
  const a = db.put({ content: '用户喜欢用中文回答', level: 'user' }, '/root/a');
  const b = db.put({ content: '用户喜欢中文回复', level: 'user' }, '/root/a');
  const c = db.put({ content: '用户喜欢中文回复', level: 'user' }, '/root/b');
  services.generate = async (_p, input) => { const { memories } = JSON.parse(input); return JSON.stringify({ merges: [{ ids: memories.map(m => m.id), content: '用户喜欢中文回答' }] }); };
  await review.run();
  assert.equal(db.get(a.id).status, 'archived'); assert.equal(db.get(b.id).status, 'archived'); assert.equal(db.get(c.id).status, 'active');
  assert.equal(db.list().length, 2); assert.equal(db.exportRows().length, 4);
  const backup = JSON.parse(readFileSync(join(dir, 'backup', readdirSync(join(dir, 'backup'))[0]), 'utf8'));
  assert.equal(backup.length, 3);
  db.update(a.id, { status: 'active' }); assert.equal(db.get(a.id).status, 'active');
});

test('out-of-bounds model merges fail without changing original memories', async t => {
  const { db, review, services } = fixture(t);
  db.configure({ reviewCompact: true }); db.put({ content: '原始甲' }, '/a'); db.put({ content: '原始乙' }, '/a');
  services.generate = async () => '{"merges":[{"ids":["bad","bad2"],"content":"恶意"}]}';
  await assert.rejects(review.run(), /越界/); assert.equal(db.list().length, 2);
});

test('cleanup defaults off then archives only old empty and exact duplicates, across workspaces', async t => {
  const { add, db, review, services, archived, pinned, running, sessions } = fixture(t);
  services.generate = async () => '{"memories":[]}';
  add('old', '/a', '相同对话', now - 11 * 86400000); add('new', '/a', '相同对话');
  add('other-workspace', '/b', '相同对话'); add('empty-b', '/b', null);
  add('pinned', '/a', null); pinned.add('pinned'); add('busy', '/b', null); running.add('busy');
  add('recent', '/c', null); sessions.get('recent').meta.createdAt = now - 1000;
  add('unique', '/c', '独有内容');
  await review.run(); assert.equal(archived.size, 0);
  db.configure({ reviewCleanup: true }); await review.run();
  assert.deepEqual([...archived].sort(), ['empty-b', 'old']);
});

test('new message before archival, image attachments and registry activity block unsafe cleanup', async t => {
  const { add, db, review, services, sessions, archived } = fixture(t);
  db.configure({ reviewCleanup: true }); services.generate = async () => '{"memories":[]}';
  add('changed', '/a', null); add('image-a', '/a', '图'); add('image-b', '/a', '图');
  sessions.get('image-a').events[0].data.content.push({ type: 'image', url: 'a' });
  sessions.get('image-b').events[0].data.content.push({ type: 'image', url: 'b' });
  let reads = 0; const inspect = services.inspect;
  services.inspect = async id => { if (id === 'changed' && ++reads > 1) sessions.get(id).events.push(message(0, '刚刚新增')); return inspect(id); };
  await review.run(); assert.equal(archived.size, 0);
});

test('a missing historical session does not starve other workspaces', async t => {
  const { add, review, services, db } = fixture(t);
  add('missing', '/a', '丢失会话'); add('valid', '/b', '有效内容');
  const inspect = services.inspect;
  services.inspect = async id => { if (id === 'missing') throw new Error('not found'); return inspect(id); };
  await review.run(); assert.equal(db.list().length, 1); assert.equal(review.status().skipped, 1); assert.equal(review.status().pending, true);
});
