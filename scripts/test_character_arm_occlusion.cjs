const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  try {
    const results = [];
    for (const fallback of [false, true]) {
      const page = await browser.newPage();
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return /^webgl/.test(type) ? null : get.call(this, type, ...args);
        };
      });
      await page.goto(base + 'ball-web/composer.html');
      await page.locator('#bar.figure-ready').waitFor();
      const data = await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        const rig = await SkeletalCharacter.create(new URL('./reference/', location.href));
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const copy = document.createElement('canvas'); copy.width = copy.height = 768;
        const ctx = copy.getContext('2d'), frames = [], samples = [];
        for (const k of [.25, .4, .5, .6, .75]) {
          rig.draw(root, null, { t: 0, gesture: { kind: 'stretch', k } });
          ctx.clearRect(0, 0, 768, 768);
          for (const canvas of root.querySelectorAll('canvas')) {
            ctx.globalAlpha = Number(canvas.style.opacity || 1); ctx.drawImage(canvas, 0, 0);
          }
          const alpha = [], centers = [];
          // Hair immediately behind the original forearms must remain opaque.
          for (const [x, y] of [[110, 275], [260, 275]]) {
            const px = (130 + (x - 357 / 2) * .433) * 768 / 260;
            const py = (254 - (545 - y) * .433) * 768 / 260;
            const pixels = ctx.getImageData(Math.round(px) - 2, Math.round(py) - 2, 5, 5).data;
            let opaque = 0;
            for (let p = 3; p < pixels.length; p += 4) if (pixels[p] > 230) opaque++;
            alpha.push(opaque / 25);
            centers.push(pixels[(2 * 5 + 2) * 4 + 3]);
          }
          samples.push({ k, coverage: alpha, centers });
          if (k === .5) frames.push(copy.toDataURL());
        }
        rig.dispose(); return { samples, repairs: DHA_SKELETON.occlusionRepairs, frames };
      });
      fs.writeFileSync('build/stretch-occlusion-' + (fallback ? 'canvas' : 'webgl') + '.png',
        Buffer.from(data.frames[0].split(',')[1], 'base64'));
      delete data.frames;
      for (const owner of ['spine', 'skirt', 'hairL', 'hairR']) assert.ok(data.repairs[owner] > 0, owner + ' underpaint exists');
      for (const sample of data.samples) assert.ok(sample.coverage.every(value => value >= .8)
        && sample.centers.every(value => value >= 200),
        'stretch must not uncover transparent forearm holes: ' + JSON.stringify(sample));
      results.push({ fallback, ...data }); await page.close();
    }
    fs.writeFileSync('build/stretch-occlusion-results.json', JSON.stringify({ passed: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
