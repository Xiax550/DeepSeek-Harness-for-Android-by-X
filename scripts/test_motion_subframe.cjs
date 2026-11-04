const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try {
    const page=await browser.newPage();
    await page.evaluate(() => {
      function atlas(colors) {
        const c=document.createElement('canvas');c.width=4;c.height=2;
        const x=c.getContext('2d');colors.forEach((color,i)=>{x.fillStyle=color;x.fillRect(i*2,0,1,2);});
        return c.toDataURL();
      }
      const images={'a.png':atlas(['red','red']),'b.png':atlas(['blue','blue'])};
      const NativeImage=window.Image;
      window.Image=class extends NativeImage {
        set src(value) {super.src=images[String(value).split('/').pop()];}
        get src() {return super.src;}
      };
      window.DHA_WHOLE_MOTION={size:2,columns:2,rows:1,framesPerAtlas:2,clips:{test:{frames:4,fps:1,knots:[[0,0],[1,3]],files:['a.png','b.png']}}};
    });
    await page.addScriptTag({content:fs.readFileSync('payload/opt/dsh/android/ball-web/reference/motion-player.js','utf8')});
    const result=await page.evaluate(async () => {
      const player=await WholeBodyMotion.create('https://example.invalid/');
      const c=document.createElement('canvas');c.width=c.height=2;const ctx=c.getContext('2d');
      const samples=[];
      for(const p of [.5,.45,.55,-1,2]) {
        ctx.clearRect(0,0,2,2);player.draw(ctx,'test',p,2,2);
        samples.push({p,pixel:Array.from(ctx.getImageData(0,0,2,1).data),info:player.info()});
      }
      ctx.globalAlpha=.7;ctx.globalCompositeOperation='copy';player.draw(ctx,'test',.5,2,2);
      const state=[ctx.globalAlpha,ctx.globalCompositeOperation];
      player.dispose();return {samples,state,disposed:player.draw(ctx,'test',.5,2,2)};
    });
    assert.ok(Math.abs(result.samples[0].pixel[0]-128)<=1);
    assert.ok(Math.abs(result.samples[0].pixel[2]-128)<=1);
    for(const sample of result.samples) {
      assert.equal(sample.pixel[3],255,'opaque body remains opaque');
      assert.equal(sample.pixel[7],0,'transparent padding remains transparent');
    }
    assert.equal(result.samples[0].info.fromFrame,1);assert.equal(result.samples[0].info.toFrame,2);
    assert.equal(result.samples[3].info.frame,0);assert.equal(result.samples[4].info.frame,3);
    assert.ok(Math.abs(result.state[0]-.7)<.001);assert.equal(result.state[1],'copy');assert.equal(result.disposed,false);
    console.log(JSON.stringify({passed:true,crossAtlas:true,opaque:true,transparent:true}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
