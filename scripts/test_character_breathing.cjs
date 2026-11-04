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
      const page = await browser.newPage();
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return /^webgl/.test(type) ? null : get.call(this, type, ...args);
        };
      });
      await page.clock.install();
      await page.goto(base + 'ball-web/composer.html?preview=300');
      await page.locator('#bar.figure-ready').waitFor();
      await page.evaluate(() => BallUI.idleStage(3));
      await page.clock.runFor(6000);
      const before = await page.evaluate(() => BallUI.restInfo());
      await page.clock.runFor(4800);
      const after = await page.evaluate(() => BallUI.restInfo());
      assert.ok(after.animationTime - before.animationTime > 4.5, 'resting clock must not slow to 1/20 speed');
      assert.ok(after.frames - before.frames < 49, 'sleep remains capped at 10 Hz');
      const metrics = await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        const rig = await ReferenceCharacter.create(new URL('./reference/', location.href));
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const options = { sit: 1, sleep: 1, expression: 'neutral' };
        function frame(t, reducedMotion = false) {
          rig.draw(root, null, { ...options, t, reducedMotion });
          const copy = document.createElement('canvas'); copy.width = copy.height = 768;
          const ctx = copy.getContext('2d'); ctx.drawImage(root.querySelector('canvas'), 0, 0);
          return { pixels: ctx.getImageData(0, 0, 768, 768).data, url: copy.toDataURL() };
        }
        function difference(a, b, box) {
          let delta = 0, count = 0;
          for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
            const p = (y * 768 + x) * 4;
            for (let c = 0; c < 4; c++) { delta += Math.abs(a[p+c] - b[p+c]); count++; }
          }
          return delta / count;
        }
        const a = frame(0), b = frame(2.4), cycle = frame(4.8);
        const reducedA = frame(0, true), reducedB = frame(2.4, true);
        const result = {
          renderer: rig.info().renderer,
          chest: difference(a.pixels, b.pixels, [440, 430, 600, 650]),
          face: difference(a.pixels, b.pixels, [210, 635, 320, 705]),
          floor: difference(a.pixels, b.pixels, [80, 752, 690, 768]),
          loop: difference(a.pixels, cycle.pixels, [0, 0, 768, 768]),
          reduced: difference(reducedA.pixels, reducedB.pixels, [0, 0, 768, 768]),
          frames: [a.url, b.url]
        };
        rig.dispose(); return result;
      });
      const prefix = fallback ? 'canvas' : 'webgl';
      metrics.frames.forEach((url, i) => fs.writeFileSync('build/sleep-breath-' + prefix + '-' + i + '.png', Buffer.from(url.split(',')[1], 'base64')));
      delete metrics.frames;
      assert.ok(metrics.chest > .05, 'rendered chest must actually move');
      assert.ok(metrics.face < .05, 'head rests on hands instead of bobbing with the chest');
      assert.ok(metrics.floor < .01, 'floor contact must remain fixed');
      assert.ok(metrics.loop < .01, 'breathing loop must join without a jump');
      assert.equal(metrics.reduced, 0, 'reduced motion disables breathing');
      const paused = await page.evaluate(() => BallUI.restInfo().frames);
      await page.clock.runFor(5000);
      assert.equal(await page.evaluate(() => BallUI.restInfo().frames), paused, 'hidden page stops all rendering');
      results.push(metrics); await page.close();
    }
    fs.writeFileSync('build/character-breathing-results.json', JSON.stringify({ passed: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
