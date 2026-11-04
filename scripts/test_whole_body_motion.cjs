const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  const errors = [], results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1050 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + 'ball-web/composer.html');
    await page.locator('#bar.figure-ready').waitFor();
    const metrics = await page.evaluate(async () => {
      dispatchEvent(new Event('pagehide'));
      const rig = await SkeletalCharacter.create(new URL('./reference/', location.href));
      const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      document.body.innerHTML = '<main style="display:flex;flex-wrap:wrap;background:#e4e9ef"></main>';
      const main = document.querySelector('main'), rows = [];
      for (const [clip, progress] of [['wake', .001], ['wake', .2], ['wake', .44], ['wake', .6],
        ['wake', .75], ['wake', .999], ['stretch', .35], ['stretch', .6],
        ['sit', .25], ['sit', .65], ['lie', .3], ['lie', .7]]) {
        const options = clip === 'wake' ? { wholeBodyWake: progress, recoveringFromProne: true }
          : clip === 'sit' ? { sit: progress } : clip === 'lie' ? { sit: 1, sleep: progress }
            : { gesture: { kind: 'stretch', k: progress } };
        rig.draw(root, null, options);
        const info = rig.info(), canvas = root.querySelectorAll('canvas')[1];
        const data = canvas.getContext('2d').getImageData(0, 0, 768, 768).data;
        let opaque = 0, green = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i+3] > 200) {
          opaque++; if (data[i+1] > Math.max(data[i], data[i+2]) + 45) green++;
        }
        rows.push({ clip, progress, motion: info.wholeBodyMotion, opaque, green });
        const tile = document.createElement('div'), img = new Image();
        tile.style.cssText = 'width:250px;font:14px sans-serif;text-align:center';
        img.src = canvas.toDataURL(); img.width = img.height = 250;
        tile.append(img, clip + ' ' + progress); main.append(tile);
      }
      // Timeline selection must be monotonic and clamp all out-of-range input.
      for (const clip of Object.values(DHA_WHOLE_MOTION.clips)) {
        let previous = -1;
        for (let i = 0; i <= 1000; i++) {
          const current = WholeBodyMotion.frameAt(clip, i / 1000);
          if (current < previous || current >= clip.frames) throw Error('Invalid frame timeline');
          previous = current;
        }
        if (WholeBodyMotion.frameAt(clip, -1) !== (clip.firstFrame || 0) || WholeBodyMotion.frameAt(clip, 2) !== clip.frames - 1)
          throw Error('Frame clamping failed');
      }
      rig.draw(root, null, { wholeBodyWake: .5, reducedMotion: true });
      if (rig.info().wholeBodyMotion !== null) throw Error('Reduced motion must bypass clips');
      rig.draw(root, null, {});
      if (rig.info().wholeBodyMotion !== null) throw Error('Completed motion must release timeline');
      rig.dispose(); rig.dispose(); return rows;
    });
    for (const row of metrics) {
      assert.equal(row.motion.clip, row.clip);
      assert.ok(row.opaque > 18000, 'Frame must contain complete visible character');
      assert.equal(row.green, 0, 'Opaque green screen must be removed');
    }
    results.push(...metrics);
    await page.screenshot({ path: 'build/whole-body-motion-grid.png', fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync('build/whole-body-motion-results.json', JSON.stringify({ passed: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: metrics.length, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
