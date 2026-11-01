const { mkdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = '/tmp/dha-review-window-validation-20261031';
mkdirSync(root, { recursive: true });
execFileSync('tar', ['-xf', '/sdcard/Download/dha-review-window-validation.tar', '-C', root]);
console.log(execFileSync(process.execPath, ['--test', root + '/plugin/dsh-plugin-android/test/memory-review.test.mjs'], { encoding: 'utf8' }));
