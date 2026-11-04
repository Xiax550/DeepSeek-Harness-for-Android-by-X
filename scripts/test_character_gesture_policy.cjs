const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const window = {};
vm.runInNewContext(fs.readFileSync('payload/opt/dsh/android/ball-web/reference/gesture-policy.js', 'utf8'), { window });
const policy = window.DHA_GESTURE_POLICY;
const counts = {};
for (let i = 0; i < 10000; i++) {
  const kind = policy.pick((i + .5) / 10000);
  counts[kind] = (counts[kind] || 0) + 1;
}
assert.equal(counts.stretch, 1500);
for (const kind of ['earTwitch', 'nod', 'tilt', 'wave']) assert.equal(counts[kind], 2125);
assert.equal(policy.pick(.15), 'earTwitch');
assert.equal(policy.pick(1), 'wave');
assert.equal(policy.kinds.includes('sideLook'), false);
assert.equal(Object.keys(counts).length, 5);
assert.equal(policy.wakeStretchProbability, .2);
assert.equal(Array.from({ length: 10000 }, (_, i) => policy.shouldWakeStretch((i + .5) / 10000)).filter(Boolean).length, 2000);
assert.equal(policy.shouldWakeStretch(.199999), true);
assert.equal(policy.shouldWakeStretch(.2), false);
assert.equal(policy.shouldWakeStretch(1), false);
console.log(JSON.stringify({ passed: true, counts }));
