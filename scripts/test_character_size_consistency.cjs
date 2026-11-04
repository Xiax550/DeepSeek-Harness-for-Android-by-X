const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  const results = [], errors = [];
  try {
    for (const fallback of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
      page.on('pageerror', error => errors.push(error.message));
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          return /^webgl/.test(kind) ? null : get.call(this, kind, ...args);
        };
      });
      await page.goto(base + 'ball-web/composer.html');
      await page.locator('#bar.figure-ready').waitFor();
      const measurements = await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        const rig = await SkeletalCharacter.create(new URL('./reference/', location.href));
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const copy = document.createElement('canvas'); copy.width = copy.height = 768;
        const ctx = copy.getContext('2d'), rows = [];
        document.body.innerHTML = '<main style="display:flex;flex-wrap:wrap;width:1024px;background:#e8edf2"></main>';
        document.body.style.cssText = 'height:auto;min-height:100vh;overflow:auto;background:#e8edf2';
        document.documentElement.style.cssText = 'height:auto;overflow:auto';
        function frame(label, options) {
          rig.draw(root, null, { t: 0, expression: 'neutral', ...options });
          ctx.clearRect(0, 0, 768, 768);
          for (const canvas of root.querySelectorAll('canvas')) {
            ctx.globalAlpha = Number(canvas.style.opacity || 1); ctx.drawImage(canvas, 0, 0);
          }
          ctx.globalAlpha = 1;
          const rgba = ctx.getImageData(0, 0, 768, 768).data;
          let top = 768, bottom = -1, crown = 768, left = 768, right = -1;
          for (let y = 0; y < 768; y++) for (let x = 0; x < 768; x++) {
            if (rgba[(y * 768 + x) * 4 + 3] <= 128) continue;
            top = Math.min(top, y); bottom = Math.max(bottom, y);
            left = Math.min(left, x); right = Math.max(right, x);
            if (x >= Math.round(768 * .31) && x < Math.round(768 * .69)) crown = Math.min(crown, y);
          }
          const item = { label, top, bottom, left, right, height: bottom + 1 - crown };
          rows.push(item);
          const tile = document.createElement('div'), image = new Image();
          tile.style.cssText = 'width:256px;text-align:center;font:13px sans-serif';
          image.src = copy.toDataURL(); image.width = image.height = 256;
          tile.append(image, label + ' height=' + item.height); document.querySelector('main').append(tile);
          return item;
        }
        frame('standing', {});
        for (const progress of [.88, .9, .93, .95, .97, .99])
          frame('wake-' + progress, { wholeBodyWake: progress, recoveringFromProne: true });
        for (const progress of [.1, .25, .4, .55, .7, .85, .95])
          frame('stretch-' + progress, { gesture: { kind: 'stretch', k: progress } });
        frame('standing-after', {});
        rig.dispose(); return rows;
      });
      const stand = measurements[0];
      for (const row of measurements) {
        assert.ok(Math.abs(row.height - stand.height) <= 8, 'upright size differs: ' + JSON.stringify(row));
        assert.ok(Math.abs(row.bottom - stand.bottom) <= 6, 'ground line differs: ' + JSON.stringify(row));
        assert.ok(row.left > 0 && row.right < 767 && row.top > 0 && row.bottom < 767, 'character clipped');
      }
      assert.deepEqual(measurements.at(-1), { ...stand, label: 'standing-after' }, 'animation must not alter standing size');
      await page.screenshot({ path: 'build/character-size-' + (fallback ? 'canvas' : 'webgl') + '.png', fullPage: true });
      results.push({ fallback, measurements });
      await page.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync('build/character-size-results.json', JSON.stringify({ passed: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, renderers: results.length, frames: results[0].measurements.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
