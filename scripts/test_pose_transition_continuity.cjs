const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const label = process.argv[2] || 'after';
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 520 } });
    await page.goto(base + 'ball-web/composer.html');
    await page.locator('#bar.figure-ready').waitFor();
    const result = await page.evaluate(async () => {
      dispatchEvent(new Event('pagehide'));
      document.body.innerHTML = '<main style="display:flex;flex-wrap:wrap;background:#e4e9ef"></main>';
      const rig = await ReferenceCharacter.create(new URL('./reference/', location.href));
      const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const copy = document.createElement('canvas'); copy.width = copy.height = 256;
      const ctx = copy.getContext('2d'); const clips = [];
      for (const mode of ['sit', 'sleep']) {
        let previous = null, maxStep = 0, peakAt = 0;
        for (let frame = 0; frame <= 90; frame++) {
          const t = frame / 90, amount = t*t*t*(t*(t*6-15)+10);
          rig.draw(root, null, { t: 0, sit: mode === 'sit' ? amount : 1,
            sleep: mode === 'sleep' ? amount : 0, expression: mode === 'sleep' ? 'sleepy' : 'neutral' });
          ctx.clearRect(0, 0, 256, 256); ctx.drawImage(root.querySelector('canvas'), 0, 0, 256, 256);
          const pixels = ctx.getImageData(0, 0, 256, 256).data;
          if (previous) {
            let delta = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              for (let c = 0; c < 3; c++) delta += Math.abs(pixels[i+c]*pixels[i+3]/255 - previous[i+c]*previous[i+3]/255);
              delta += Math.abs(pixels[i+3]-previous[i+3]);
            }
            delta /= pixels.length;
            if (delta > maxStep) { maxStep = delta; peakAt = t; }
          }
          previous = pixels;
          if ([0, 23, 45, 67, 90].includes(frame)) {
            const box = document.createElement('div'); box.style.cssText = 'width:200px;text-align:center;font:14px sans-serif';
            const img = new Image(); img.src = copy.toDataURL(); img.width = img.height = 200;
            box.append(mode + ' ' + Math.round(t*100) + '%', img); document.querySelector('main').append(box);
          }
        }
        clips.push({ mode, maxStep, peakAt });
      }
      rig.dispose(); return clips;
    });
    await page.screenshot({ path: 'build/pose-transition-' + label + '.png' });
    fs.writeFileSync('build/pose-transition-' + label + '.json', JSON.stringify(result, null, 2));
    if (label === 'after') {
      const before = JSON.parse(fs.readFileSync('build/pose-transition-before.json', 'utf8'));
      result.forEach((clip, i) => assert.ok(clip.maxStep < before[i].maxStep * .8,
        clip.mode + ' must reduce the largest frame jump by at least 20%'));
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
