const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const previewUrl = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18764/';

(async function () {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.DHA_CHROMIUM || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--allow-file-access-from-files']
  });
  const errors = [];
  const oldAssetRequests = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/ball-web\/(coo|lilac)\//.test(request.url())) oldAssetRequests.push(request.url()); });
  page.on('console', message => {
    if (message.type() === 'error' && !message.location().url.includes('favicon.ico')) {
      errors.push(message.text() + ' @ ' + message.location().url);
    }
  });
  page.on('response', response => {
    if (response.status() >= 400 && !response.url().includes('favicon.ico')) {
      errors.push(response.status() + ' ' + response.url());
    }
  });

  try {
    await page.goto(previewUrl, { waitUntil: 'networkidle' });
    const compact = page.frameLocator('iframe[title="Compact"]');
    await compact.locator('#bar.figure-ready').waitFor({ timeout: 10000 });
    const character = await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.characterInfo());
    assert.equal(character.sourceOnly, true);
    assert.deepEqual(character.previousAssets, []);
    assert.equal(character.referencePoses, true);
    assert.ok(character.views.includes('sit-front'));
    assert.ok(character.views.includes('sleep-front'));
    assert.equal(await compact.locator('#figureMirror').getAttribute('transform'), '');
    const bodyPixels = await compact.locator('#figureRoot canvas').first().evaluate(canvas => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
      let lower = 0, feet = 0;
      for (let y = Math.floor(copy.height * .65); y < copy.height; y++) {
        for (let x = 0; x < copy.width; x++) {
          if (data[(y * copy.width + x) * 4 + 3] > 100) {
            lower++;
            if (y > copy.height * .88) feet++;
          }
        }
      }
      return { lower, feet };
    });
    assert.ok(bodyPixels.lower > 0 && bodyPixels.feet > 0, 'full body must include skirt and feet, not a head-only crop');
    await page.screenshot({ path: 'build/character-preview-left.png', fullPage: true });
    await page.frameLocator('iframe[title="Inspection"]').locator('#figureDoll').screenshot({ path: 'build/reference-standing.png' });
    // Read the browser-composited screenshot, not just the offscreen GL buffer.
    const screenshot = await compact.locator('#figureDoll').screenshot();
    const composedPixels = await page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 2] - pixels[i] > 20 && pixels[i + 2] - pixels[i + 1] > 12) colored++;
      }
      bitmap.close();
      return colored;
    }, Array.from(screenshot));
    assert.ok(composedPixels > 20, 'character must be visible in actual SVG composition, not just its canvas buffer');

    await compact.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.ComposerUI.side('right');
      w.ComposerUI.side('left');
    });
    await page.waitForTimeout(250);
    assert.equal(await compact.locator('#figureMirror').getAttribute('transform'), '', 'cancel a pending turn when moving back');

    await page.evaluate(() => side('right'));
    await page.waitForFunction(() => {
      const frame = document.querySelector('iframe[title="Compact"]');
      return frame.contentDocument.querySelector('#figureMirror').getAttribute('transform') === '';
    });
    await page.waitForTimeout(1100);
    await page.screenshot({ path: 'build/character-preview-right.png', fullPage: true });

    const interactive = page.frameLocator('iframe#interactive');
    await page.getByRole('button', { name: 'Input' }).click();
    await interactive.locator('#bar.open').waitFor({ timeout: 3000 });
    await interactive.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.DshComposer.send = text => { w.__sentText = text; };
    });
    await interactive.locator('#text').fill('预览输入测试');
    await interactive.locator('#text').press('Enter');
    assert.equal(await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.__sentText), '预览输入测试');
    await interactive.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.BallUI.collapse();
      w.BallUI.collapseDone();
    });

    await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.ComposerUI.watchActive(true));
    await interactive.locator('#bar.watch-on').waitFor({ timeout: 1000 });
    assert.equal(await interactive.locator('#ring').evaluate(el => getComputedStyle(el).display), 'block');
    await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.ComposerUI.watchActive(false));

    await page.getByRole('button', { name: 'Result' }).click();
    const result = interactive.locator('#bubbleText');
    await result.waitFor({ state: 'visible', timeout: 3000 });
    const before = await interactive.locator('#bar').evaluate(el => JSON.parse(el.ownerDocument.defaultView.BallUI.resultInfo()));
    assert.ok(before.max > 0, 'long results must have a scrollable viewport');
    await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.scrollResult(500));
    const after = await interactive.locator('#bar').evaluate(el => JSON.parse(el.ownerDocument.defaultView.BallUI.resultInfo()));
    assert.ok(after.top > 0, 'result scrolling must advance the text');
    await page.screenshot({ path: 'build/character-preview-result.png', fullPage: true });

    await interactive.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.BallUI.bubbleDone();
      w.BallUI.collapseDone();
    });
    await page.getByRole('button', { name: 'Rest', exact: true }).click();
    await page.waitForTimeout(500);
    const transition = await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo());
    assert.ok(transition.amount > .03 && transition.amount < .8, 'sit transition must have an intermediate pose');
    assert.equal(transition.transitioning, true);
    await page.screenshot({ path: 'build/character-preview-transition.png', fullPage: true });
    await page.waitForTimeout(1800);
    const seated = await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo());
    assert.equal(seated.resting, true);
    assert.ok(seated.amount > .98, 'seated pose must settle before throttling');
    await page.waitForTimeout(2300);
    const throttled = await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo());
    assert.ok(throttled.frames - seated.frames <= 4, 'resting uses timed low-frequency frames, not a 60Hz RAF loop');
    await page.screenshot({ path: 'build/character-preview-seated.png', fullPage: true });
    await page.frameLocator('iframe[title="Inspection"]').locator('#figureDoll').screenshot({ path: 'build/reference-seated.png' });
    await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.resting(false));
    await page.waitForTimeout(400);
    const rising = await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo());
    assert.ok(rising.amount > .1 && rising.amount < .99, 'wake must smoothly rise instead of jumping');
    await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.resting(true));
    const reversal = await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo());
    assert.ok(Math.abs(reversal.amount - rising.amount) < .08, 'interrupted transition must reverse without jumping');
    await page.waitForTimeout(1900);
    await compact.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.dispatchEvent(new Event('pagehide'));
      w.dispatchEvent(new Event('pageshow'));
      w.BallUI.resting(false);
    });
    const resumedBefore = await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo().frames);
    await page.waitForTimeout(250);
    const resumedAfter = await compact.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo().frames);
    assert.ok(resumedAfter > resumedBefore, 'returning from page cache must resume rendering');

    await interactive.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.ComposerUI.watchActive(true);
      w.BallUI.resting(true);
    });
    assert.equal(await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo().resting), false);
    await interactive.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.ComposerUI.watchActive(false);
      w.BallUI.setListening(true);
      w.BallUI.resting(true);
    });
    assert.equal(await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo().resting), false);
    await interactive.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.BallUI.setListening(false);
      w.BallUI.resting(true);
      w.BallUI.bubble('think', '正在处理');
      w.BallUI.resting(true);
    });
    assert.equal(await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo().resting), false,
      'active task must wake the character and reject rest');
    await interactive.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.BallUI.bubbleDone();
      for (let i = 0; i < 12; i++) {
        w.BallUI.resting(true);
        w.BallUI.resting(false);
      }
      w.BallUI.resting(true);
    });
    await page.waitForTimeout(2300);
    const rapidRest = await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo());
    await page.waitForTimeout(2300);
    const rapidAfter = await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo());
    assert.ok(rapidAfter.frames - rapidRest.frames <= 4, 'repeated wake/rest must not accumulate render loops');
    await interactive.locator('#bar').evaluate(el => {
      const w = el.ownerDocument.defaultView;
      w.BallUI.setListening(false);
      w.BallUI.resting(true);
      w.BallUI.pointer('down', 0, 0);
      w.BallUI.pointer('lift', 0, 0);
    });
    assert.equal(await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo().resting), false);
    await page.getByRole('button', { name: 'Input', exact: true }).click();
    await interactive.locator('#text').fill('保留未发送的文字');
    await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.resting(true));
    await interactive.locator('#text').press('End');
    assert.equal(await interactive.locator('#text').inputValue(), '保留未发送的文字');
    assert.equal(await interactive.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo().resting), false);

    for (const screenWidth of [320, 360, 412, 800]) {
      for (const side of ['left', 'right']) {
        const compact = await interactive.locator('#bar').evaluate((el, args) => {
          const w = el.ownerDocument.defaultView;
          w.frameElement.width = Math.min(300, Math.round(args.screenWidth * .64));
          w.frameElement.height = 108;
          w.ComposerUI.side(args.side);
          w.ComposerUI.open();
          el.classList.add('watchable');
          return new Promise(resolve => w.requestAnimationFrame(() => {
            const rect = id => w.document.getElementById(id).getBoundingClientRect();
            const pill = rect('inputPill');
            resolve({ height: pill.height, textWidth: rect('text').width,
              controlsInside: ['watch', 'close', 'send'].every(id => {
                const r = rect(id);
                return r.width >= 36 && r.left >= pill.left && r.right <= pill.right;
              }), dollWidth: rect('cap').width });
          }));
        }, { screenWidth, side });
        assert.equal(compact.height, 44, 'compact input height');
        assert.ok(compact.textWidth >= 75, 'usable field with all three controls');
        assert.ok(compact.controlsInside, 'compact controls remain visible and tappable');
        assert.equal(compact.dollWidth, 58, 'shrinking input must not resize the doll');
      }
    }

    assert.deepEqual(oldAssetRequests, [], 'no previous model texture, face or renderer may be requested');
    await page.close();
    const variants = [];
    for (const fallback of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3, reducedMotion: 'reduce' });
      if (fallback) await context.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return /^webgl/.test(type) ? null : get.call(this, type, ...args);
        };
      });
      const mobile = await context.newPage();
      mobile.on('pageerror', error => errors.push(error.message));
      await mobile.goto(previewUrl, { waitUntil: 'domcontentloaded' });
      const model = mobile.frameLocator('iframe[title="Compact"]');
      await model.locator('#bar.figure-ready').waitFor();
      const info = await model.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.characterInfo());
      assert.equal(info.renderer, fallback ? 'canvas-skeleton' : 'three-skeleton');
      await model.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.resting(true));
      await model.locator('#bar').evaluate(el => new Promise(resolve =>
        el.ownerDocument.defaultView.requestAnimationFrame(() =>
          el.ownerDocument.defaultView.requestAnimationFrame(resolve))));
      const rest = await model.locator('#bar').evaluate(el => el.ownerDocument.defaultView.BallUI.restInfo());
      assert.equal(rest.amount, 1, 'reduced motion must not force a long transition');
      await mobile.screenshot({ path: 'build/reference-mobile-' + (fallback ? 'fallback' : 'mesh') + '.png', fullPage: true });
      variants.push({ renderer: info.renderer, reducedMotion: true, deviceScaleFactor: 3 });
      await context.close();
    }
    const filePage = await browser.newPage();
    filePage.on('pageerror', error => errors.push(error.message));
    await filePage.goto(pathToFileURL(path.resolve(__dirname, '../payload/opt/dsh/android/ball-web/composer.html')).href);
    await filePage.locator('#bar.figure-ready').waitFor({ timeout: 10000 });
    assert.equal(await filePage.evaluate(() => BallUI.characterInfo().sourceOnly), true, 'local file loading must not depend on fetch(file://)');
    const customPath = path.resolve(__dirname, '../payload/opt/dsh/android/ball-web/reference/stand-front.png').replaceAll('\\', '/');
    await filePage.evaluate(source => {
      window.DshBall = { image: () => source };
      BallUI.refresh();
    }, customPath);
    await filePage.waitForFunction(() => !document.getElementById('bar').classList.contains('figure-ready'));
    assert.equal(await filePage.evaluate(() => BallUI.characterInfo()), null, 'custom images dispose the character instead of being covered');
    await filePage.waitForTimeout(150);
    await filePage.evaluate(source => {
      DshBall.image = () => ''; BallUI.refresh();
      DshBall.image = () => source; BallUI.refresh();
      DshBall.image = () => ''; BallUI.refresh();
    }, customPath);
    await filePage.locator('#bar.figure-ready').waitFor({ timeout: 10000 });
    await filePage.waitForTimeout(200);
    assert.equal(await filePage.locator('#figureRoot canvas').count(), 2, 'fast image switching must leave only the skeleton and reference layers');
    await filePage.close();
    if (errors.length) throw new Error('Browser errors: ' + errors.join(' | '));
    console.log(JSON.stringify({
      character, oldAssetRequests, bodyPixels, composedPixels, variants,
      left: 'visible', right: 'visible', inputExpanded: true,
      watchRing: 'active/inactive', resultScroll: after
      , idleRest: { seated: seated.amount, lowPowerFrames: throttled.frames - seated.frames,
        watchAndVoiceProtected: true, taskProtected: true, repeatedToggleSafe: true, interactionWake: true,
        transitionDurationMs: seated.durationMs, intermediatePose: transition.amount }
    }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
