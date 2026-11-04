const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try {
    for (const fallback of [false, true]) {
      const page = await browser.newPage();
      if (fallback) await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(t, ...args) { return /^webgl/.test(t) ? null : get.call(this,t,...args); };
      });
      const now = new Date('2026-11-04T12:00:00+08:00');
      await page.clock.install({time:now}); await page.clock.pauseAt(now);
      await page.goto((process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/')+'ball-web/composer.html');
      await page.locator('#bar.figure-ready').waitFor();
      await page.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        window.testRig = await SkeletalCharacter.create(new URL('./reference/',location.href));
        window.testRoot = document.createElement('div'); document.body.append(testRoot);
        window.drawTest = options => testRig.draw(testRoot,null,{smoothJoins:true,...options});
        window.pixels = () => {
          const c = document.createElement('canvas'); c.width=c.height=768;
          const ctx=c.getContext('2d');
          testRoot.querySelectorAll('canvas').forEach(a=>{ctx.globalAlpha=Number(a.style.opacity||1);ctx.drawImage(a,0,0);});
          return c.toDataURL();
        };
        drawTest({wholeBodyWake:.9999});
        window.previousPixels=pixels(); drawTest({});
      });
      assert.equal(await page.evaluate(()=>testRig.info().motionJoinActive),true);
      assert.equal(await page.evaluate(()=>pixels()===previousPixels),true,'join starts at the previous complete drawing');
      await page.clock.runFor(130); await page.evaluate(()=>drawTest({}));
      assert.equal(await page.evaluate(()=>testRig.info().motionJoinActive),true);
      await page.clock.runFor(140); await page.evaluate(()=>drawTest({}));
      assert.equal(await page.evaluate(()=>testRig.info().motionJoinActive),false);
      assert.equal(await page.evaluate(()=>{const a=pixels();drawTest({smoothJoins:false});return pixels()===a;}),true,'settled pixels exactly match static pose');
      assert.equal(await page.evaluate(()=>{drawTest({wholeBodyWake:.5});drawTest({});return testRig.info().motionJoinActive;}),false,'do not blend unrelated midposes');
      assert.equal(await page.evaluate(()=>{drawTest({wholeBodyWake:.9999});drawTest({sit:1,sleep:1});return testRig.info().motionJoinActive;}),false,'endpoint must match target posture');
      assert.equal(await page.evaluate(()=>{drawTest({wholeBodyWake:.9999});drawTest({reducedMotion:true});return testRig.info().motionJoinActive;}),false);
      for (const [fixed, moving] of [[{}, {sit:.001}], [{sit:1}, {sit:1,sleep:.001}],
        [{sit:1,sleep:1}, {sit:1,sleep:1,wholeBodyWake:.001}]]) {
        const state=await page.evaluate(({fixed,moving})=>{
          drawTest({...fixed,smoothJoins:false});const before=pixels();drawTest(moving);
          return {same:pixels()===before,entry:testRig.info().motionEntryActive,needsFrame:testRig.needsFrame()};
        },{fixed,moving});
        assert.deepEqual(state,{same:true,entry:true,needsFrame:true},'entry retains exact approved pose on first frame');
        await page.clock.runFor(130);await page.evaluate(moving=>drawTest(moving),moving);
        assert.equal(await page.evaluate(()=>testRig.info().motionEntryActive),true);
        await page.clock.runFor(140);await page.evaluate(moving=>drawTest(moving),moving);
        assert.equal(await page.evaluate(()=>testRig.info().motionEntryActive),false);
      }
      await page.evaluate(()=>testRig.dispose()); await page.close();
    }
    console.log(JSON.stringify({passed:true,renderers:2,joinMs:260}));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
