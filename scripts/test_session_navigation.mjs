import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { repairSessionSource, repair } from '../payload/opt/dsh/android/repair-session-navigation.mjs';

const modules = new URL('../_ref/dshsrc/dshsrc/node_modules/', import.meta.url);
const original = readFileSync(new URL('@deepseek-ai/dsh-client-ui-session/lib/client.js', modules), 'utf8');
const controller = readFileSync(new URL('@deepseek-ai/dsh-api-session-controller/lib/client.js', modules), 'utf8');
const referenceCode = controller.slice(controller.indexOf('var ClientSessionReference = class'), controller.indexOf('var ClientSessions = class'));
const ClientReference = vm.runInThisContext('(function(){' + referenceCode + ';return ClientSessionReference;})()');

function load(source) {
  let result;
  const deps = {
    '@deepseek-ai/cordis': { Service: class { constructor(ctx) { this.ctx = ctx; } } },
    '@deepseek-ai/dsh-client-store': { notifySubscribers: listeners => [...listeners].forEach(fn => fn()) },
    '@deepseek-ai/dsh-client-ui-slots': { standardHookPropName: name => 'use' + name[0].toUpperCase() + name.slice(1) },
    'react/jsx-runtime': {}
  };
  vm.runInThisContext('(function(window){' + source.replace('exports.apply = apply;', 'exports.UiSession = UiSession; exports.apply = apply;') + '\n})')({
    __ModuleLoader__: { load({ factory }) { result = factory(id => { assert.ok(id in deps, id); return deps[id]; }); } }
  });
  return result.UiSession;
}
function harness(UiSession) {
  const bindings = new Map();
  const rows = {};
  const ctx = { effect: () => () => {}, slots: { bindStoreScope() {} } };
  const sessions = { binding: id => bindings.get(id), list: { getSnapshot: () => ({ byId: rows, ids: Object.keys(rows), phase: 'ready' }) },
    retainInfo: () => ({ getSnapshot: () => ({ retainedBy: {} }), subscribe: () => () => {} }) };
  const ui = new UiSession(ctx, sessions);
  function open(id) {
    const owner = { sessionId: id, ctx, session: { projections: { faceOf: () => ({}) } } };
    bindings.set(id, owner);
    const record = { live: true, binding: owner };
    return new ClientReference(id, record, () => { record.live = false; if (bindings.get(id) === owner) bindings.delete(id); });
  }
  return { ui, open, bindings };
}

const baseline = harness(load(original));
const before = baseline.open('old');
baseline.ui.bindingSource(before);
before.release();
assert.throws(() => baseline.ui.bindingSource(before), /is released/, 'reproduce old-session redraw crash on original code');

const patched = repairSessionSource(original);
assert.equal(repairSessionSource(patched), patched, 'patch is idempotent');
assert.throws(() => repairSessionSource('unrecognized upstream'), /Unsupported/);
const fixed = harness(load(patched));
let previous;
for (let i = 0; i < 100; i++) {
  const current = fixed.open('chat-' + i);
  assert.equal(fixed.ui.bindingSource(current).getSnapshot().key, 'chat-' + i);
  if (previous) {
    previous.release();
    assert.equal(fixed.ui.bindingSource(previous), fixed.ui.absent, 'retired view must safely render absence');
    assert.equal(fixed.ui.bindingSource(current).getSnapshot().key, 'chat-' + i, 'new session stays selected');
  }
  previous = current;
}
const foreign = harness(load(patched)).open('foreign');
assert.throws(() => fixed.ui.bindingSource(foreign), /not active/, 'foreign controller ownership checks remain intact');
assert.throws(() => fixed.ui.bindingSource({ get binding() { throw new Error('unrelated failure'); } }), /unrelated failure/);
const retained = fixed.open('same');
const oldOwner = retained.binding;
const replacement = fixed.open('same');
assert.notEqual(oldOwner, replacement.binding);
assert.throws(() => fixed.ui.bindingSource(retained), /not active/, 'stale but unreleased generations are not silently accepted');
retained.release();
assert.equal(fixed.ui.bindingSource(retained), fixed.ui.absent);
assert.equal(fixed.ui.bindingSource(replacement).getSnapshot().key, 'same');

const temp = mkdtempSync(join(tmpdir(), 'dha-navigation-'));
try {
  assert.equal(repair(temp), false);
  const target = join(temp, '@deepseek-ai/dsh-client-ui-session/lib/client.js');
  mkdirSync(join(temp, '@deepseek-ai/dsh-client-ui-session/lib'), { recursive: true });
  writeFileSync(target, original);
  assert.equal(repair(temp), true);
  assert.equal(readFileSync(target, 'utf8'), patched);
  assert.equal(repair(temp), false);
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log('Session navigation: original crash reproduced; 100 replacements, release fallback, ownership checks and boot repair pass.');
