const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const results = [];
    for (const fallback of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return /^webgl/.test(type) ? null : get.call(this, type, ...args);
        };
      });
      await page.goto(base + 'ball-web/composer.html?preview=54');
      await page.locator('#bar.figure-ready').waitFor();
      const metrics = await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        const rig = await SkeletalCharacter.create(new URL('./reference/', location.href));
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const copy = document.createElement('canvas'); copy.width = copy.height = 768;
        const ctx = copy.getContext('2d');
        document.body.innerHTML = '<main style="display:flex;flex-wrap:wrap;width:1200px;background:#e4e9ef"></main>';
        function frame(options) {
          rig.draw(root, null, { t: 0, expression: 'neutral', ...options });
          ctx.clearRect(0, 0, 768, 768);
          for (const canvas of root.querySelectorAll('canvas')) {
            ctx.globalAlpha = Number(canvas.style.opacity || 1); ctx.drawImage(canvas, 0, 0);
          }
          return ctx.getImageData(0, 0, 768, 768).data;
        }
        function diff(a, b, box = [0, 0, 768, 768]) {
          let delta = 0, count = 0;
          for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
            const p = (y * 768 + x) * 4;
            for (let c = 0; c < 4; c++) { delta += Math.abs(a[p + c] - b[p + c]); count++; }
          }
          return delta / count;
        }
        function capture(label) {
          const box = document.createElement('div'); box.style.cssText = 'width:150px;text-align:center;font:12px sans-serif';
          const img = new Image(); img.src = copy.toDataURL(); img.width = img.height = 150;
          box.append(img, document.createTextNode(label)); document.querySelector('main').append(box);
        }
        const normal = frame({}), gestures = [];
        for (const kind of ['wave', 'stretch', 'nod', 'tilt', 'earTwitch', 'sideLook']) {
          const begin = diff(normal, frame({ gesture: { kind, k: 0 } }));
          let changed = 0, clipped = 0;
          for (const k of [.2, .4, .6, .8]) {
            const pixels = frame({ gesture: { kind, k } });
            changed = Math.max(changed, diff(normal, pixels));
            for (let i = 0; i < 768; i++) for (const n of [i, 767 * 768 + i, i * 768, i * 768 + 767])
              if (pixels[n * 4 + 3] > 100) clipped++;
            capture(kind + ' ' + k);
          }
          const end = diff(normal, frame({ gesture: { kind, k: 1 } }));
          gestures.push({ kind, begin, end, changed, clipped });
        }
        for (const h of [0, .04, .12, .25, .4, .55, .7, .8, .9, .98, 1]) {
          frame({ sit: 1, sleep: h, expression: 'sleepy' }); capture('lower ' + h);
        }
        const a = frame({ sit: 1, sleep: 1, t: 1.2 });
        const b = frame({ sit: 1, sleep: 1, t: 3.6 });
        const breathing = { chest: diff(a, b, [440, 470, 600, 630]),
          face: diff(a, b, [180, 640, 315, 695]), floor: diff(a, b, [80, 749, 690, 758]) };
        const reducedA = frame({ sit: 1, sleep: 1, t: 1.2, reducedMotion: true });
        breathing.reduced = diff(reducedA, frame({ sit: 1, sleep: 1, t: 3.6, reducedMotion: true }));
        rig.dispose(); return { gestures, breathing };
      });
      await page.screenshot({ path: 'build/motion-contract-' + (fallback ? 'canvas' : 'webgl') + '.png', fullPage: true });
      for (const gesture of metrics.gestures) {
        assert.ok(gesture.begin < .001, gesture.kind + ' starts at the accepted standing pose (subpixel raster tolerance)');
        assert.ok(gesture.end < .001, gesture.kind + ' returns to the accepted standing pose (subpixel raster tolerance)');
        if (gesture.kind === 'sideLook') assert.ok(gesture.changed < .001, 'removed turn must leave the character facing front');
        else assert.ok(gesture.changed > .01, gesture.kind + ' must actually move');
        assert.equal(gesture.clipped, 0, gesture.kind + ' stays within the overlay');
      }
      assert.ok(metrics.breathing.chest > .01, 'sleeping chest moves in the active skeleton renderer');
      assert.ok(metrics.breathing.face < .05, 'sleeping face rests on the hands');
      assert.ok(metrics.breathing.floor < .02, 'sleeping floor contact stays fixed');
      assert.equal(metrics.breathing.reduced, 0);
      results.push({ fallback, ...metrics }); await page.close();
    }
    fs.writeFileSync('build/motion-contract-results.json', JSON.stringify({ passed: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
