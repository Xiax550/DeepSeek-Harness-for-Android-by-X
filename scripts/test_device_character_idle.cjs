const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const serial = process.env.DHA_DEVICE_SERIAL;
if (!serial) throw new Error('DHA_DEVICE_SERIAL is required; never choose a phone implicitly');
const adb = process.env.DHA_ADB || 'D:\\AndroidSdkPhoneOrb\\platform-tools\\adb.exe';
const out = path.resolve(process.env.DHA_DEVICE_EVIDENCE || 'build/device-sp11');
fs.mkdirSync(out, { recursive: true });
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { maxBuffer: 24 << 20 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const capture = name => fs.writeFileSync(path.join(out, name + '.png'), run('exec-out', 'screencap', '-p'));
const stages = () => run('logcat', '-d', '-s', 'dsh:I').toString().split(/\r?\n/)
  .filter(line => /ball idle stage:|character wake:|reference character.*failed|reference-only character ready/.test(line));

(async () => {
  const timeout = run('shell', 'settings', 'get', 'system', 'screen_off_timeout').toString().trim();
  const initialStages = new Set(stages());
  const observedStages = new Set();
  const freshStages = () => {
    for (const line of stages()) if (!initialStages.has(line)) observedStages.add(line);
    return [...observedStages];
  };
  const events = [];
  try {
    run('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
    // Caller leaves the doll at this known position on the home screen, collapsed.
    run('shell', 'input', 'tap', '102', '1008');
    await sleep(700);
    run('shell', 'input', 'tap', '102', '1008');
    await sleep(700);
    const start = Date.now();
    const points = [...Array.from({ length: 46 }, (_, i) => i * 2), 120, 180, 240, 300, 360, 410, 422, 480, 540, 598, 601, 604, 609, 613];
    console.log('REAL idle wait started ' + new Date(start).toISOString());
    for (const seconds of points) {
      await sleep(Math.max(0, start + seconds * 1000 - Date.now()));
      capture('idle-' + String(seconds).padStart(3, '0'));
      const current = freshStages();
      const event = { seconds, actualMs: Date.now() - start, at: new Date().toISOString(), stages: current };
      events.push(event);
      fs.writeFileSync(path.join(out, 'idle-timeline.json'), JSON.stringify({ serial, events }, null, 2));
      if (seconds % 60 === 0 || seconds >= 410) console.log(JSON.stringify(event));
    }
    const observed = freshStages().join('\n');
    assert.match(observed, /ball idle stage: 1/, 'real seven-minute sitting boundary');
    assert.match(observed, /ball idle stage: 2/, 'real ten-minute drowsy boundary');
    assert.match(observed, /ball idle stage: 3/, 'real ten-minute-eight-second sleep boundary');
    if (process.env.DHA_CAPTURE_SLEEP_Z === '1') {
      const sharp = require('sharp');
      for (let i = 0; i < 12; i++) {
        await sharp(run('exec-out', 'screencap', '-p'))
          .extract({ left: 0, top: 907, width: 220, height: 204 })
          .resize(440, 408).png().toFile(path.join(out, 'zzz-' + String(i).padStart(2, '0') + '.png'));
        await sleep(220);
      }
    }
    run('shell', 'input', 'tap', '102', '1008');
    if (process.env.DHA_CAPTURE_WAKE === '1') {
      const start = Date.now(), wakeFrames = [];
      for (const time of [0, 1000, 2200, 3400, 4600, 5800, 7000, 8200, 9400, 10600]) {
        await sleep(Math.max(0, start + time - Date.now()));
        const beforeCaptureMs = Date.now() - start;
        capture('wake-' + String(time).padStart(5, '0'));
        wakeFrames.push({ targetMs: time, beforeCaptureMs, afterCaptureMs: Date.now() - start });
        freshStages();
      }
      const phases = freshStages();
      fs.writeFileSync(path.join(out, 'wake-timeline.json'), JSON.stringify({ serial, frames: wakeFrames, phases }, null, 2));
      const wakeLogs = phases.join('\n');
      for (const phase of ['grumpy', 'lifting', 'rising', 'stretching', 'normal']) {
        assert.match(wakeLogs, new RegExp('character wake: ' + phase), phase + ' occurs on the real phone');
      }
      console.log('PASS native click wake sequence: grumpy/lifting/rising/stretching/normal');
    } else await sleep(4000);
    capture('wake-click');
    assert.match(freshStages().join('\n'), /ball idle stage: 0/, 'tap wakes native policy');
    console.log('PASS native real-time sit/drowsy/sleep/click wake; inspect PNGs for appearance');
  } finally {
    run('shell', 'settings', 'put', 'system', 'screen_off_timeout', timeout);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
