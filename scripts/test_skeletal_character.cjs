const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], results = [];
  try {
    for (const fallback of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      if (fallback) await context.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return /^webgl/.test(type) ? null : original.call(this, type, ...args);
        };
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.text().startsWith('clipped pose')) console.error(message.text()); });
      await page.goto(base + 'ball-web/composer.html?preview=300');
      await page.locator('#bar.figure-ready').waitFor();
      await page.waitForFunction(() => window.BallUI.characterInfo()
        && window.BallUI.characterInfo().skeletal === true);
      await page.evaluate(() => dispatchEvent(new Event('pagehide')));
      const metrics = await page.evaluate(async () => {
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        document.body.innerHTML = '<main id="gallery" style="display:flex;flex-wrap:wrap;width:1200px;background:#dce4eb"></main>';
        document.body.style.cssText = 'overflow:auto;background:#dce4eb';
        const renderer = await SkeletalCharacter.create(new URL('./reference/', location.href));
        window.skeletalTest = { renderer, root };
        let sitReferenceBlend = 0, sleepReferenceBlend = 0;
        const poseFits = {};
        function capture(label, options) {
          renderer.draw(root, null, { t: 0, expression: 'neutral', ...options });
          const currentInfo = renderer.info(), blend = currentInfo.referencePoseBlend;
          poseFits[label] = { scale: currentInfo.stageScale, limiting: currentInfo.stageFit };
          if (options.sit === 1 && !options.sleep) sitReferenceBlend = blend.sit;
          if (options.sleep === 1) sleepReferenceBlend = blend.sleep;
          const canvases = root.querySelectorAll('canvas');
          const composite = document.createElement('canvas'); composite.width = composite.height = 768;
          const compositeContext = composite.getContext('2d');
          compositeContext.globalAlpha = Number(canvases[0].style.opacity || 1);
          compositeContext.drawImage(canvases[0], 0, 0);
          compositeContext.globalAlpha = 1;
          if (canvases[1]) compositeContext.drawImage(canvases[1], 0, 0);
          const item = document.createElement('div'); item.style.cssText = 'width:200px;height:226px;text-align:center;font:14px sans-serif';
          const img = document.createElement('img'); img.src = composite.toDataURL(); img.width = img.height = 200;
          item.append(img, document.createTextNode(label)); document.getElementById('gallery').appendChild(item);
        }
        capture('\u7ad9\u7acb', {});
        for (const sit of [.25, .5, .75, 1]) capture('\u5750\u4e0b ' + sit, { sit });
        capture('\u6253\u778c\u7761', { sit: 1, drowsy: true, expression: 'sleepy', t: 1 });
        for (const sleep of [.25, .5, .75, 1]) capture('\u8db4\u4e0b ' + sleep, { sit: 1, sleep, expression: 'sleepy' });
        capture('\u6325\u624b', { gesture: { kind: 'wave', k: .5 }, expression: 'happy' });
        capture('\u4f38\u61d2\u8170', { gesture: { kind: 'stretch', k: .5 }, expression: 'sleepy' });
        capture('\u4fa7\u8eab', { gesture: { kind: 'sideLook', k: .5 } });
        capture('\u70b9\u5934', { gesture: { kind: 'nod', k: .38 } });
        capture('\u6b6a\u5934', { gesture: { kind: 'tilt', k: .5 } });
        let maxBoneLengthError = 0, maxFootHeightError = 0, maxFootErrorAt = null, clippedEdgePixels = 0;
        let minStageScale = 1, minStageAt = null;
        let maxJointStep = 0, maxJointStepAt = null;
        const previousJoints = new Map();
        const boundsCanvas = document.createElement('canvas'); boundsCanvas.width = boundsCanvas.height = 768;
        const boundsContext = boundsCanvas.getContext('2d');
        const footHeights = new Map();
        const lengths = new Map();
        for (let step = 0; step <= 100; step++) {
          for (const options of [{ phase: 'sit', sit: step / 100 }, { phase: 'sleep', sit: 1, sleep: step / 100 }]) {
            renderer.draw(root, null, { t: 0, ...options });
            const info = renderer.info(), joints = new Map(info.joints.map(joint => [joint.name, joint]));
            if (info.stageScale < minStageScale) {
              minStageScale = info.stageScale;
              minStageAt = { phase: options.phase, step: step / 100, fit: info.stageFit };
            }
            if (step % 5 === 0) {
              const beforeEdges = clippedEdgePixels;
              boundsContext.clearRect(0, 0, 768, 768);
              const canvases = root.querySelectorAll('canvas');
              boundsContext.globalAlpha = Number(canvases[0].style.opacity || 1);
              boundsContext.drawImage(canvases[0], 0, 0);
              boundsContext.globalAlpha = 1;
              if (canvases[1]) boundsContext.drawImage(canvases[1], 0, 0);
              const pixels = boundsContext.getImageData(0, 0, 768, 768).data;
              for (let j = 0; j < 768; j++) {
                for (const k of [j, 767 * 768 + j, j * 768, j * 768 + 767]) {
                  if (pixels[k * 4 + 3] > 100) clippedEdgePixels++;
                }
              }
              if (clippedEdgePixels > beforeEdges) {
                const bounds = renderer.auditGeometry().bounds.filter(part => part.minX < 0 || part.minY < 0
                  || part.maxX > 256 || part.maxY > 256).map(({ name, minX, minY, maxX, maxY }) =>
                  ({ name, minX: Math.round(minX), minY: Math.round(minY), maxX: Math.round(maxX), maxY: Math.round(maxY) }));
                console.warn('clipped pose ' + JSON.stringify(options) + ' parts=' + JSON.stringify(bounds));
              }
            }
            for (const joint of joints.values()) {
              const key = options.phase + ':' + joint.name;
              const previous = previousJoints.get(key);
              if (previous) {
                const travel = Math.hypot(joint.x - previous.x, joint.y - previous.y, joint.z - previous.z);
                if (travel > maxJointStep) {
                  maxJointStep = travel;
                  maxJointStepAt = { phase: options.phase, step, joint: joint.name };
                }
              }
              previousJoints.set(key, joint);
              if (!options.sleep && /^foot/.test(joint.name)) {
                if (!footHeights.has(joint.name)) footHeights.set(joint.name, joint.y);
                const error = Math.abs(joint.y - footHeights.get(joint.name));
                if (error > maxFootHeightError) {
                  maxFootHeightError = error;
                  maxFootErrorAt = { name: joint.name, y: joint.y, expected: footHeights.get(joint.name), options };
                }
              }
              if (joint.scale.some(value => value !== 1)) throw new Error('A bone was scaled');
              const parent = joints.get(joint.parent);
              if (!parent) continue;
              const length = Math.hypot(joint.x - parent.x, joint.y - parent.y, joint.z - parent.z) / info.stageScale;
              if (!lengths.has(joint.name)) lengths.set(joint.name, length);
              maxBoneLengthError = Math.max(maxBoneLengthError, Math.abs(length - lengths.get(joint.name)));
            }
          }
        }
        const canvases = root.querySelectorAll('canvas'), canvas = canvases[0], copy = document.createElement('canvas');
        copy.width = copy.height = 768;
        const ctx = copy.getContext('2d'); ctx.globalAlpha = Number(canvas.style.opacity || 1); ctx.drawImage(canvas, 0, 0);
        ctx.globalAlpha = 1; if (canvases[1]) ctx.drawImage(canvases[1], 0, 0);
        const pixels = ctx.getImageData(0, 0, 768, 768).data;
        let nonblank = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 100) nonblank++;
        return { renderer: renderer.info().renderer, bones: renderer.info().bones,
          layers: renderer.info().layers, maxBoneLengthError, maxFootHeightError, maxFootErrorAt,
          clippedEdgePixels, nonblank, poseImagesBlended: renderer.info().poseImagesBlended,
          minStageAt,
          sitReferenceBlend, sleepReferenceBlend, minStageScale, poseFits, maxJointStep, maxJointStepAt };
      });
      await page.screenshot({ path: 'build/skeleton-gallery-' + (fallback ? 'canvas' : 'webgl') + '.png', fullPage: true });
      console.log(JSON.stringify(metrics));
      assert.equal(metrics.bones, 29);
      assert.equal(metrics.layers, 21);
      assert.equal(metrics.poseImagesBlended, 0);
      assert.equal(metrics.sitReferenceBlend, 1, 'seated endpoint must settle onto its current reference pose');
      assert.equal(metrics.sleepReferenceBlend, 1, 'sleep endpoint must settle onto its current reference pose');
      assert.ok(metrics.maxBoneLengthError < 1e-6);
      assert.ok(metrics.maxJointStep < 12, 'joints must not snap between adjacent frames: '
        + JSON.stringify(metrics.maxJointStepAt));
      assert.ok(metrics.maxFootHeightError < 1e-6,
        'feet stay planted during sitting and rising: ' + JSON.stringify(metrics.maxFootErrorAt));
      assert.ok(metrics.minStageScale >= 0.999,
        'character size must remain stable during every pose: ' + JSON.stringify(metrics.minStageAt));
      assert.equal(metrics.clippedEdgePixels, 0, 'hair and limbs must remain inside the canvas');
      assert.ok(metrics.nonblank > 10000);
      await page.screenshot({ path: 'build/skeleton-gallery-' + (fallback ? 'canvas' : 'webgl') + '.png', fullPage: true });
      results.push(metrics);
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync('build/skeleton-test-results.json', JSON.stringify({ passed: true, results }, null, 2));
    console.log(JSON.stringify({ passed: true, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
