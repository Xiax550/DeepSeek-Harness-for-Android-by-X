const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  const results = [];
  try {
    for (const fallback of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 440, height: 440 } });
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          return /^webgl/.test(kind) ? null : get.call(this, kind, ...args);
        };
      });
      const now = new Date('2026-11-05T12:00:00+08:00');
      await page.clock.install({ time: now }); await page.clock.pauseAt(now);
      await page.goto(base + 'ball-web/composer.html?preview=240');
      await page.locator('#bar.figure-ready').waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const hash = async () => crypto.createHash('sha256').update(await page.locator('#figureDoll').screenshot()).digest('hex');
      await page.evaluate(() => BallUI.idleStage(0)); await page.clock.runFor(500);
      const stand = await hash();
      await page.evaluate(() => BallUI.idleStage(1)); await page.clock.runFor(2200);
      const sit = await hash();
      await page.evaluate(() => BallUI.idleStage(0)); await page.clock.runFor(2200);
      const wake = await hash();
      await page.evaluate(() => BallUI.idleStage(0)); await page.clock.runFor(100);
      const standAgain = await hash();
      const info = await page.evaluate(() => BallUI.characterInfo());
      const result = { stand, sit, wake, standAgain, info };
      assert.equal(stand, standAgain, 'standing artwork must be byte-stable after a pose round trip');
      assert.equal(info.wholeBodyMotion, null, 'pose endpoint must not leave a whole-body clip active');
      results.push({ fallback, result }); await page.close();
    }
    fs.writeFileSync('build/character-endpoint-consistency.json', JSON.stringify({ passed: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, renderers: results.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
