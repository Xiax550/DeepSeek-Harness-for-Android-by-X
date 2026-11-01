import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/memory-store.js';
import { MemoryForget } from '../lib/memory-forget.js';
import { sessionRemoval } from '../lib/memory-session-removal.js';
import { isAutomationSession } from '../lib/memory-session-policy.js';

const DAY = 86400000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dha-forget-'));
  const store = new MemoryStore(join(dir, 'memory.db'));
  store.configure({ forgetScope: 'all' });
  let now = Date.parse('2026-11-01T00:00:00Z');
  const sessions = new Map(), archived = new Set(), pinned = new Set(), running = new Set(), loaded = new Set();
  const add = (id, age = 3 * DAY) => {
    sessions.set(id, { meta: { id, cwd: '/root/a', createdAt: now - age }, events: [{ seq: 0, time: now - age, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '稳定偏好' }] } }] });
    store.setSetting('reviewCursor:' + id, { seq: 0, offset: 4 });
  };
  const services = {
    async list() { return [...sessions].map(([sessionId, s]) => ({ sessionId, updatedAt: s.events.at(-1)?.time || s.meta.createdAt })); },
    async inspect(id) { return structuredClone(sessions.get(id)); },
    isArchived: id => archived.has(id), isPinned: id => pinned.has(id), isRunning: id => running.has(id), isLoaded: id => loaded.has(id),
    async archive(id) { archived.add(id); },
    async remove(id, snapshot, allowed) { assert.ok(allowed()); assert.deepEqual(sessions.get(id), snapshot); sessions.delete(id); archived.delete(id); }
  };
  const forget = new MemoryForget({ store, services, now: () => now });
  t.after(async () => { await forget.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, services, forget, sessions, archived, pinned, running, loaded, add, advance: ms => { now += ms; } };
}

test('forgetting is opt-in and uses three idle days plus two actual archived days', async t => {
  const { store, forget, add, archived, sessions, advance } = fixture(t);
  add('old'); add('young', 3 * DAY - 1);
  assert.equal(store.config().forgetEnabled, false);
  await forget.tick(true); assert.equal(archived.size, 0);
  store.configure({ forgetEnabled: true });
  await forget.tick(true); assert.deepEqual([...archived], ['old']);
  advance(2 * DAY - 1); await forget.tick(true); assert.ok(sessions.has('old'));
  advance(1); await forget.tick(true); assert.ok(!sessions.has('old'));
  assert.ok(sessions.has('young')); // Its two-day archive grace began on the prior check.
  assert.equal(store.setting('reviewCursor:old', null), null);
});

test('running pinned unreviewed attachments manual archives and live handles are protected', async t => {
  const { store, forget, add, archived, pinned, running, loaded, sessions, advance } = fixture(t);
  store.configure({ forgetEnabled: true });
  for (const id of ['running', 'pinned', 'unreviewed', 'attachment', 'manual', 'loaded']) add(id);
  running.add('running'); pinned.add('pinned');
  store.setSetting('reviewCursor:unreviewed', { seq: -1, offset: 0 });
  sessions.get('attachment').events[0].data.content.push({ type: 'image', url: 'important' });
  archived.add('manual'); loaded.add('loaded');
  await forget.tick(true);
  assert.deepEqual(new Set(archived), new Set(['manual', 'loaded']));
  advance(3 * DAY); await forget.tick(true); assert.equal(sessions.size, 6);
  store.configure({ forgetProtectUnreviewed: false }); await forget.tick(true);
  assert.ok(archived.has('unreviewed')); assert.ok(!archived.has('attachment'));
});

test('restoration cancels deletion and content changes are protected', async t => {
  const { store, forget, add, archived, sessions, advance } = fixture(t);
  store.configure({ forgetEnabled: true }); add('restored'); add('changed');
  await forget.tick(true);
  archived.delete('restored');
  sessions.get('changed').events[0].data.content[0].text = '修改后的内容';
  advance(2 * DAY); await forget.tick(true);
  assert.equal(sessions.size, 2);
  assert.ok(store.setting('forgetRecords').restored.restoredAt);
  assert.equal(store.setting('forgetRecords').changed, undefined);
  await forget.tick(true); assert.ok(!archived.has('restored'));
  advance(3 * DAY); await forget.tick(true); assert.ok(archived.has('restored'));
});

test('failed removal retries safely and disabled forgetting does not delete', async t => {
  const f = fixture(t); f.add('retry'); f.store.configure({ forgetEnabled: true }); await f.forget.tick(true);
  f.advance(2 * DAY); const remove = f.services.remove;
  f.services.remove = async () => { throw new Error('I/O failure'); };
  await assert.rejects(f.forget.tick(true), /I\/O/); assert.ok(f.sessions.has('retry'));
  assert.ok(f.store.setting('forgetRecords').retry);
  f.store.configure({ forgetEnabled: false }); f.services.remove = remove;
  await f.forget.tick(true); assert.ok(f.sessions.has('retry'));
  f.store.configure({ forgetEnabled: true }); await f.forget.tick(true); assert.ok(!f.sessions.has('retry'));
  f.add('master-off'); f.store.configure({ enabled: false });
  await f.forget.tick(true); assert.ok(!f.archived.has('master-off'));
  assert.ok(f.forget.protected('master-off'));
});

test('schedule survives restart and config validates atomically', async t => {
  const f = fixture(t); f.store.configure({ forgetEnabled: true }); f.add('scheduled');
  await f.forget.tick(); assert.ok(f.archived.has('scheduled'));
  f.add('later'); await f.forget.tick(); assert.ok(!f.archived.has('later'));
  f.advance(DAY); await f.forget.tick(); assert.ok(f.archived.has('later'));
  for (const value of [0, 366, 1.5, '3']) assert.throws(() => f.store.configure({ forgetArchiveDays: value }));
  assert.throws(() => f.store.configure({ forgetEnabled: false, forgetTime: '25:00' }));
  assert.equal(f.store.config().forgetEnabled, true);
  assert.throws(() => f.store.configure({ forgetEnabled: false, forgetScope: 'anything' }));
  assert.equal(f.store.config().forgetEnabled, true);
});

test('automation scope protects ordinary chats, title matches and manual followups', async t => {
  const f = fixture(t);
  f.store.db.prepare('DELETE FROM metadata WHERE key=?').run('forgetScope');
  assert.equal(f.store.config().forgetScope, 'automation');
  f.store.configure({ forgetEnabled: true });
  for (const id of ['normal', 'title-only', 'schedule', 'bili', 'followup', 'unknown', 'attachment']) f.add(id);
  f.sessions.get('title-only').meta.title = '自动化 B站任务';
  for (const id of ['schedule', 'unknown', 'attachment']) f.sessions.get(id).events[0].data.source.kind = 'schedule';
  f.sessions.get('unknown').events.push({ type: 'user/message', data: { source: { kind: 'other-plugin' }, content: [] } });
  f.sessions.get('attachment').events[0].data.content.push({ type: 'image', url: 'keep' });
  for (const id of ['bili', 'followup']) {
    const s = f.sessions.get(id);
    s.meta.cwd = '/root/.dsh/bili-duty';
    s.events[0].data.content[0].text = '你是这个账号的 B站 助手。测试任务';
    f.store.setSetting('reviewCursor:' + id, { seq: 0, offset: 1000 });
  }
  f.sessions.get('followup').events.push({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续聊聊' }] } });
  await f.forget.tick(true);
  assert.deepEqual(new Set(f.archived), new Set(['schedule', 'bili']));
  f.advance(2 * DAY); await f.forget.tick(true);
  assert.deepEqual(new Set(f.sessions.keys()), new Set(['normal', 'title-only', 'followup', 'unknown', 'attachment']));
});

test('scope narrowing protects an already archived ordinary chat and in-flight removal', async t => {
  const f = fixture(t); f.add('normal'); f.store.configure({ forgetEnabled: true });
  await f.forget.tick(true); assert.ok(f.archived.has('normal'));
  f.advance(2 * DAY); f.store.configure({ forgetScope: 'automation' });
  await f.forget.tick(true); assert.ok(f.sessions.has('normal'));
  f.store.configure({ forgetScope: 'all' });
  f.services.remove = async (id, snapshot, allowed) => {
    f.store.configure({ forgetScope: 'automation' });
    assert.equal(allowed(), false);
    throw new Error('scope changed');
  };
  await assert.rejects(f.forget.tick(true), /scope changed/);
  assert.ok(f.sessions.has('normal'));
});

test('automation classification requires provenance and never just a workspace or title', () => {
  const message = kind => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text: '你是这个账号的 B站 助手。测试' }] } });
  assert.equal(isAutomationSession({ meta: { cwd: '/root/1' }, events: [message('user')] }), false);
  assert.equal(isAutomationSession({ meta: { cwd: '/root/.dsh/bili-duty' }, events: [] }), false);
  assert.equal(isAutomationSession({ events: [message('schedule'), message('user')] }), false);
  assert.equal(isAutomationSession({ events: [message('schedule'), message('runtime-context')] }), true);
});

test('trash retry obeys a narrowed scope and only deletes previously authorized automation', async t => {
  const { dir, store } = fixture(t); store.configure({ forgetEnabled: true });
  const trash = join(dir, 'forget-trash'); mkdirSync(trash);
  const ordinary = join(trash, '00000000-0000-0000-0000-000000000001');
  const automated = join(trash, '00000000-0000-0000-0000-000000000002');
  mkdirSync(ordinary); mkdirSync(automated);
  store.setSetting('forgetTrash', [{ path: ordinary, id: 'ordinary', moved: true }, { path: automated, id: 'auto', moved: true, automation: true }]);
  store.configure({ forgetScope: 'automation' });
  const removal = sessionRemoval({ sessionPersistence: { name: 'session-persistence-jsonl', root: dir, locate() {}, open() {} }, workspaceRegistry: { async unarchiveSession() {} } }, store, dir);
  await removal.sweep(); assert.ok(existsSync(ordinary)); assert.ok(!existsSync(automated));
  assert.equal(store.setting('forgetTrash').length, 1);
  store.configure({ forgetScope: 'all' }); await removal.sweep();
  assert.ok(!existsSync(ordinary)); assert.deepEqual(store.setting('forgetTrash'), []);
});

test('file removal takes a write lease and removes only the selected session directory', async t => {
  const { dir, store } = fixture(t);
  store.configure({ forgetEnabled: true });
  const root = join(dir, 'sessions'), source = join(root, 'project', 'session-a'), other = join(root, 'project', 'session-b');
  mkdirSync(source, { recursive: true }); mkdirSync(other); writeFileSync(join(source, 'session.v4.jsonl'), 'test'); writeFileSync(join(other, 'keep'), 'keep');
  const snapshot = { meta: { id: 'a', cwd: '/root/a' }, events: [] }; let closed = false, unarchived = false, loaded = false;
  const scope = { agents: { get: () => loaded ? {} : undefined }, workspaceRegistry: { async unarchiveSession() { unarchived = true; } }, sessionPersistence: {
    name: 'session-persistence-jsonl', root, locate: () => ({ path: join(source, 'session.v4.jsonl') }),
    async open(id, mode) { assert.equal(mode, 'write'); return { header: snapshot.meta, read: async () => ({ events: [] }), async close() { closed = true; } }; }
  } };
  const removal = sessionRemoval(scope, store, dir);
  loaded = true; await assert.rejects(removal.remove('a', snapshot, () => true), /使用/);
  loaded = false; await assert.rejects(removal.remove('a', { ...snapshot, events: [1] }, () => true), /变化/);
  assert.ok(existsSync(source));
  await removal.remove('a', snapshot, () => true);
  assert.equal(closed, true); assert.equal(unarchived, true);
  assert.ok(!existsSync(source)); assert.ok(existsSync(join(other, 'keep')));
  assert.deepEqual(store.setting('forgetTrash'), []);
});

test('deletion rejects paths outside the persistence root and cancels a concurrent restore', async t => {
  const { dir, store } = fixture(t); store.configure({ forgetEnabled: true });
  const root = join(dir, 'sessions'), source = join(root, 'project', 'session');
  mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'log'), 'keep');
  const snapshot = { meta: { id: 'a' }, events: [] };
  let path = join(dir, 'outside', 'log'); mkdirSync(join(dir, 'outside')); writeFileSync(path, 'private');
  const scope = { workspaceRegistry: { async unarchiveSession() {} }, sessionPersistence: {
    name: 'session-persistence-jsonl', root, locate: () => ({ path }),
    async open() { return { header: snapshot.meta, read: async () => ({ events: [] }), async close() {} }; }
  } };
  const removal = sessionRemoval(scope, store, dir);
  await assert.rejects(removal.remove('a', snapshot, () => true), /安全范围/);
  assert.ok(existsSync(path));
  path = join(source, 'log'); let checks = 0;
  await assert.rejects(removal.remove('a', snapshot, () => ++checks < 3), /已恢复/);
  assert.ok(existsSync(path)); assert.deepEqual(store.setting('forgetTrash'), []);
});
