const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

(async () => {
  const source = fs.readFileSync('payload/opt/dsh/android/ball-web/reference/motion-player.js', 'utf8');
  for (const decodeFails of [false, true]) {
    const window = { DHA_WHOLE_MOTION: { size: 256, columns: 5, rows: 4, framesPerAtlas: 20,
      clips: { wake: { frames: 20, fps: 40, files: ['wake.webp'], knots: [[0, 0], [1, .475]] } } } };
    class LoadedImage {
      constructor() { this.naturalWidth = 1280; this.naturalHeight = 1024; }
      set src(value) { queueMicrotask(() => this.onload()); }
      async decode() { if (decodeFails) throw new Error('Android intercepted URL decode failure'); }
    }
    const document = { createElement() { return { getContext() { return {
      clearRect() {}, drawImage() {}
    }; } }; } };
    vm.runInNewContext(source, { window, Image: LoadedImage, URL, document });
    const player = await window.WholeBodyMotion.create('https://test.invalid/reference/');
    let drawn = false;
    assert.equal(player.draw({ drawImage() { drawn = true; } }, 'wake', .5, 256, 256), true);
    assert.equal(drawn, true);
    player.dispose();
    assert.equal(player.draw({}, 'wake', .5, 256, 256), false);
  }
  console.log('PASS loaded atlases remain usable with successful or rejected optional decode');
})().catch(error => { console.error(error); process.exitCode = 1; });
