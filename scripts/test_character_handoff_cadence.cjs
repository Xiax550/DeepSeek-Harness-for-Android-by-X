const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const samples=[];
  try {
    for (const fallback of [false,true]) {
      const page=await browser.newPage();
      if(fallback)await page.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext=function(t,...a){return /^webgl/.test(t)?null:get.call(this,t,...a);};});
      const now=new Date('2026-11-04T12:00:00+08:00');
      await page.clock.install({time:now});await page.clock.pauseAt(now);
      await page.goto((process.env.DHA_CHARACTER_PREVIEW||'http://127.0.0.1:18767/')+'ball-web/composer.html');
      await page.locator('#bar.figure-ready').waitFor();
      for(const [stage,before] of [[1,1600],[3,5100]]) {
        await page.evaluate(s=>BallUI.idleStage(s),stage);await page.clock.runFor(before);
        const start=await page.evaluate(()=>BallUI.restInfo().frames);
        let last=start,gap=0,maxGap=0,joined=false;
        for(let t=0;t<350;t+=10) {
          await page.clock.runFor(10);
          const s=await page.evaluate(()=>({frames:BallUI.restInfo().frames,join:BallUI.characterInfo().motionJoinActive}));
          gap+=10;if(s.frames!==last){maxGap=Math.max(maxGap,gap);gap=0;last=s.frames;}
          joined ||= s.join;
        }
        assert.equal(joined,true,'matching pose exit uses a smooth handoff');
        assert.ok(maxGap<=40,'no idle-rate pause during handoff: '+maxGap);
        assert.ok(last-start>=16,'handoff continues drawing instead of a one-second stall');
        samples.push({fallback,stage,maxGap,frames:last-start});
        await page.clock.runFor(2000);
      }
      await page.close();
    }
    console.log(JSON.stringify({passed:true,samples}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
