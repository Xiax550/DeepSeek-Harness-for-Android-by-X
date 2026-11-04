const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';
const actions = ['earTwitch', 'nod', 'tilt', 'wave', 'stretch', 'sideLook'];

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1150, height: 820 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + 'ball-web/composer.html?preview=300');
    await page.locator('#bar.figure-ready').waitFor();
    await page.evaluate(() => ComposerUI.open());
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => BallUI.characterInfo().gesture), 'wave', 'opening must visibly greet even with expanded input');
    assert.equal(await page.evaluate(() => BallUI.characterInfo().expression), 'happy');
    for (const state of ['voice', 'watch', 'task', 'rest']) {
      await page.evaluate(state => {
        BallUI.collapse(); BallUI.collapseDone(); BallUI.bubbleDone();
        if (state === 'voice') BallUI.setListening(true);
        if (state === 'watch') BallUI.watchActive(true);
        if (state === 'task') BallUI.bubble('think', '正在处理');
        if (state === 'rest') BallUI.resting(true);
      }, state);
      assert.equal(await page.evaluate(() => BallUI.react('wave')), false, state + ' blocks idle action');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => BallUI.characterInfo().gesture), '');
      await page.evaluate(() => {
        BallUI.setListening(false); BallUI.watchActive(false); BallUI.bubbleDone(); BallUI.resting(false);
      });
    }
    // Freeze host scheduling, then render deterministic frames using the real renderer.
    const metrics = await page.evaluate(async actions => {
      dispatchEvent(new Event('pagehide'));
      document.body.innerHTML = '<main id="gallery" style="display:flex;flex-wrap:wrap;background:#e5e9ed;width:1120px"></main>';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const root = document.createElementNS(svg.namespaceURI, 'g');
      svg.appendChild(root); document.body.appendChild(svg);
      const renderer = await ReferenceCharacter.create(new URL('./reference/', location.href));
      let invertedTriangles = 0, auditedTriangles = 0, rigidEdgeError = 0;
      function frame(label, options) {
        renderer.draw(root, null, { t: 0, sit: 0, expression: 'neutral', ...options });
        const audit = renderer.auditGeometry();
        invertedTriangles += audit.invertedHairTriangles;
        auditedTriangles += audit.triangles;
        rigidEdgeError = Math.max(rigidEdgeError, audit.rigidEdgeError);
        const source = root.querySelector('canvas');
        const copy = document.createElement('canvas'); copy.width = copy.height = 256;
        const ctx = copy.getContext('2d'); ctx.drawImage(source, 0, 0, 256, 256);
        const item = document.createElement('div'); item.style.cssText = 'width:180px;text-align:center;font:14px sans-serif';
        const image = document.createElement('img'); image.src = copy.toDataURL(); image.width = image.height = 180;
        item.append(image, document.createTextNode(label)); document.getElementById('gallery').appendChild(item);
        return ctx.getImageData(0, 0, 256, 256).data;
      }
      function diff(a, b, faceOnly) {
        let count = 0;
        for (let y = faceOnly ? 60 : 0; y < (faceOnly ? 104 : 256); y++) {
          for (let x = faceOnly ? 95 : 0; x < (faceOnly ? 165 : 256); x++) {
            const i = (y * 256 + x) * 4;
            if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 25) count++;
          }
        }
        return count;
      }
      const neutral = frame('neutral', {}), actionChanges = {}, expressionChanges = {};
      for (const kind of actions) {
        actionChanges[kind] = diff(neutral, frame(kind, { gesture: { kind, k: .38 } }));
        const start = frame(kind + ' start', { gesture: { kind, k: 0 } });
        const end = frame(kind + ' end', { gesture: { kind, k: 1 } });
        if (diff(neutral, start) || diff(neutral, end)) throw new Error(kind + ' snaps at endpoint');
      }
      for (const expression of renderer.info().expressions.filter(x => x !== 'neutral')) {
        expressionChanges[expression] = diff(neutral, frame(expression, { expression }), true);
      }
      for (const kind of ['wave', 'tilt', 'sideLook']) {
        for (const k of [0, .2, .4, .6, .8, 1]) frame(kind + ' ' + k, { gesture: { kind, k }, expression: 'happy' });
      }
      for (let i = 0; i < 30; i++) frame('cache', { expression: i % 2 ? 'happy' : 'curious', sit: i % 2 });
      for (let i = 0; i <= 20; i++) {
        frame('cache', { sit: i / 20 });
        frame('cache', { sit: 1, sleep: i / 20, drowsy: true, expression: 'sleepy' });
      }
      const textures = renderer.info().expressionTextureCount;
      // Keep just representative frames in the visual evidence.
      [...document.querySelectorAll('#gallery > div')].forEach(el => {
        if (/start|end|cache/.test(el.textContent)) el.remove();
      });
      const canvas = root.querySelector('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const extension = gl.getExtension('WEBGL_lose_context');
      let restoredPixels = 0;
      if (extension) {
        extension.loseContext();
        await new Promise(r => setTimeout(r, 120));
        extension.restoreContext();
        await new Promise(r => setTimeout(r, 300));
        const pixels = frame('restored', { expression: 'happy' });
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 100) restoredPixels++;
      }
      const restoredTextures = renderer.info().expressionTextureCount;
      renderer.dispose(); svg.remove();
      return { actionChanges, expressionChanges, textures, restoredTextures, invertedTriangles, auditedTriangles, rigidEdgeError, restoredPixels };
    }, actions);
    for (const [name, changed] of Object.entries(metrics.actionChanges)) assert.ok(changed > 25, name + ' must visibly change rendered frame');
    for (const [name, changed] of Object.entries(metrics.expressionChanges)) assert.ok(changed > 10, name + ' must alter reference face');
    assert.ok(metrics.textures <= 2 && metrics.restoredTextures <= 2, 'expression texture cache must be bounded through context restore');
    assert.equal(metrics.invertedTriangles, 0, 'actions and rest/sleep transitions must not fold mesh triangles');
    assert.ok(metrics.auditedTriangles > 10000);
    assert.ok(metrics.rigidEdgeError < 1e-5, 'head and limbs cannot stretch');
    assert.ok(metrics.restoredPixels > 1000, 'context restoration must actually render the character');
    await page.screenshot({ path: 'build/reference-reactions-gallery.png', fullPage: true });
    await page.close();

    const scheduled = await browser.newPage();
    scheduled.on('pageerror', e => errors.push(e.message));
    const virtualNow = new Date('2026-11-01T12:00:00+08:00');
    await scheduled.clock.install({ time: virtualNow });
    await scheduled.clock.pauseAt(virtualNow);
    await scheduled.addInitScript(() => { Math.random = () => .1; });
    await scheduled.goto(base + 'ball-web/composer.html?preview=300');
    await scheduled.locator('#bar.figure-ready').waitFor();
    await scheduled.clock.runFor(4050);
    assert.equal(await scheduled.evaluate(() => BallUI.characterInfo().expression), 'blink', 'natural blink is driven by the live host');
    await scheduled.clock.runFor(2550);
    assert.notEqual(await scheduled.evaluate(() => BallUI.characterInfo().gesture), '', 'first idle action occurs without user input');
    await scheduled.evaluate(() => BallUI.resting(true));
    await scheduled.clock.runFor(5000);
    assert.equal(await scheduled.evaluate(() => BallUI.characterInfo().expression), 'neutral');
    assert.equal(await scheduled.evaluate(() => BallUI.characterInfo().gesture), '');
    const before = await scheduled.evaluate(() => BallUI.restInfo().frames);
    await scheduled.clock.runFor(4000);
    assert.ok((await scheduled.evaluate(() => BallUI.restInfo().frames)) - before <= 5, 'expressions must preserve low-power rest');
    await scheduled.evaluate(() => BallUI.resting(false));
    await scheduled.clock.runFor(6600);
    assert.notEqual(await scheduled.evaluate(() => BallUI.characterInfo().gesture), '', 'waking reschedules idle actions');
    await scheduled.clock.runFor(3000);
    await scheduled.evaluate(() => { BallUI.pointer('drop'); });
    await scheduled.clock.runFor(100);
    assert.equal(await scheduled.evaluate(() => BallUI.characterInfo().expression), 'surprised', 'drag release reacts');
    await scheduled.evaluate(() => dispatchEvent(new Event('pagehide')));
    assert.equal(await scheduled.evaluate(() => BallUI.react('wave')), false, 'hidden page cannot start actions');
    await scheduled.close();

    for (const fallback of [false, true]) {
      const context = await browser.newContext({ reducedMotion: 'reduce' });
      if (fallback) await context.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return /^webgl/.test(type) ? null : original.call(this, type, ...args);
        };
      });
      const mobile = await context.newPage();
      mobile.on('pageerror', e => errors.push(e.message));
      await mobile.goto(base + 'ball-web/composer.html?preview=300');
      await mobile.locator('#bar.figure-ready').waitFor();
      await mobile.evaluate(() => ComposerUI.open());
      await mobile.waitForFunction(() => BallUI.characterInfo().expression === 'happy', null, { timeout: 2000 });
      const info = await mobile.evaluate(() => BallUI.characterInfo());
      assert.equal(info.gesture, '', 'reduced motion must suppress actions');
      assert.equal(info.expression, 'happy', 'expressions still work without animation/WebGL');
      await mobile.screenshot({ path: 'build/reference-reaction-' + (fallback ? 'fallback' : 'reduced') + '.png' });
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, ...metrics, clickGreeting: true, scheduledIdle: true,
      busyRestProtection: true, reducedMotionAndFallback: true }, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
