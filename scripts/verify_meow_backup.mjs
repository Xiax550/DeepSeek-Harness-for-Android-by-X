import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, LEVELS } from '../plugin/dsh-plugin-android/lib/memory-store.js';

const folder = process.argv[2];
if (!folder) throw new Error('Backup folder required');
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
for (const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(join(folder, file.path))).digest('hex'), file.sha256, file.path);
const temp = mkdtempSync(join(tmpdir(), 'dha-backup-verification-'));
const store = new MemoryStore(join(temp, 'memory.db'));
let total = 0;
try {
  for (const entry of manifest.databases) {
    const sourceFile = join(folder, 'data', entry.source.replace(/^\//, ''));
    const workspace = entry.source.replace(/\/\.dsh-meow\/memory\.db$/, '');
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    try {
      assert.equal(source.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      const original = LEVELS.flatMap(level => source.prepare(`SELECT * FROM "${level}"`).all().map(row => ({ level, row })));
      const report = store.importMeow(workspace, sourceFile);
      assert.equal(report.imported, original.length);
      const imported = store.list({ workspace, status: 'all', limit: 10000 });
      assert.equal(imported.length, original.length);
      for (const { level, row } of original) {
        const matched = imported.find(item => item.level === level && item.extra.id === row.id);
        assert.ok(matched, 'Every source row has a destination');
        assert.deepEqual(matched.extra, { ...row });
        assert.equal(matched.content, row.content);
      }
      total += original.length;
    } finally { source.close(); }
  }
  console.log(`PASS: ${manifest.files.length} file hashes; ${manifest.databases.length} databases; ${total} memories imported with all original fields preserved.`);
} finally { store.close(); rmSync(temp, { recursive: true, force: true }); }
