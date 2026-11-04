const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const serial = process.env.DHA_DEVICE_SERIAL;
const x = Number(process.env.DHA_DOLL_X), y = Number(process.env.DHA_DOLL_Y);
if (!serial || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Require explicit serial and verified doll coordinates');
const adb = process.env.DHA_ADB || 'D:\\AndroidSdkPhoneOrb\\platform-tools\\adb.exe';
const directory = path.resolve(process.env.DHA_DEVICE_EVIDENCE);
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { maxBuffer: 32 << 20 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const logs = () => run('logcat', '-d', '-s', 'dsh:I').toString().split(/\r?\n/)
  .filter(line => /character wake:|ball idle stage:|character.*failed/.test(line));

(async () => {
  const initial = new Set(logs()), observed = new Set();
  const evidence = { serial, started: new Date().toISOString(), passed: false, frames: [] };
  run('shell', 'input', 'tap', String(x), String(y));
  const start = Date.now();
  try {
    for (const target of [0, 400, 1000, 2000, 3000, 4200, 5700, 7300, 8500, 9800, 11200, 13000, 14500, 16000]) {
      await sleep(Math.max(0, start + target - Date.now()));
      const name = 'wake-' + String(target).padStart(5, '0') + '.png';
      fs.writeFileSync(path.join(directory, name), run('exec-out', 'screencap', '-p'));
      for (const line of logs()) if (!initial.has(line)) observed.add(line);
      evidence.frames.push({ name, elapsedMs: Date.now() - start });
    }
    const text = [...observed].join('\n');
    for (const phase of ['looking', 'rising', 'stretching', 'normal']) assert.match(text, new RegExp('character wake: ' + phase));
    assert.doesNotMatch(text, /character wake: (grumpy|lifting)|character.*failed/);
    evidence.passed = true;
  } finally {
    evidence.logs = [...observed];
    evidence.finished = new Date().toISOString();
    fs.writeFileSync(path.join(directory, 'wake-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
