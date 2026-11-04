const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], frames = [], results = [];
  try {
    for (const fallback of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 450, height: 430 }, deviceScaleFactor: 3 });
      if (fallback) await context.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return /^webgl/.test(type) ? null : get.call(this, type, ...args);
        };
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      const now = new Date('2026-11-02T02:00:00+08:00');
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now);
      await page.goto(base + 'ball-web/composer.html?preview=300');
      await page.locator('#bar.figure-ready').waitFor();
      const info = () => page.evaluate(() => ({ ...BallUI.restInfo(), ...BallUI.characterInfo() }));
      async function sleeping() {
        await page.evaluate(() => {
          BallUI.setListening(false); BallUI.watchActive(false); BallUI.bubbleDone();
          BallUI.collapse(); BallUI.collapseDone(); BallUI.idleStage(3);
        });
        await page.clock.runFor(6000);
        assert.equal((await info()).sleep, 1);
      }
      await sleeping();
      await page.evaluate(() => {
        const random = Math.random; Math.random = () => .1;
        try {
        // Native idle reset can arrive before the pointer and input callbacks.
        BallUI.idleStage(0); BallUI.pointer('down'); BallUI.pointer('lift'); ComposerUI.open();
        } finally { Math.random = random; }
      });
      assert.equal(await page.locator('#sleepMark').isVisible(), false);
      const duration = (await info()).wakeDurationMs;
      assert.equal(duration, 10200, '2600ms look + 4400ms rise + optional 3200ms stretch');
      let elapsed = 0;
      let previousAmount = 1, previousSleep = 1;
      for (const [time, phase] of [[100, 'looking'], [800, 'looking'], [1800, 'looking'],
        [2800, 'rising'], [4200, 'rising'], [5500, 'rising'], [6500, 'rising'], [8100, 'rising'],
        [8500, 'stretching'], [10500, 'stretching'], [11200, 'stretching'], [11600, '']]) {
        const actualTime = Math.round(time <= 2600 ? time : time <= 8200 ? 2600 + (time - 2600) * 4400 / 5600 : time - 1200);
        await page.clock.runFor(actualTime - elapsed); elapsed = actualTime;
        const current = await info();
        assert.equal(current.wakePhase, phase);
        if (phase) assert.equal(current.referencePoseBlend.sit, 0,
          'prone wake must never display or blend in the seated endpoint');
        assert.ok(current.amount <= previousAmount + .001, 'wake posture must progress without jumping back');
        assert.ok(current.sleep <= previousSleep + .001, 'sleep pose must release monotonically');
        previousAmount = current.amount; previousSleep = current.sleep;
        if (phase === 'looking') assert.equal(current.expression, 'pout');
        if (phase === 'rising') assert.equal(current.expression, current.sleep > .05 ? 'pout' : 'neutral');
        if (time === 100) assert.ok(current.sleep > .99 && current.amount > .99);
        if (time === 2800) assert.ok(current.sleep > .95 && current.amount > .99, 'start the rise gently from the current pose');
        if (time === 5500) assert.ok(current.amount > .2 && current.amount < .8, 'faster rise retains an intermediate pose');
        if (time === 6500) assert.ok(current.amount < .8 && current.sleep > 0,
          'unfold the legs while pushing up, without a seated plateau');
        if (phase === 'looking') {
          assert.equal(current.amount, 1, 'look around before rising');
          assert.equal(current.sleep, 1, 'do not lift the body before looking');
          if (time !== 100) assert.ok(time === 800 ? current.gazeX > .1 : current.gazeX < -.1, 'look in both horizontal directions');
        }
        if (phase === 'stretching') {
          assert.equal(current.amount, 0); assert.equal(current.sleep, 0);
          assert.equal(current.gesture, 'stretch');
          assert.equal(current.expression, 'sleepy');
        }
        if (!phase) {
          assert.equal(current.gesture, ''); assert.equal(current.expression, 'neutral');
        }
        if (!fallback) {
          const label = !phase ? '恢复日常' : phase === 'looking' ? (current.gazeX > 0 ? '向一侧看' : '向另一侧看')
            : phase === 'rising' ? (current.amount > .7 ? '开始起身' : '缓慢站立')
            : current.gesture && current.gesture === 'stretch' ? '伸懒腰' : phase;
          frames.push({ label, image: await page.locator('#figureRoot canvas').evaluateAll(canvases => {
            const copy = document.createElement('canvas'); copy.width = copy.height = 768;
            const ctx = copy.getContext('2d');
            for (const canvas of canvases) {
              ctx.globalAlpha = Number(canvas.style.opacity || 1); ctx.drawImage(canvas, 0, 0);
            }
            return copy.toDataURL();
          }) });
        }
        if (time === 800) {
          await page.evaluate(() => { BallUI.pointer('down'); BallUI.pointer('lift'); ComposerUI.open(); });
          assert.equal((await info()).wakeDurationMs, duration, 'repeated input must not restart waking');
          assert.equal(await page.evaluate(() => BallUI.react('wave', 'happy')), false);
        }
      }
      await sleeping();
      await page.evaluate(() => {
        const random = Math.random; Math.random = () => .8;
        try { BallUI.pointer('drop'); } finally { Math.random = random; }
      });
      assert.equal((await info()).wakeDurationMs, 7000, '80% branch skips the entire stretch phase');
      await page.clock.runFor(1800);
      await page.evaluate(() => {
        const random = Math.random; Math.random = () => .1;
        try { BallUI.pointer('down'); BallUI.pointer('lift'); } finally { Math.random = random; }
      });
      assert.equal((await info()).wakeDurationMs, 7000, 'repeated input cannot reroll the wake decision');
      await page.clock.runFor(5000);
      assert.equal((await info()).wakePhase, 'rising');
      await page.clock.runFor(600);
      assert.equal((await info()).wakePhase, '');
      assert.equal((await info()).gesture, '');
      assert.equal((await info()).expression, 'neutral');
      for (const work of ['voice', 'watch', 'task']) {
        await sleeping();
        await page.evaluate(() => BallUI.pointer('down'));
        await page.clock.runFor(1800);
        await page.evaluate(work => {
          if (work === 'voice') BallUI.setListening(true);
          if (work === 'watch') BallUI.watchActive(true);
          if (work === 'task') BallUI.bubble('think', '正在处理');
        }, work);
        await page.clock.runFor(100);
        assert.equal((await info()).wakePhase, '', work + ' takes priority over decorative waking');
        assert.equal((await info()).expression, 'curious');
        await page.clock.runFor(6000);
        assert.equal((await info()).sleep, 0); assert.equal((await info()).amount, 0);
        await page.evaluate(() => BallUI.pointer('lift'));
      }
      await page.evaluate(() => { BallUI.setListening(false); BallUI.watchActive(false); BallUI.bubbleDone(); BallUI.idleStage(2); });
      await page.clock.runFor(6000);
      await page.evaluate(() => BallUI.pointer('drop'));
      await page.clock.runFor(1800);
      assert.equal((await info()).wakePhase, 'looking');
      assert.equal((await info()).amount, 1);
      assert.equal((await info()).sleep, 0);
      await page.clock.runFor(1900);
      assert.equal((await info()).wakePhase, 'rising');
      assert.ok((await info()).amount < .98, 'already seated character starts rising without a redundant floor-recovery pause');
      await page.clock.runFor(9000);
      assert.equal((await info()).wakePhase, '');
      await sleeping();
      await page.evaluate(() => BallUI.pointer('drop'));
      await page.clock.runFor(1200);
      const before = await info();
      await page.evaluate(() => BallUI.idleStage(3));
      assert.ok(Math.abs((await info()).sleep - before.sleep) < .04, 'sleep reversal keeps the current pose');
      await page.clock.runFor(6000);
      assert.equal((await info()).sleep, 1);
      await page.evaluate(() => { BallUI.pointer('drop'); dispatchEvent(new Event('pagehide')); });
      await page.clock.runFor(20000);
      await page.evaluate(() => dispatchEvent(new Event('pageshow')));
      await page.clock.runFor(100);
      assert.equal((await info()).wakePhase, '', 'resuming an elapsed wake finishes safely');
      await page.evaluate(() => BallUI.size(48));
      assert.equal(await page.locator('#cap').evaluate(el => el.getBoundingClientRect().width), 54);
      await page.evaluate(() => BallUI.size(54));
      assert.equal(await page.locator('#cap').evaluate(el => el.getBoundingClientRect().width), 54);
      results.push({ renderer: fallback ? 'canvas-fallback' : 'webgl-mesh', duration, minimumDp: 54 });
      await context.close();
    }
    const gallery = await browser.newPage({ viewport: { width: 1100, height: 600 } });
    await gallery.setContent('<main style="display:flex;flex-wrap:wrap;background:#d8e0e6;padding:12px"></main>');
    await gallery.evaluate(frames => {
      for (const frame of frames) {
        const item = document.createElement('div'); item.style.cssText = 'width:256px;text-align:center;font:14px sans-serif';
        const image = document.createElement('img'); image.src = frame.image; image.width = image.height = 256;
        item.append(image, document.createTextNode(frame.label)); document.querySelector('main').appendChild(item);
      }
    }, frames);
    await gallery.screenshot({ path: 'build/character-wake-sequence.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, results, repeatedClickSafe: true, workPriority: true, resumeSafe: true }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
