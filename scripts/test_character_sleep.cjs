const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], snapshots = [], stats = [];
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
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.install();
      await page.goto(base + 'ball-web/composer.html?preview=300');
      await page.locator('#bar.figure-ready').waitFor();
      const info = () => page.evaluate(() => BallUI.restInfo());
      async function record(label) {
        const frame = await page.locator('#figureRoot canvas').evaluate(canvas => canvas.toDataURL());
        if (!fallback) snapshots.push({ label, frame });
      }
      await page.clock.runFor(100);
      await record('Standing');
      await page.evaluate(() => BallUI.idleStage(1));
      await page.clock.runFor(850);
      assert.ok((await info()).amount > .2 && (await info()).amount < .8);
      await record('Sitting down');
      await page.clock.runFor(2200);
      assert.equal((await info()).amount, 1);
      await record('7 minutes: seated');
      assert.equal(await page.locator('#sleepMark').isVisible(), false);
      const seatedFrames = (await info()).frames;
      await page.clock.runFor(4000);
      assert.ok((await info()).frames - seatedFrames <= 5);
      await page.evaluate(() => BallUI.idleStage(2));
      await page.clock.runFor(500);
      assert.equal(await page.evaluate(() => BallUI.characterInfo().expression), 'sleepy');
      await record('10 minutes: drowsy');
      await page.clock.runFor(7500);
      await page.evaluate(() => BallUI.idleStage(3));
      await page.clock.runFor(600);
      assert.ok((await info()).sleep > .1 && (await info()).sleep < .8);
      await record('Lying down: early');
      await page.clock.runFor(600);
      await record('Lying down: middle');
      const beforeReverse = await info();
      await page.evaluate(() => BallUI.pointer('down'));
      assert.equal((await info()).stage, 0);
      assert.ok(Math.abs((await info()).sleep - beforeReverse.sleep) < .04,
        'wake reversal must remain within one rendered frame: ' + JSON.stringify({ beforeReverse, after: await info() }));
      await page.evaluate(() => BallUI.pointer('lift'));
      await page.clock.runFor(Math.max(4500, (await info()).wakeDurationMs + 100));
      assert.equal((await info()).sleep, 0);
      assert.equal((await info()).amount, 0);
      await record('Interrupted: awake');
      await page.evaluate(() => BallUI.idleStage(1));
      await page.clock.runFor(1800);
      await page.evaluate(() => BallUI.idleStage(2));
      await page.clock.runFor(8000);
      await page.evaluate(() => BallUI.idleStage(3));
      await page.clock.runFor(1900);
      await record('Lying down: late');
      await page.clock.runFor(2000);
      assert.equal((await info()).sleep, 1);
      assert.equal(await page.locator('#sleepMark').isVisible(), true, 'sleep marker appears only after lying down');
      const mark = await page.locator('#sleepMark').boundingBox();
      const cap = await page.locator('#cap').boundingBox();
      assert.ok(mark.x >= cap.x && mark.y >= cap.y && mark.x + mark.width <= cap.x + cap.width
        && mark.y + mark.height <= cap.y + cap.height, 'sleep marker remains inside the native window');
      await record('Sleeping');
      const zCycle = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('#sleepMark span')];
        const animations = spans.map(span => span.getAnimations()[0]);
        if (animations.some(animation => !animation)) throw new Error('sleep marker animations missing');
        animations.forEach(animation => animation.pause());
        return [900, 2000, 3100].map(time => {
          animations.forEach(animation => { animation.currentTime = time; });
          return spans.map(span => Number(getComputedStyle(span).opacity));
        });
      });
      for (let i = 0; i < 3; i++) {
        assert.ok(zCycle[i][i] > .95, 'sleep Z order: bottom, middle, top');
        assert.ok(zCycle[i].every((alpha, j) => j <= i || alpha < .05), 'future Z symbols do not appear early');
        if (!fallback) {
          await page.evaluate(time => document.querySelectorAll('#sleepMark span').forEach(span => {
            span.getAnimations().forEach(animation => { animation.currentTime = time; });
          }), [900, 2000, 3100][i]);
          await page.screenshot({ path: 'build/character-sleep-z-' + i + '.png' });
        }
      }
      const fade = await page.evaluate(() => {
        const span = document.querySelector('#sleepMark span');
        const animation = span.getAnimations()[0];
        return [0, 120, 400, 700, 900, 1800, 2200, 2700].map(time => {
          animation.currentTime = time;
          return Number(getComputedStyle(span).opacity);
        });
      });
      assert.equal(fade[0], 0);
      assert.ok(fade[1] > 0 && fade[1] < .15, 'first Z starts with a gentle fade, not a pop');
      assert.ok(fade[2] > .2 && fade[2] < .7);
      assert.ok(fade[3] > .8 && fade[3] < 1);
      assert.equal(fade[4], 1);
      assert.ok(fade[5] > fade[6] && fade[6] > fade[7], 'Z fades out continuously before the loop');
      const joins = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('#sleepMark span')];
        const animations = spans.map(span => span.getAnimations()[0]);
        return spans.map((span, i) => {
          const delay = i * 1100;
          return [4799, 4800, 4920, 5200].map(time => {
            animations[i].currentTime = time + delay;
            return Number(getComputedStyle(span).opacity);
          });
        });
      });
      for (const alpha of joins) {
        assert.ok(alpha[0] < .000001, 'each Z finishes fading before its next cycle');
        assert.ok(alpha[1] < .000001, 'cycle boundary does not flash');
        assert.ok(alpha[2] > 0 && alpha[2] < .15, 'every Z gently fades in again');
        assert.ok(alpha[3] > .2 && alpha[3] < .7);
      }
      if (!fallback) await page.screenshot({ path: 'build/character-sleep-marker.png' });
      await page.evaluate(() => document.querySelectorAll('#sleepMark span').forEach(span => {
        span.getAnimations().forEach(animation => animation.play());
      }));
      const sleepFrames = (await info()).frames;
      await page.clock.runFor(4000);
      assert.ok((await info()).frames - sleepFrames <= 5, 'sleep must remain low-frequency');
      await page.evaluate(() => { dispatchEvent(new Event('pagehide')); dispatchEvent(new Event('pageshow')); });
      await page.clock.runFor(2200);
      assert.equal((await info()).stage, 3, 'page resume retains sleeping pose');
      for (const mode of ['voice', 'watch', 'task', 'click', 'drop', 'keyboard']) {
        await page.evaluate(() => BallUI.idleStage(3));
        await page.clock.runFor(4000);
        await page.evaluate(mode => {
          if (mode === 'voice') BallUI.setListening(true);
          if (mode === 'watch') BallUI.watchActive(true);
          if (mode === 'task') BallUI.bubble('think', '正在处理');
          if (mode === 'click') ComposerUI.open();
          if (mode === 'drop') BallUI.pointer('drop');
          if (mode === 'keyboard') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        }, mode);
        assert.equal((await info()).stage, 0, mode + ' wakes prone character');
        assert.equal(await page.locator('#sleepMark').isVisible(), false, mode + ' immediately hides sleep marker');
        assert.equal(await page.locator('#sleepMark').evaluate(el => el.getAnimations({ subtree: true }).length), 0,
          mode + ' stops sleep animations on wake');
        if (['voice', 'watch', 'task'].includes(mode)) {
          await page.evaluate(() => BallUI.idleStage(3));
          assert.equal((await info()).stage, 0, mode + ' rejects sleep while busy');
        }
        await page.clock.runFor(Math.max(4500, (await info()).wakeDurationMs + 100));
        assert.equal((await info()).sleep, 0);
        assert.equal((await info()).amount, 0);
        await page.evaluate(() => {
          BallUI.setListening(false); BallUI.watchActive(false); BallUI.collapse(); BallUI.collapseDone(); BallUI.bubbleDone();
        });
      }
      await page.evaluate(() => { BallUI.idleStage(99); BallUI.idleStage(NaN); BallUI.idleStage(-1); });
      assert.equal((await info()).stage, 0, 'invalid stage cannot poison renderer');
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => BallUI.idleStage(3));
        await page.clock.runFor(100);
        await page.evaluate(() => BallUI.idleStage(0));
        await page.clock.runFor(100);
      }
      await page.evaluate(() => BallUI.idleStage(3));
      await page.clock.runFor(5000);
      const count = (await info()).frames;
      await page.clock.runFor(4000);
      const delta = (await info()).frames - count;
      assert.ok(delta <= 5, 'rapid sleep toggles must not leak animation loops');
      stats.push({ renderer: fallback ? 'canvas-fallback' : 'webgl-mesh', lowPowerFrames: delta, wakeCases: 6 });
      await context.close();
    }
    const reduced = await browser.newPage({ reducedMotion: 'reduce' });
    await reduced.goto(base + 'ball-web/composer.html?preview=300');
    await reduced.locator('#bar.figure-ready').waitFor();
    await reduced.evaluate(() => BallUI.idleStage(3));
    await reduced.waitForTimeout(150);
    assert.equal(await reduced.evaluate(() => BallUI.restInfo().sleep), 1);
    assert.deepEqual(await reduced.locator('#sleepMark').evaluate(el => ({
      animations: el.getAnimations({ subtree: true }).length,
      visible: [...el.children].every(span => Number(getComputedStyle(span).opacity) === 1)
    })), { animations: 0, visible: true }, 'reduced motion retains static Z symbols without animation');
    await reduced.evaluate(() => BallUI.idleStage(0));
    await reduced.waitForTimeout(150);
    assert.equal(await reduced.evaluate(() => BallUI.restInfo().sleep), 0);
    await reduced.close();
    const gallery = await browser.newPage({ viewport: { width: 1150, height: 900 } });
    await gallery.setContent('<main style="display:flex;flex-wrap:wrap;gap:12px;background:#d8e0e6;padding:12px"></main>');
    await gallery.evaluate(frames => {
      for (const { label, frame } of frames) {
        const item = document.createElement('div'); item.style.cssText = 'width:256px;text-align:center;font:14px sans-serif';
        const img = document.createElement('img'); img.src = frame; img.width = img.height = 256;
        item.append(img, document.createTextNode(label)); document.querySelector('main').appendChild(item);
      }
    }, snapshots);
    await gallery.screenshot({ path: 'build/ciallo-sleep-transitions.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, stats, zSequence: 'bottom-middle-top',
      wakeStopsZ: true, interruptedTransition: true, reducedMotion: true }, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
