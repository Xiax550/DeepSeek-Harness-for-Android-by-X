import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const token = process.env.DHA_TEST_BRIDGE_TOKEN;
if (!token) throw new Error('Device bridge credential required');
const evidence = { at: new Date().toISOString(), checks: [] };
async function api(body) {
  const response = await fetch('http://127.0.0.1:13080/dha-memory', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  assert.ok(response.ok && result.ok, result.error);
  return result;
}
const check = text => { evidence.checks.push(text); console.log('PASS:', text); };
const original = await api({ action: 'list' });
assert.equal(original.review.available, true);
assert.equal(original.review.running, false);
assert.equal(original.reviewCleanup, false);
check('Real handset registered session, archive and model services; cleanup defaults off');
evidence.before = { count: original.count, totalCount: original.totalCount };
try {
  const configured = await api({ action: 'configure', config: { reviewTime: '22:35', reviewTimeZone: 'Asia/Shanghai', reviewRetentionDays: 14, reviewCompact: false } });
  assert.equal(configured.reviewTime, '22:35'); assert.equal(configured.reviewRetentionDays, 14);
  check('Real API saves phone time zone, daily time and retention settings');
  await api({ action: 'review', maxCalls: 1 });
  const deadline = Date.now() + 180000;
  let finished;
  while (Date.now() < deadline) {
    const current = await api({ action: 'list' });
    if (!current.review.running) { finished = current; break; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.ok(finished, 'Model review completed before deadline');
  evidence.review = finished.review;
  assert.ok(finished.review.slot, finished.review.message);
  assert.equal(finished.review.calls, 1);
  assert.equal(finished.review.cleaned, 0);
  assert.ok(finished.totalCount >= original.totalCount);
  check('A real default-model review completed, saved its checkpoint, and retained original memories and sessions');
  evidence.after = { count: finished.count, totalCount: finished.totalCount };
} finally {
  await api({ action: 'configure', config: { reviewTime: original.reviewTime, reviewTimeZone: 'Asia/Shanghai', reviewRetentionDays: original.reviewRetentionDays, reviewCompact: original.reviewCompact, reviewEnabled: original.reviewEnabled, reviewCleanup: original.reviewCleanup } });
  writeFileSync(new URL('../build/dha-memory-review-device-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2));
}
