const { mkdirSync, symlinkSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { join, dirname } = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const staging = '/tmp/dha-three-sections-tests';
  mkdirSync(staging, { recursive: true });
  execFileSync('tar', ['-xf', '/sdcard/Download/dha-three-sections-tests.tar', '-C', staging]);
  const pkg = join(staging, 'plugin/dsh-plugin-android');
  const deps = ['/opt/dsh/package.json', '/root/.dsh/profiles/web/package.json'];
  let runtime;
  for (const file of deps) {
    try { const candidate = createRequire(file); candidate.resolve('@deepseek-ai/dsh-session-persistence-jsonl'); runtime = candidate; break; } catch {}
  }
  assert.ok(runtime, 'Runtime packages found');
  try { symlinkSync(dirname(runtime.resolve('js-yaml/package.json')).replace(/\/js-yaml$/, ''), join(pkg, 'node_modules')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  for (const test of ['memory-review', 'memory-forget', 'memory']) {
    const output = execFileSync(process.execPath, ['--test', join(pkg, 'test', test + '.test.mjs')], { encoding: 'utf8', timeout: 120000 });
    console.log(test + ': ' + output.split('\n').filter(line => /^# (tests|pass|fail) /.test(line)).join(', '));
  }
  const load = name => import(pathToFileURL(runtime.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { SESSION_FORMAT_VERSION } = await load('@deepseek-ai/dsh-session');
  const { default: Persistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl');
  const { MemoryStore } = await import(pathToFileURL(join(pkg, 'lib/memory-store.js')).href);
  const { MemoryForget } = await import(pathToFileURL(join(pkg, 'lib/memory-forget.js')).href);
  const { sessionRemoval } = await import(pathToFileURL(join(pkg, 'lib/memory-session-removal.js')).href);
  const { isAutomationSession } = await import(pathToFileURL(join(pkg, 'lib/memory-session-policy.js')).href);
  const actual = new Persistence(new Context(), { root: '/root/.dsh/sessions' });
  let bili = 0, eligible = 0;
  for (const { header } of await actual.list()) {
    if (header.cwd !== '/root/.dsh/bili-duty') continue;
    bili++;
    const handle = await actual.open(header.id, 'read');
    try { if (isAutomationSession({ meta: handle.header, events: (await handle.read()).events })) eligible++; }
    finally { await handle.close(); }
  }
  console.log(`READ ONLY actual Bili conversations: ${bili}; source classification recognized: ${eligible}; no actual conversations modified`);
  const directory = mkdtempSync('/tmp/dha-real-jsonl-forget-');
  const store = new MemoryStore(join(directory, 'memory.db'));
  const context = new Context();
  let forget;
  try {
    const persistence = new Persistence(context, { root: join(directory, 'sessions'), compression: 'none' });
    const DAY = 86400000; let now = Date.now();
    const header = { version: SESSION_FORMAT_VERSION, id: 'dha-disposable-forgetting-fixture', cwd: '/root/dha-disposable-test', createdAt: now - 3 * DAY, isSeeded: false, delegationDepth: 0 };
    const handle = await persistence.create(header); await handle.flush(); await handle.close();
    const originalFile = persistence.locate(header).path;
    assert.ok(existsSync(originalFile), 'Fixture session materialized using real persistence');
    const archives = new Set();
    const registry = { async unarchiveSession(id) { archives.delete(id); } };
    const removal = sessionRemoval({ sessionPersistence: persistence, workspaceRegistry: registry }, store, directory);
    assert.equal(typeof removal.remove, 'function');
    store.configure({ forgetEnabled: true, forgetScope: 'all' });
    forget = new MemoryForget({ store, now: () => now, services: {
      ...removal,
      async list() { return (await persistence.list()).map(({ header }) => ({ sessionId: header.id, updatedAt: header.createdAt })); },
      async inspect(id) { const read = await persistence.open(id, 'read'); try { return { meta: read.header, events: (await read.read()).events }; } finally { await read.close(); } },
      isPinned: () => false, isRunning: () => false, isArchived: id => archives.has(id), async archive(id) { archives.add(id); }
    } });
    await forget.tick(true); assert.ok(archives.has(header.id)); assert.ok(existsSync(originalFile));
    now += 2 * DAY - 1; await forget.tick(true); assert.ok(existsSync(originalFile));
    now++; await forget.tick(true);
    assert.equal(forget.status().deleted, 1, forget.status().message);
    assert.ok(!existsSync(originalFile)); assert.equal((await persistence.list()).length, 0);
    assert.equal(archives.size, 0); assert.deepEqual(store.setting('forgetTrash'), []);
    console.log('PASS real Android JSONL write lease: 3-day archive -> 2-day grace -> physical removal; archive metadata and staging cleared');
  } finally {
    await forget?.dispose(); store.close();
    // This unique, explicitly created disposable test directory contains no user files.
    rmSync(directory, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
