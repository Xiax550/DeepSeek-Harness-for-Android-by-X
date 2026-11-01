const { mkdirSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');

(async () => {
  const database = new DatabaseSync('/root/.dsh/dha-memory/memory.db', { readOnly: true });
  if (!existsSync('/sdcard/Download/DHA-memory-before-review-20261031.db')) await backup(database, '/sdcard/Download/DHA-memory-before-review-20261031.db');
  console.log('Original memory backup:', database.prepare('SELECT count(*) AS n FROM memories').get().n);
  database.close();
  const root = '/tmp/dha-review-validation-20261031';
  mkdirSync(root, { recursive: true });
  execFileSync('tar', ['-xf', '/sdcard/Download/dha-review-validation.tar', '-C', root]);
  const result = execFileSync(process.execPath, ['--test', root + '/plugin/dsh-plugin-android/test/memory-review.test.mjs'], { encoding: 'utf8' });
  console.log(result);
})().catch(error => { console.error(error.stdout?.toString() || error.message); process.exitCode = 1; });
