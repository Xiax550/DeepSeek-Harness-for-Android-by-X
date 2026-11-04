const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.clock.install();
    await page.goto(base + 'ball-web/composer.html?preview=300');
    await page.locator('#bar.figure-ready').waitFor();
    await page.evaluate(() => BallUI.react('stretch', 'sleepy'));
    await page.clock.runFor(1100);
    assert.equal(await page.evaluate(() => BallUI.react('wave', 'happy')), false, 'a second gesture cannot replace a moving pose');
    await page.evaluate(() => BallUI.bubble('think', '\u6b63\u5728\u5904\u7406'));
    await page.clock.runFor(70);
    assert.equal(await page.evaluate(() => BallUI.characterInfo().gesture), 'stretch', 'interruption starts with a return motion');
    await page.clock.runFor(250);
    assert.equal(await page.evaluate(() => BallUI.characterInfo().gesture), '', 'return motion finishes promptly');

    const metrics = await page.evaluate(async () => {
      dispatchEvent(new Event('pagehide'));
      const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      document.querySelector('#figureRoot').replaceWith(root);
      const renderer = await ReferenceCharacter.create(new URL('./reference/', location.href));
      let frames = 0, triangles = 0, invertedHairTriangles = 0, rigidEdgeError = 0;
      try {
        for (const view of ['front', 'side']) {
          for (let step = 0; step <= 100; step++) {
            for (const options of [{ sit: step / 100 }, { sit: 1, sleep: step / 100 }]) {
              renderer.draw(root, null, { t: 0, view, ...options });
              const audit = renderer.auditGeometry();
              frames++; triangles += audit.triangles;
              invertedHairTriangles += audit.invertedHairTriangles;
              rigidEdgeError = Math.max(rigidEdgeError, audit.rigidEdgeError);
              if (renderer.info().joints.some(j => j.scale.some(n => n !== 1))) throw new Error('Scaled joint');
            }
          }
        }
      } finally { renderer.dispose(); }
      return { frames, triangles, invertedHairTriangles, rigidEdgeError };
    });
    assert.equal(metrics.frames, 404);
    assert.ok(metrics.triangles > 100000, 'audit skinned vertices, not an obsolete buffer size');
    assert.equal(metrics.invertedHairTriangles, 0);
    assert.ok(metrics.rigidEdgeError < 1e-5, 'head, torso and limbs keep their shape');
    console.log(JSON.stringify({ passed: true, interruptionReturnsSmoothly: true, ...metrics }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
