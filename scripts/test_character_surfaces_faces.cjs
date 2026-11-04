const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], results = [];
  try {
    for (const fallback of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 450, height: 430 } });
      if (fallback) await context.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return /^webgl/.test(type) ? null : original.call(this, type, ...args);
        };
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      const now = new Date('2026-11-02T04:00:00Z');
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now);
      await page.goto(base + 'ball-web/composer.html?preview=54');
      await page.locator('#bar.figure-ready').waitFor();
      const style = selector => page.locator(selector).evaluate(el => {
        const css = getComputedStyle(el);
        return { background: css.backgroundColor, shadow: css.boxShadow, border: css.outlineColor, borderWidth: css.outlineWidth };
      });
      await page.evaluate(() => ComposerUI.open());
      await page.clock.runFor(400);
      for (const selector of ['#bar', '#inputPill']) {
        const css = await style(selector);
        assert.equal(css.background, 'rgba(0, 0, 0, 0)', selector + ' is transparent');
        assert.equal(css.shadow, 'none');
        if (selector === '#inputPill') {
          assert.equal(css.border, 'rgba(143, 158, 184, 0.95)');
          assert.equal(css.borderWidth, '1px');
        }
      }
      await page.screenshot({ path: 'build/transparent-input-' + (fallback ? 'canvas' : 'webgl') + '.png' });
      await page.evaluate(() => { BallUI.collapse(); BallUI.collapseDone(); });
      await page.clock.runFor(400);
      for (const phase of ['think', 'work']) {
        await page.evaluate(phase => BallUI.bubble(phase, '正在处理'), phase);
        await page.clock.runFor(400);
        const css = await style('#bubbleText');
        assert.equal(css.background, 'rgba(0, 0, 0, 0)', phase + ' has no plate');
        assert.equal(css.shadow, 'none');
        assert.equal(css.border, 'rgba(143, 158, 184, 0.95)');
        assert.equal(css.borderWidth, '1px');
        assert.equal(await page.locator('#bubbleText').evaluate(el => getComputedStyle(el, '::after').display), 'none');
        await page.evaluate(() => BallUI.bubbleDone());
        await page.clock.runFor(400);
      }
      await page.evaluate(() => BallUI.bubble('result', '任务已完成，结果背景保持原样。'));
      await page.clock.runFor(400);
      assert.equal((await style('#bubbleText')).background, 'rgba(255, 255, 255, 0.97)');
      await page.evaluate(() => BallUI.bubble('think', '新的思考状态'));
      assert.equal((await style('#bubbleText')).background, 'rgba(255, 255, 255, 0.97)', 'late thinking cannot clear held result');
      await page.evaluate(() => { BallUI.bubbleDone(); BallUI.idleStage(3); });
      await page.clock.runFor(5000);
      await page.evaluate(() => ComposerUI.side('right'));
      await page.clock.runFor(100);
      assert.equal(await page.evaluate(() => BallUI.characterInfo().expression), 'sleepy', 'turn blink cannot wake a sleeping face');

      const facial = await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        document.querySelector('#figureRoot').replaceWith(root);
        const renderer = await ReferenceCharacter.create(new URL('./reference/', location.href));
        function draw(mix) {
          renderer.draw(root, null, { t: 0, expression: 'blink', previousExpression: 'neutral', expressionMix: mix });
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 768;
          const ctx = canvas.getContext('2d'); ctx.drawImage(root.querySelector('canvas'), 0, 0);
          return ctx.getImageData(0, 0, 768, 768).data;
        }
        const open = draw(0), half = draw(.5), closed = draw(1);
        let changed = 0, intermediate = 0, bodyChanges = 0;
        for (let i = 0; i < open.length; i += 4) {
          const delta = Math.abs(open[i] - closed[i]) + Math.abs(open[i + 1] - closed[i + 1]) + Math.abs(open[i + 2] - closed[i + 2]);
          if (delta > 30) {
            changed++;
            if (Math.abs(half[i] - open[i]) + Math.abs(half[i + 1] - open[i + 1]) + Math.abs(half[i + 2] - open[i + 2]) > 5
              && Math.abs(half[i] - closed[i]) + Math.abs(half[i + 1] - closed[i + 1]) + Math.abs(half[i + 2] - closed[i + 2]) > 5) intermediate++;
          }
          if (Math.floor(i / 4 / 768) > 400 && delta > 10) bodyChanges++;
        }
        renderer.dispose();
        return { changed, intermediate, bodyChanges };
      });
      assert.ok(facial.changed > 100);
      assert.ok(facial.intermediate > facial.changed * .8, 'face has intermediate frames instead of a hard texture switch');
      assert.equal(facial.bodyChanges, 0, 'facial transitions must not move or distort the body');
      results.push({ renderer: fallback ? 'canvas' : 'webgl', ...facial });
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, transparentInputAndProgress: true, resultUnchanged: true, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
