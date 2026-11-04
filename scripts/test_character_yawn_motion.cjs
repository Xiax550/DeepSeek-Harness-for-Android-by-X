const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  });
  try {
    const results = [];
    for (const fallback of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 440, height: 440 } });
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          return /^webgl/.test(kind) ? null : get.call(this, kind, ...args);
        };
      });
      await page.goto(base + 'ball-web/composer.html?preview=240');
      await page.locator('#bar.figure-ready').waitFor();
      const result = await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        const rig = await SkeletalCharacter.create(new URL('./reference/', location.href));
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 768;
        const ctx = canvas.getContext('2d');
        function draw(yawn) {
          rig.draw(root, null, { sit: 1, sleep: 0, yawn, expression: 'sleepy', reducedMotion: false });
          ctx.clearRect(0, 0, 768, 768);
          for (const layer of root.querySelectorAll('canvas')) {
            ctx.globalAlpha = Number(layer.style.opacity || 1);
            ctx.drawImage(layer, 0, 0);
          }
          ctx.globalAlpha = 1;
          return { data: ctx.getImageData(0, 0, 768, 768).data, joints: rig.info().joints };
        }
        const start = draw(0);
        const repeatedStart = draw(0);
        const middle = draw(.5);
        const end = draw(1);
        let delta = 0;
        for (let i = 0; i < start.data.length; i++) delta += Math.abs(start.data[i] - middle.data[i]);
        const hand = joints => joints.filter(item => item.name === 'handL' || item.name === 'handR');
        let endpointDelta = 0;
        for (let i = 0; i < start.data.length; i++) endpointDelta += Math.abs(start.data[i] - end.data[i]);
        let repeatDelta = 0;
        for (let i = 0; i < start.data.length; i++) repeatDelta += Math.abs(start.data[i] - repeatedStart.data[i]);
        const endpointMean = endpointDelta / start.data.length;
        const repeatMean = repeatDelta / start.data.length;
        const handDelta = hand(start.joints).reduce((sum, item, i) => {
          const other = hand(middle.joints)[i];
          return sum + Math.hypot(item.x - other.x, item.y - other.y);
        }, 0);
        rig.dispose();
        return { delta, endpointMean, repeatMean, handDelta };
      });
      assert.ok(result.endpointMean < .001, 'yawn returns to the seated pose within raster tolerance: ' + JSON.stringify(result));
      assert.ok(result.repeatMean < .001, 'repeated seated frames stay stable: ' + JSON.stringify(result));
      assert.ok(result.delta > 1000, 'yawn must visibly move the seated character');
      assert.ok(result.handDelta > 4, 'yawn must raise both hands smoothly');
      results.push({ fallback, ...result });
      await page.close();
    }
    console.log(JSON.stringify({ passed: true, results }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
