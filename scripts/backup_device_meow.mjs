const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `/sdcard/Download/DHA-meow-backup-${stamp}`;
  fs.mkdirSync(target, { recursive: true });
  const roots = new Set();
  function walk(dir, depth = 0) {
    if (depth > 14) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || ['node_modules', '.git', '.cache'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === '.dsh-meow') roots.add(full);
      else walk(full, depth + 1);
    }
  }
  for (const base of ['/root', '/workspace', '/home', '/mnt']) walk(base);
  const workspaceFile = '/root/.dsh/storages/workspace.json';
  if (fs.existsSync(workspaceFile)) {
    const workspaces = fs.readFileSync(workspaceFile, 'utf8');
    for (const match of workspaces.matchAll(/"(\/[^"\n]+)"/g)) walk(match[1]);
    fs.copyFileSync(workspaceFile, path.join(target, 'workspace-locations.json'));
  }
  const report = { createdAt: new Date().toISOString(), device: 'Xiaomi 14 / 23127PN0CC', roots: [...roots], databases: [], files: [] };
  const profile = '/root/.dsh/profiles/web';
  const related = [path.join(profile, 'package.json'), path.join(profile, 'cordis.patch.yml'), path.join(profile, 'node_modules/meow-memory/package.json')];
  const storages = '/root/.dsh/storages';
  if (fs.existsSync(storages)) for (const name of fs.readdirSync(storages)) if (/meow|memory/i.test(name)) related.push(path.join(storages, name));
  for (const source of related) if (fs.existsSync(source)) {
    const dest = path.join(target, 'configuration', source.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(source, dest, { recursive: true });
  }
  for (const root of roots) {
    const dest = path.join(target, 'data', root.replace(/^\//, ''));
    fs.cpSync(root, dest, { recursive: true, filter: source => !/memory\.db(?:-wal|-shm)?$/.test(source) });
    const sourceDb = path.join(root, 'memory.db');
    if (!fs.existsSync(sourceDb)) continue;
    const db = new DatabaseSync(sourceDb, { readOnly: true });
    try {
      await backup(db, path.join(dest, 'memory.db'));
      const copy = new DatabaseSync(path.join(dest, 'memory.db'), { readOnly: true });
      try {
        const integrity = copy.prepare('PRAGMA integrity_check').get();
        const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const counts = {};
        for (const { name } of tables) counts[name] = copy.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n;
        report.databases.push({ source: sourceDb, integrity, counts });
      } finally { copy.close(); }
    } finally { db.close(); }
  }
  function inventory(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) inventory(full);
      else report.files.push({ path: path.relative(target, full), bytes: fs.statSync(full).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
    }
  }
  inventory(target);
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(report, null, 2));
  execFileSync('tar', ['-czf', target + '.tar.gz', '-C', path.dirname(target), path.basename(target)]);
  console.log(JSON.stringify({ archive: target + '.tar.gz', files: report.files.length, databases: report.databases }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
