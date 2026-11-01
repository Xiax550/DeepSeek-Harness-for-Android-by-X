import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MemoryStore } from './memory-store.js';

export function migrateLegacyMemory(home, yamlModule) {
  const root = join(home, '.dsh', 'dha-memory');
  const marker = join(root, 'migration-v1.json');
  if (existsSync(marker)) return JSON.parse(readFileSync(marker, 'utf8'));
  const workspaces = new Set();
  const add = value => { if (typeof value === 'string' && isAbsolute(value) && existsSync(join(value, '.dsh-meow', 'memory.db'))) workspaces.add(resolve(value)); };
  for (const file of [join(home, '.dsh-meow', 'window-index.json'), join(home, '.dsh', 'storages', 'workspace.json')]) {
    if (!existsSync(file)) continue;
    const visit = value => {
      if (typeof value === 'string') add(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(JSON.parse(readFileSync(file, 'utf8')));
  }
  add(home);
  for (const base of [home, join(home, '.dsh')]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) if (entry.isDirectory()) add(join(base, entry.name));
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new MemoryStore(join(root, 'memory.db'));
  const report = { at: new Date().toISOString(), sources: [] };
  const changedFiles = [];
  try {
    for (const workspace of workspaces) report.sources.push({ workspace, ...db.importMeow(workspace) });
    const profile = join(home, '.dsh', 'profiles', 'web', 'package.json');
    const patch = join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
    if (existsSync(patch)) {
      const yaml = yamlModule || createRequire(import.meta.url)('js-yaml');
      class Expression { constructor(value) { this.value = value; } }
      const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => new Expression(value), instanceOf: Expression, represent: value => value.value })]);
      const document = yaml.load(readFileSync(patch, 'utf8'), { schema });
      if (!Array.isArray(document)) throw new Error('profile patch must be a YAML list');
      const filter = rows => rows.filter(row => row?.id !== 'meow-memory' && row?.name !== 'meow-memory').map(row => row && Array.isArray(row.insert) ? { ...row, insert: filter(row.insert) } : row);
      const filtered = filter(document);
      if (JSON.stringify(document) !== JSON.stringify(filtered)) {
        if (!existsSync(patch + '.before-dha-memory')) copyFileSync(patch, patch + '.before-dha-memory');
        changedFiles.push([patch, readFileSync(patch)]);
        writeFileSync(patch + '.dha-memory.tmp', yaml.dump(filtered, { schema, lineWidth: -1, noRefs: true }));
        renameSync(patch + '.dha-memory.tmp', patch);
        report.legacyPatchDisabled = true;
      }
    }
    if (existsSync(profile)) {
      const document = JSON.parse(readFileSync(profile, 'utf8'));
      const bundles = document.dsh?.profile?.bundles;
      if (Array.isArray(bundles) && bundles.includes('meow-memory')) {
        const backup = profile + '.before-dha-memory';
        if (!existsSync(backup)) copyFileSync(profile, backup);
        changedFiles.push([profile, readFileSync(profile)]);
        document.dsh.profile.bundles = bundles.filter(name => name !== 'meow-memory');
        writeFileSync(profile + '.dha-memory.tmp', JSON.stringify(document, null, 2) + '\n');
        renameSync(profile + '.dha-memory.tmp', profile);
        report.legacyBundleDisabled = true;
      }
    }
    writeFileSync(marker + '.tmp', JSON.stringify(report, null, 2) + '\n');
    renameSync(marker + '.tmp', marker);
    return report;
  } catch (error) {
    for (const [file, contents] of changedFiles.reverse()) {
      writeFileSync(file + '.dha-memory.rollback', contents);
      renameSync(file + '.dha-memory.rollback', file);
    }
    throw error;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('dha-memory: ' + JSON.stringify(migrateLegacyMemory(process.argv[2] || process.env.HOME || '/root'))); }
  catch (error) { console.error('dha-memory: migration failed; original plugin and data retained: ' + error.message); process.exitCode = 1; }
}
