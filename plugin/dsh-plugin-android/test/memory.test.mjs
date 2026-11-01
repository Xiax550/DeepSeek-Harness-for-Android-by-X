import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { MemoryStore } from '../lib/memory-store.js';
import { migrateLegacyMemory } from '../lib/memory-migration.js';
import { installMemory } from '../lib/memory.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dha-memory-test-'));
  const store = new MemoryStore(join(dir, 'memory.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('Chinese retrieval, deduplication, bounded context and workspace isolation', t => {
  const { store } = fixture(t);
  const row = store.put({ content: '用户使用小米手机，喜欢中文回答', level: 'user', keywords: ['小米手机', '中文回答'] }, '/root/a');
  assert.equal(store.put({ content: row.content, level: 'user' }, '/root/a').id, row.id);
  store.put({ content: '另一个项目的私密信息' }, '/root/b');
  assert.equal(store.search('小米手机', '/root/a')[0].id, row.id);
  assert.equal(store.search('私密信息', '/root/a').length, 0);
  assert.throws(() => store.update(row.id, { content: '越界修改' }, '/root/b'));
  assert.throws(() => store.remove(row.id, '/root/b'));
  store.put({ content: '共同偏好', level: 'user' }, '*');
  assert.match(store.context('小米手机', '/root/a'), /共同偏好/);
  assert.ok(store.context('小米手机', '/root/a', 90).length <= 90);
  store.update(row.id, { content: '用户更换了手机', status: 'archived' }, '/root/a');
  assert.equal(store.search('小米手机', '/root/a').length, 0);
  assert.equal(store.list({ status: 'all' }).length, 3);
  assert.throws(() => store.put({ content: ' ' }, '/root/a'));
  assert.throws(() => store.configure({ enabled: 'false' }));
  store.configure({ enabled: false, autoRecall: false });
  assert.equal(store.config().enabled, false);
  assert.equal(store.config().autoRecall, false);
  assert.equal(store.config().reviewEnabled, false);
  assert.equal(store.config().reviewCleanup, false);
});

test('manual scope edits persist without losing identity or bypassing workspace tool boundaries', t => {
  const { dir, store } = fixture(t);
  const row = store.put({ content: '作用域验证', project: '分类项目', keywords: ['验证'], importance: 4 }, '/root/a', 'original');
  store.db.prepare('UPDATE memories SET extra=? WHERE id=?').run('{"original":"保留"}', row.id);
  store.update(row.id, { workspace: '*' });
  assert.equal(store.get(row.id).workspace, '*');
  assert.ok(store.search('作用域验证', '/root/b').some(item => item.id === row.id));
  store.update(row.id, { workspace: ' /root/b/../b ' });
  const moved = store.get(row.id);
  assert.equal(moved.workspace, resolve('/root/b'));
  for (const key of ['id', 'created_at', 'source', 'content', 'project', 'importance', 'keywords']) assert.deepEqual(moved[key], row[key]);
  assert.deepEqual(moved.extra, { original: '保留' });
  assert.equal(store.search('作用域验证', '/root/a').length, 0);
  for (const workspace of ['', 'relative', null, 4, 'bad\0path']) {
    assert.throws(() => store.update(row.id, { workspace }));
    assert.equal(store.get(row.id).workspace, moved.workspace);
  }
  assert.throws(() => store.update(row.id, { workspace: '*' }, '/root/b'));
  assert.throws(() => store.update(row.id, { workspace: '*' }, '/root/a'));
  assert.throws(() => store.put({ content: '越界', workspace: '*' }, '/root/a'));
  assert.equal(store.update(row.id, { project: '新分类' }).workspace, moved.workspace);
  const reopened = new MemoryStore(join(dir, 'memory.db'));
  try { assert.equal(reopened.get(row.id).workspace, moved.workspace); } finally { reopened.close(); }
});

test('legacy import preserves original fields and is not resurrected after deletion', t => {
  const { dir, store } = fixture(t);
  const sourceFile = join(dir, 'legacy.db');
  const source = new DatabaseSync(sourceFile);
  source.exec("CREATE TABLE user (id TEXT, content TEXT, keywords TEXT, status TEXT, importance INTEGER, created_at INTEGER, updated_at INTEGER, custom_field TEXT)");
  source.prepare('INSERT INTO user VALUES (?,?,?,?,?,?,?,?)').run('legacy-id', '用户要求只用中文', '["中文"]', 'active', 3, 123, 456, 'keep-me');
  source.close();
  const before = readFileSync(sourceFile);
  assert.equal(store.importMeow('/root/a', sourceFile).imported, 1);
  const row = store.list()[0];
  assert.equal(row.extra.custom_field, 'keep-me');
  assert.equal(row.created_at, 123);
  assert.equal(row.updated_at, 456);
  assert.equal(row.source, 'meow-memory');
  store.remove(row.id);
  assert.equal(store.importMeow('/root/a', sourceFile).skipped, true);
  assert.equal(store.summary().count, 0);
  assert.deepEqual(readFileSync(sourceFile), before);
});

test('migration only changes the legacy bundle and keeps original databases and other plugins', t => {
  const { dir } = fixture(t);
  const home = join(dir, 'home');
  const ws = join(home, 'work');
  mkdirSync(join(ws, '.dsh-meow'), { recursive: true });
  const source = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'));
  source.exec("CREATE TABLE fact (id TEXT,content TEXT); INSERT INTO fact VALUES ('1','已有事实')"); source.close();
  const profile = join(home, '.dsh', 'profiles', 'web', 'package.json');
  mkdirSync(join(home, '.dsh', 'profiles', 'web'), { recursive: true });
  writeFileSync(profile, JSON.stringify({ dependencies: { 'meow-memory': '0.32.1', other: '2' }, dsh: { profile: { bundles: ['other', 'meow-memory'] } } }));
  const patch = join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  writeFileSync(patch, '- id: meow-memory\n  name: meow-memory\n  config:\n    promptLang: zh\n- id: other\n  config:\n    value: !!js x => x + 1\n');
  let yaml;
  try { yaml = createRequire(import.meta.url)('js-yaml'); }
  catch { yaml = createRequire(new URL('../../../payload/home/.dsh/profiles/web/package.json', import.meta.url))('js-yaml'); }
  const report = migrateLegacyMemory(home, yaml);
  assert.equal(report.sources[0].imported, 1);
  assert.deepEqual(JSON.parse(readFileSync(profile)).dsh.profile.bundles, ['other']);
  assert.equal(JSON.parse(readFileSync(profile)).dependencies['meow-memory'], '0.32.1');
  assert.ok(existsSync(profile + '.before-dha-memory'));
  assert.ok(existsSync(join(ws, '.dsh-meow', 'memory.db')));
  assert.ok(!readFileSync(patch, 'utf8').includes('meow-memory'));
  assert.match(readFileSync(patch, 'utf8'), /js.*x => x \+ 1/);
  assert.deepEqual(migrateLegacyMemory(home), report);
});

test('failed legacy migration does not disable original plugin', t => {
  const { dir } = fixture(t);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'work', '.dsh-meow'), { recursive: true });
  writeFileSync(join(home, 'work', '.dsh-meow', 'memory.db'), 'invalid database');
  mkdirSync(join(home, '.dsh', 'profiles', 'web'), { recursive: true });
  const profile = join(home, '.dsh', 'profiles', 'web', 'package.json');
  const original = JSON.stringify({ dsh: { profile: { bundles: ['meow-memory'] } } });
  writeFileSync(profile, original);
  assert.throws(() => migrateLegacyMemory(home));
  assert.equal(readFileSync(profile, 'utf8'), original);
  assert.ok(!existsSync(join(home, '.dsh', 'dha-memory', 'migration-v1.json')));
});

test('host hooks recall, respect switches, preserve image inputs and authenticate API', async t => {
  const { dir } = fixture(t);
  const oldHome = process.env.HOME, oldToken = process.env.DSH_ANDROID_BRIDGE_TOKEN;
  process.env.HOME = dir; process.env.DSH_ANDROID_BRIDGE_TOKEN = 'memory-test-secret';
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldToken === undefined) delete process.env.DSH_ANDROID_BRIDGE_TOKEN; else process.env.DSH_ANDROID_BRIDGE_TOKEN = oldToken; });
  const hooks = new Map(), tools = new Map(); let route;
  installMemory({ inject(names, fn) { fn({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, webServer: { register: value => { route = value; } } }); }, on(name, fn) { hooks.set(name, fn); } });
  const exec = { agent: { session: { header: { cwd: '/root/test' } } } };
  const saved = await tools.get('dha_memory_remember').execute({ content: '用户喜欢中文回复', level: 'user' }, exec);
  const user = { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }, { type: 'image', url: 'attachment' }] };
  const decision = { kind: 'enter', messages: [user] };
  const hook = hooks.get('agent/pre-step');
  const recalled = await hook(exec, async () => decision);
  assert.equal(recalled.messages.length, 2);
  assert.equal(recalled.messages[1], user);
  assert.match(recalled.messages[0].content[0].text, /中文回复/);
  assert.equal((await hook(exec, async () => recalled)).messages.length, 2);
  const next = await hook(exec, async () => ({ kind: 'enter', messages: [...recalled.messages, { ...user, id: 'u2' }] }));
  assert.equal(next.messages.filter(m => m.source.kind === 'plugin:dha-memory').length, 1);
  const request = async (body, authenticated = true) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = Readable.from([bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8)]);
    req.method = 'POST'; req.headers = authenticated ? { 'x-dsh-token': 'memory-test-secret' } : {};
    return await new Promise(resolveReply => route.handler(req, { writeHead(code) { this.code = code; }, end(value) { resolveReply({ code: this.code, data: JSON.parse(value) }); } }));
  };
  assert.equal((await request({ action: 'list' }, false)).code, 403);
  assert.equal((await request({ action: 'list', query: '中文' })).data.memories.length, 1);
  const moved = await request({ action: 'save', id: saved.memory.id, memory: { workspace: '*' } });
  assert.equal(moved.data.result.workspace, '*');
  assert.equal((await request({ action: 'list' })).data.memories[0].workspace, '*');
  const invalid = await request({ action: 'save', id: saved.memory.id, memory: { workspace: 'relative' } });
  assert.equal(invalid.code, 400);
  await request({ action: 'save', id: saved.memory.id, memory: { workspace: '/root/test' } });
  const global = await request({ action: 'save', workspace: '/root/test', memory: { content: '新增全局验证', workspace: '*' } });
  assert.equal(global.data.result.workspace, '*');
  await request({ action: 'delete', id: global.data.result.id });
  assert.equal((await request({ action: 'configure', config: { enabled: false } })).data.enabled, false);
  assert.equal(await hook(exec, async () => decision), decision);
  await assert.rejects(() => tools.get('dha_memory_search').execute({ query: '中文' }, exec));
  await request({ action: 'configure', config: { enabled: true } });
  await tools.get('dha_memory_forget').execute({ id: saved.memory.id }, exec);
  assert.equal((await request({ action: 'list' })).data.count, 0);
  hooks.get('dispose')();
});
