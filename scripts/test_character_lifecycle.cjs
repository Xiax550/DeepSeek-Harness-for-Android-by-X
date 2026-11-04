const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/';
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const results = [];
  try {
    for (const fallback of [false, true]) {
      const page = await browser.newPage();
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          return /^webgl/.test(type) ? null : get.call(this, type, ...args);
        };
      });
      await page.goto(base + 'ball-web/composer.html?preview=300');
      await page.locator('#bar.figure-ready').waitFor();
      const result = await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        const rig = await ReferenceCharacter.create(new URL('./reference/', location.href));
        const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const copy = document.createElement('canvas'); copy.width = copy.height = 768;
        const ctx = copy.getContext('2d');
        function frame(previousExpression, expression, expressionMix) {
          rig.draw(root, null, { t: 0, previousExpression, expression, expressionMix });
          ctx.clearRect(0, 0, 768, 768); ctx.drawImage(root.querySelector('canvas'), 0, 0);
          return ctx.getImageData(0, 0, 768, 768).data;
        }
        function diff(a, b) {
          let changed = 0;
          for (let i = 0; i < a.length; i += 4)
            if (Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]) > 12) changed++;
          return changed;
        }
        const identity = diff(frame('happy', 'happy', 1), frame('happy', 'happy', .5));
        const symmetry = diff(frame('happy', 'sleepy', .5), frame('sleepy', 'happy', .5));
        const canvas = root.querySelector('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        rig.dispose(); rig.dispose(); rig.draw(root, null, {});
        await new Promise(resolve => setTimeout(resolve, 50));
        const getContext = HTMLCanvasElement.prototype.getContext;
        const failedContexts = new Set();
        let failedAssetRejected = false;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          const context = getContext.call(this, type, ...args);
          if (/^webgl/.test(type) && context) failedContexts.add(context);
          return context;
        };
        const part = REFERENCE_MODEL.views['stand-front'], file = part.file;
        try {
          part.file = 'intentional-missing-regression-layer.png';
          await ReferenceCharacter.create(new URL('./reference/', location.href));
        } catch (error) { failedAssetRejected = /Reference image missing/.test(String(error)); }
        finally {
          part.file = file;
          HTMLCanvasElement.prototype.getContext = getContext;
        }
        return { identity, symmetry, detached: !root.querySelector('canvas'),
          contextReleased: gl ? gl.isContextLost() : true,
          failedAssetRejected, failedContexts: failedContexts.size,
          failedContextsReleased: [...failedContexts].every(context => context.isContextLost()) };
      });
      results.push({ fallback, ...result });
      await page.close();
    }
    console.log(JSON.stringify(results, null, 2));
    for (const r of results) {
      assert.equal(r.identity, 0, 'an unchanged expression must not flash the neutral face');
      assert.equal(r.symmetry, 0, 'crossfade midpoint cannot depend on transition direction');
      assert.equal(r.detached, true);
      assert.equal(r.contextReleased, true, 'disposed rigs must release their WebGL context');
      assert.equal(r.failedAssetRejected, true);
      assert.equal(r.failedContexts, 0, 'reference assets load before any GPU context is allocated');
      assert.equal(r.failedContextsReleased, true, 'asset failures must also release their context');
    }
    fs.writeFileSync('build/character-lifecycle-results.json', JSON.stringify({ passed: true, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
