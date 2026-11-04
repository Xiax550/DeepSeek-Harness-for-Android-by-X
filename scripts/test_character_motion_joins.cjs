const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  const errors = [], samples = [];
  try {
    for (const fallback of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 440, height: 440 } });
      page.on('pageerror', error => errors.push(error.message));
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          return /^webgl/.test(kind) ? null : get.call(this, kind, ...args);
        };
      });
      const now = new Date('2026-11-03T18:00:00+08:00');
      await page.clock.install({ time: now }); await page.clock.pauseAt(now);
      await page.goto(base + 'ball-web/composer.html?preview=240');
      await page.locator('#bar.figure-ready').waitFor();
      const info = () => page.evaluate(() => ({ ...BallUI.restInfo(), ...BallUI.characterInfo() }));
      const frameRate = await page.evaluate(() => DHA_WHOLE_MOTION.clips.wake.fps);
      await page.evaluate(() => BallUI.idleStage(1)); await page.clock.runFor(1800);
      assert.equal((await info()).amount, 1, 'drowsy sequence starts from the completed seated pose');
      await page.evaluate(() => BallUI.idleStage(2)); await page.clock.runFor(5200);
      assert.equal((await info()).yawnProgress, 0, 'yawn has a deliberate sleepy lead-in');
      await page.clock.runFor(1100);
      const yawning = await info();
      assert.equal(yawning.stage, 2);
      assert.equal(yawning.yawning, true, 'mouth-open yawn stays a seated action');
      assert.equal(yawning.expression, 'sleepy');
      assert.ok(yawning.expressionMix > .95, 'approved open-mouth sleepy face reaches full expression');
      await page.screenshot({ path: 'build/character-yawn-' + (fallback ? 'canvas' : 'webgl') + '.png' });
      await page.clock.runFor(1100);
      assert.equal((await info()).yawning, false, 'yawn closes before the sleep transition');
      await page.evaluate(() => BallUI.idleStage(3)); await page.clock.runFor(350);
      assert.equal((await info()).wholeBodyMotion.clip, 'lie', 'completed seated yawn flows into the prone clip');
      await page.evaluate(() => BallUI.idleStage(0)); await page.clock.runFor(12000);
      assert.equal((await info()).sleep, 0, 'wake completes after the new drowsy sequence');
      assert.equal((await info()).amount, 0);
      const settle = async () => {
        await page.evaluate(() => { BallUI.setListening(false); BallUI.watchActive(false); BallUI.bubbleDone();
          BallUI.collapse(); BallUI.collapseDone(); BallUI.idleStage(3); });
        await page.clock.runFor(6500);
        assert.equal((await info()).sleep, 1);
      };
      await page.evaluate(() => BallUI.idleStage(1));
      await page.clock.runFor(800);
      let current = await info();
      assert.equal(current.wholeBodyMotion.clip, 'sit');
      const sitFrame = current.wholeBodyMotion.frame;
      await page.evaluate(() => BallUI.idleStage(0)); await page.clock.runFor(40);
      current = await info();
      assert.equal(current.wholeBodyMotion.clip, 'sit');
      assert.ok(Math.abs(current.wholeBodyMotion.frame - sitFrame) / frameRate <= .05, 'sit reversal stays within 50ms of current drawing');
      await settle();
      await page.evaluate(() => BallUI.pointer('drop')); await page.clock.runFor(2600);
      current = await info();
      if (current.wholeBodyMotion) assert.ok(current.wholeBodyMotion.frame / frameRate >= .55, 'wake never replays closed-eye lead-in');
      await page.clock.runFor(3200);
      const before = await info();
      assert.equal(before.wholeBodyMotion.clip, 'wake');
      await page.evaluate(() => BallUI.bubble('think', '正在处理')); await page.clock.runFor(40);
      const after = await info();
      assert.equal(after.wakePhase, '', 'task is not blocked by decoration');
      assert.equal(after.wholeBodyMotion.clip, 'wake', 'body continues same whole-body clip after task starts');
      assert.ok(after.wholeBodyMotion.frame >= before.wholeBodyMotion.frame
        && (after.wholeBodyMotion.frame - before.wholeBodyMotion.frame) / frameRate <= .1, 'task cannot reset wake pose');
      await page.clock.runFor(4500);
      assert.equal((await info()).wholeBodyMotion, null);
      assert.equal((await info()).sleep, 0);
      await page.evaluate(() => { BallUI.bubbleDone(); BallUI.react('stretch', 'sleepy'); });
      await page.clock.runFor(1000);
      const stretched = await info();
      assert.equal(stretched.wholeBodyMotion.clip, 'stretch');
      await page.evaluate(() => BallUI.setListening(true)); await page.clock.runFor(300);
      const returning = await info();
      assert.equal(returning.wholeBodyMotion.clip, 'stretch', 'interrupted hands return through complete drawings, not a 180ms snap');
      assert.ok(returning.wholeBodyMotion.frame >= stretched.wholeBodyMotion.frame);
      await page.clock.runFor(2500);
      assert.equal((await info()).gesture, '');
      assert.equal((await info()).wholeBodyMotion, null);
      await page.evaluate(() => { BallUI.setListening(false); BallUI.idleStage(1); });
      await page.clock.runFor(1800);
      await page.evaluate(() => BallUI.idleStage(3)); await page.clock.runFor(2000);
      const halfLie = await info();
      assert.equal(halfLie.wholeBodyMotion.clip, 'lie');
      await page.evaluate(() => BallUI.setListening(true)); await page.clock.runFor(50);
      assert.equal((await info()).wholeBodyMotion.clip, 'lie', 'task during partial lie keeps supported pose');
      await page.clock.runFor(2000);
      current = await info();
      assert.equal(current.wholeBodyMotion.clip, 'sit', 'partial-prone task recovery lifts before standing');
      await page.clock.runFor(2000);
      assert.equal((await info()).amount, 0);
      assert.equal((await info()).sleep, 0);
      await settle();
      await page.evaluate(() => BallUI.pointer('drop')); await page.clock.runFor(6200);
      const reversing = await info();
      assert.equal(reversing.wholeBodyMotion.clip, 'wake');
      await page.evaluate(() => BallUI.idleStage(3)); await page.clock.runFor(50);
      const returningSleep = await info();
      assert.equal(returningSleep.wholeBodyMotion.clip, 'wake', 'reverse a moving rise in the same drawings');
      assert.ok(returningSleep.wholeBodyMotion.frame <= reversing.wholeBodyMotion.frame
        && (reversing.wholeBodyMotion.frame - returningSleep.wholeBodyMotion.frame) / frameRate <= .1);
      await page.clock.runFor(4500);
      assert.equal((await info()).sleep, 1);
      samples.push({ fallback, sitFrame, yawning: { progress: yawning.yawnProgress,
          expression: yawning.expression, mix: yawning.expressionMix }, taskWakeBefore: before.wholeBodyMotion,
        taskWakeAfter: after.wholeBodyMotion, interruptedStretch: returning.wholeBodyMotion });
      await page.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync('build/character-motion-joins.json', JSON.stringify({ passed: true, samples }, null, 2));
    console.log(JSON.stringify({ passed: true, renderers: samples.length, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
