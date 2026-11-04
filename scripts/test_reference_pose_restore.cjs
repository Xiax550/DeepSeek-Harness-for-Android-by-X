const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  const results = [];
  try {
    for (const fallback of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 800, height: 420 } });
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          return /^webgl/.test(type) ? null : get.call(this, type, ...args);
        };
      });
      await page.goto(base + 'ball-web/composer.html');
      await page.locator('#bar.figure-ready').waitFor();
      const metrics = await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        document.body.innerHTML = '<main style="display:flex;background:#e4e9ef"></main>';
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const rig = await ReferenceCharacter.create(new URL('./reference/', location.href));
        const activePoses = ['stand-front', 'sit-front', 'sleep-front'];
        if (JSON.stringify(rig.info().views.slice().sort()) !== JSON.stringify(activePoses.slice().sort())) {
          throw new Error('Only the three approved front reference poses may load');
        }
        for (const options of [{ view: 'side' }, { gesture: { kind: 'sideLook', k: .5 } }]) {
          rig.draw(root, null, options);
          if (rig.info().view !== 'front') throw new Error('Costume profiles must never become animation poses');
        }
        const results = [];
        for (const pose of ['sit-front', 'sleep-front']) {
          const spec = REFERENCE_MODEL.views[pose];
          const img = new Image(); img.src = new URL('./reference/' + spec.file, location.href);
          await img.decode();
          const expected = document.createElement('canvas'); expected.width = expected.height = 768;
          const ctx = expected.getContext('2d');
          const w = img.width * spec.scale, h = img.height * spec.scale;
          ctx.drawImage(img, (128 - w / 2) * 3, (252 - h) * 3, w * 3, h * 3);
          rig.draw(root, null, { sit: 1, sleep: pose === 'sleep-front' ? 1 : 0, reducedMotion: true, expression: 'neutral' });
          const actual = document.createElement('canvas'); actual.width = actual.height = 768;
          const ac = actual.getContext('2d'); ac.drawImage(root.querySelector('canvas'), 0, 0);
          const a = ac.getImageData(0, 0, 768, 768).data, b = ctx.getImageData(0, 0, 768, 768).data;
          let error = 0, count = 0;
          for (let i = 0; i < a.length; i += 4) {
            if (a[i + 3] || b[i + 3]) {
              count++;
              for (let c = 0; c < 3; c++) error += Math.abs(a[i+c]*a[i+3]/255 - b[i+c]*b[i+3]/255);
              error += Math.abs(a[i+3]-b[i+3]);
            }
          }
          results.push({ pose, meanChannelError: error / (count * 4), reportedPose: rig.info().pose });
          for (const [label, canvas] of [['reference', expected], ['actual', actual]]) {
            const box = document.createElement('div'); box.style.cssText = 'width:200px;font:14px sans-serif;text-align:center';
            const preview = new Image(); preview.src = canvas.toDataURL(); preview.width = preview.height = 200;
            box.append(pose + ' ' + label, preview); document.querySelector('main').append(box);
          }
        }
        rig.dispose(); return results;
      });
      for (const m of metrics) {
        assert.equal(m.reportedPose, m.pose);
        assert.ok(m.meanChannelError < 3, 'rendered rest pose must match original artwork: ' + JSON.stringify(m));
      }
      await page.screenshot({ path: 'build/restored-poses-' + (fallback ? 'canvas' : 'webgl') + '.png' });
      results.push({ fallback, metrics }); await page.close();
    }
    fs.writeFileSync('build/restored-poses-results.json', JSON.stringify({ passed: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
