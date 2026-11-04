const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const serial = process.env.DHA_DEVICE_SERIAL;
if (!serial) throw new Error('DHA_DEVICE_SERIAL is required');
const adb = process.env.DHA_ADB || 'D:\\AndroidSdkPhoneOrb\\platform-tools\\adb.exe';
const directory = path.resolve(process.env.DHA_DEVICE_EVIDENCE || 'build/device-prone-20261103');
const x = Number(process.env.DHA_DOLL_X), y = Number(process.env.DHA_DOLL_Y);
if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Set the verified doll coordinates');
fs.mkdirSync(directory, { recursive: true });
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { maxBuffer: 32 << 20 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const logs = () => run('logcat', '-d', '-s', 'dsh:I').toString().split(/\r?\n/)
  .filter(line => /ball idle stage:|character wake:|character.*failed|character.*ready/.test(line));
const capture = name => fs.writeFileSync(path.join(directory, name + '.png'), run('exec-out', 'screencap', '-p'));
const captureErrors = [];
// Some vendor ROMs deny screenrecord output even to adb shell. Native PNG
// bursts retain reviewable evidence without changing phone permissions.
const record = async name => {
  try {
    const started = Date.now();
    for (let index = 0; index < 24; index++) {
      await sleep(Math.max(0, started + index * 1000 - Date.now()));
      capture(name + '-frame-' + String(index).padStart(2, '0'));
    }
  } catch (error) { captureErrors.push(error.message); }
};

(async () => {
  const timeout = run('shell', 'settings', 'get', 'system', 'screen_off_timeout').toString().trim();
  const initialLogs = new Set(logs());
  const observedLogs = new Set();
  const freshLogs = () => {
    for (const line of logs()) if (!initialLogs.has(line)) observedLogs.add(line);
    return [...observedLogs];
  };
  const evidence = { serial, started: new Date().toISOString(), automatedPassed: false,
    visualReview: 'pending', releaseEligible: false, frames: [], logs: [] };
  const write = () => fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  const recordings = [];
  try {
    run('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
    run('shell', 'input', 'tap', String(x), String(y)); await sleep(800);
    run('shell', 'input', 'tap', String(x), String(y)); await sleep(800);
    const started = Date.now();
    for (const second of [0, 30, 120, 300, 410, 419, 421, 424, 480, 590, 599, 602, 607, 608, 609, 610, 611, 612, 613, 614, 616]) {
      await sleep(Math.max(0, started + second * 1000 - Date.now()));
      if (second === 419) recordings.push(record('sit-down'));
      if (second === 599) recordings.push(record('drowsy-prone'));
      const name = 'idle-' + String(second).padStart(3, '0');
      capture(name);
      evidence.frames.push({ name, elapsedMs: Date.now() - started });
      evidence.logs = freshLogs();
      write(); console.log(JSON.stringify({ second, stages: evidence.logs }));
    }
    for (const stage of [1, 2, 3]) assert.match(evidence.logs.join('\n'), new RegExp('ball idle stage: ' + stage));
    recordings.push(record('wake-up'));
    run('shell', 'input', 'tap', String(x), String(y));
    const wake = Date.now();
    for (const millisecond of [0, 400, 1000, 2000, 3000, 4200, 5700, 7300, 9800, 11200, 13000, 14500, 16000]) {
      await sleep(Math.max(0, wake + millisecond - Date.now()));
      capture('wake-' + String(millisecond).padStart(5, '0'));
    }
    evidence.logs = freshLogs();
    for (const phase of ['looking', 'rising', 'stretching', 'normal']) {
      assert.match(evidence.logs.join('\n'), new RegExp('character wake: ' + phase));
    }
    assert.doesNotMatch(evidence.logs.join('\n'), /character.*failed/);
    evidence.automatedPassed = true;
  } catch (error) {
    evidence.error = error.stack; throw error;
  } finally {
    await Promise.allSettled(recordings);
    if (captureErrors.length) { evidence.automatedPassed = false; evidence.captureErrors = captureErrors; process.exitCode = 1; }
    evidence.finished = new Date().toISOString(); write();
    run('shell', 'settings', 'put', 'system', 'screen_off_timeout', timeout);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
