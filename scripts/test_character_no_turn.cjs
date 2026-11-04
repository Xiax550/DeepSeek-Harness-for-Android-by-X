const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 440, height: 440 } });
    const now = new Date('2026-11-03T22:00:00+08:00');
    await page.clock.install({ time: now }); await page.clock.pauseAt(now);
    await page.goto((process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/') + 'ball-web/composer.html?preview=240');
    await page.locator('#bar.figure-ready').waitFor();
    assert.equal(await page.evaluate(() => BallUI.react('sideLook')), false);
    for (const side of ['right', 'left', 'right', 'left']) {
      await page.evaluate(side => ComposerUI.side(side), side);
      await page.clock.runFor(650);
      assert.equal(await page.locator('#figureMirror').getAttribute('transform'), '');
      assert.equal(await page.evaluate(() => BallUI.characterInfo().view), 'front');
    }
    const selection = await page.evaluate(() => {
      const result = {};
      for (let i = 0; i < 1000; i++) { const k = DHA_GESTURE_POLICY.pick((i + .5) / 1000); result[k] = (result[k] || 0) + 1; }
      return result;
    });
    assert.equal(selection.stretch, 150);
    assert.equal(selection.sideLook, undefined);
    fs.writeFileSync('build/character-no-turn.json', JSON.stringify({ passed: true, selection }, null, 2));
    console.log(JSON.stringify({ passed: true, selection }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
