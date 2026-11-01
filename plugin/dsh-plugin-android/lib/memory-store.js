import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';

export const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];
const require = createRequire(import.meta.url);
const text = (value, max = 8000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const scopeOf = value => value === '*' ? '*' : resolve(text(value) || '.');
const editableScope = value => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4096) throw new Error('请选择全局或填写工作区绝对路径');
  const scope = value.trim();
  if (scope !== '*' && !isAbsolute(scope)) throw new Error('工作区必须使用绝对路径');
  return scopeOf(scope);
};
const tokens = value => {
  const words = String(value).toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || [];
  return [...new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 1
    ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))];
};

export class MemoryStore {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, level TEXT NOT NULL,
        content TEXT NOT NULL, project TEXT NOT NULL, keywords TEXT NOT NULL,
        importance INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, source TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(workspace,status,updated_at);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  setting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify(value));
  }
  configure(patch) {
    const next = {};
    if (patch.forgetScope !== undefined) {
      if (!['automation', 'all'].includes(patch.forgetScope)) throw new Error('遗忘范围无效');
      next.forgetScope = patch.forgetScope;
    }
    for (const key of ['enabled', 'autoRecall', 'autoSave', 'reviewEnabled', 'reviewCompact', 'reviewCleanup', 'forgetEnabled', 'forgetProtectUnreviewed']) {
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'boolean') throw new Error('开关必须为布尔值');
        next[key] = patch[key];
      }
    }
    for (const key of ['reviewTime', 'reviewEndTime', 'forgetTime']) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch[key])) throw new Error('回忆时间无效');
      next[key] = patch[key];
    }
    const range = { ...this.config(), ...next };
    if (range.reviewTime === range.reviewEndTime) throw new Error('开始时间和结束时间不能相同');
    if (patch.reviewTimeZone !== undefined) {
      if (typeof patch.reviewTimeZone !== 'string') throw new Error('时区无效');
      new Intl.DateTimeFormat('en', { timeZone: patch.reviewTimeZone }).format();
      next.reviewTimeZone = patch.reviewTimeZone;
    }
    if (patch.reviewRetentionDays !== undefined) {
      if (!Number.isInteger(patch.reviewRetentionDays) || patch.reviewRetentionDays < 1 || patch.reviewRetentionDays > 365) throw new Error('会话保留时间应为 1 至 365 天');
      next.reviewRetentionDays = patch.reviewRetentionDays;
    }
    for (const key of ['forgetArchiveDays', 'forgetDeleteDays']) {
      if (patch[key] === undefined) continue;
      if (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > 365) throw new Error('遗忘保留时间应为 1 至 365 天');
      next[key] = patch[key];
    }
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const [key, value] of Object.entries(next)) this.setSetting(key, value); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.config();
  }
  config() {
    const start = this.setting('reviewTime', '23:00');
    const [hour, minute] = start.split(':').map(Number);
    const end = `${String((hour + 7) % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return { enabled: this.setting('enabled', true), autoRecall: this.setting('autoRecall', true), autoSave: this.setting('autoSave', true),
      forgetEnabled: this.setting('forgetEnabled', false), forgetProtectUnreviewed: this.setting('forgetProtectUnreviewed', true),
      forgetArchiveDays: this.setting('forgetArchiveDays', 3), forgetDeleteDays: this.setting('forgetDeleteDays', 2),
      forgetTime: this.setting('forgetTime', '03:00'), forgetScope: this.setting('forgetScope', 'automation'),
      reviewEnabled: this.setting('reviewEnabled', false), reviewTime: start, reviewEndTime: this.setting('reviewEndTime', end),
      reviewTimeZone: this.setting('reviewTimeZone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
      reviewCompact: this.setting('reviewCompact', true), reviewCleanup: this.setting('reviewCleanup', false),
      reviewRetentionDays: this.setting('reviewRetentionDays', 7) };
  }
  normalize(input, previous = {}) {
    const row = { ...previous, ...input };
    const content = text(row.content);
    if (!content) throw new Error('记忆内容不能为空');
    if (!LEVELS.includes(row.level || 'fact')) throw new Error('记忆分类无效');
    if (row.status && !['active', 'archived', 'stale'].includes(row.status)) throw new Error('记忆状态无效');
    return {
      ...row, content, level: row.level || 'fact', project: text(row.project, 200) || '全局',
      keywords: Array.isArray(row.keywords) ? row.keywords.map(k => text(k, 80)).filter(Boolean).slice(0, 30) : tokens(content).slice(0, 20),
      importance: Math.max(1, Math.min(5, Number(row.importance) || 1)), status: row.status || 'active'
    };
  }
  decode(row) { return row ? { ...row, keywords: JSON.parse(row.keywords), extra: JSON.parse(row.extra) } : null; }
  get(id, workspace) {
    return this.decode(workspace === undefined
      ? this.db.prepare('SELECT * FROM memories WHERE id=?').get(id)
      : this.db.prepare('SELECT * FROM memories WHERE id=? AND workspace=?').get(id, scopeOf(workspace)));
  }
  put(input, workspace, source = 'DHA') {
    const row = this.normalize(input);
    const scope = input.workspace === undefined ? scopeOf(workspace) : editableScope(input.workspace);
    if (workspace !== undefined && input.workspace !== undefined && scope !== scopeOf(workspace)) throw new Error('不能跨工作区修改作用域');
    const existing = this.db.prepare('SELECT id FROM memories WHERE workspace=? AND level=? AND project=? AND content=? AND status=\'active\'').get(scope, row.level, row.project, row.content);
    if (existing) return { ...this.get(existing.id), merged: true };
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO memories (id,workspace,level,content,project,keywords,importance,status,created_at,updated_at,source,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scope, row.level, row.content, row.project, JSON.stringify(row.keywords), row.importance, row.status, now, now, source, '{}');
    return this.get(id);
  }
  update(id, input, workspace) {
    const previous = this.get(id, workspace);
    if (!previous) throw new Error('找不到这条记忆');
    const patch = input.content !== undefined && input.content !== previous.content && input.keywords === undefined
      ? { ...input, keywords: tokens(input.content).slice(0, 20) } : input;
    const row = this.normalize(patch, previous);
    const scope = input.workspace === undefined ? previous.workspace : editableScope(input.workspace);
    if (workspace !== undefined && scope !== previous.workspace) throw new Error('不能跨工作区修改作用域');
    this.db.prepare('UPDATE memories SET workspace=?,level=?,content=?,project=?,keywords=?,importance=?,status=?,updated_at=? WHERE id=?').run(scope, row.level, row.content, row.project, JSON.stringify(row.keywords), row.importance, row.status, Date.now(), id);
    return this.get(id);
  }
  remove(id, workspace) {
    const previous = this.get(id, workspace);
    if (!previous) throw new Error('找不到这条记忆');
    this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
    return { ok: true };
  }
  list({ workspace, status = 'active', query = '', project = '', limit = 50, offset = 0 } = {}) {
    const clauses = [], args = [];
    if (workspace !== undefined && workspace !== '') { clauses.push('(workspace=? OR workspace=\'*\')'); args.push(scopeOf(workspace)); }
    if (status !== 'all') { clauses.push('status=?'); args.push(status); }
    if (project) { clauses.push('project=?'); args.push(project); }
    if (query) { clauses.push('(instr(content,?)>0 OR instr(keywords,?)>0)'); args.push(query, query); }
    return this.db.prepare(`SELECT * FROM memories ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args, Math.max(1, Math.min(10000, Number(limit) || 50)), Math.max(0, Number(offset) || 0)).map(row => this.decode(row));
  }
  search(query, workspace, limit = 8, project = '') {
    const wanted = tokens(text(query, 500));
    if (!wanted.length) return [];
    return this.list({ workspace, limit: 10000 }).map(row => {
      if (project && row.project !== '全局' && !row.project.split(',').map(s => s.trim()).includes(project)) return { row, score: 0 };
      const keys = new Set(tokens(row.keywords.join(' ') + ' ' + row.project));
      const body = new Set(tokens(row.content));
      const overlap = wanted.reduce((sum, word) => sum + (keys.has(word) ? 3 : body.has(word) ? 1 : 0), 0);
      return { row, score: overlap * (1 + row.importance * 0.15) };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at).slice(0, Math.max(1, Math.min(30, Number(limit) || 8))).map(hit => hit.row);
  }
  context(query, workspace, budget = 4500) {
    const relevant = this.search(query, workspace, 6);
    const stable = this.list({ workspace, limit: 10000 }).filter(row => ['user', 'soul'].includes(row.level) || row.level === 'rules' && row.project === '全局' && row.importance >= 2).sort((a, b) => b.importance - a.importance || b.updated_at - a.updated_at);
    const selected = [...relevant, ...stable];
    const seen = new Set();
    let result = '';
    for (const row of selected) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const line = `[${row.level}/${row.project}; ${row.id}] ${row.content.slice(0, 1200)}\n`;
      if (result.length + line.length > budget) continue;
      result += line;
    }
    return result;
  }
  importMeow(workspace, sourceFile = join(workspace, '.dsh-meow', 'memory.db')) {
    if (!existsSync(sourceFile)) return { imported: 0, skipped: true };
    const key = `meow-import-v1:${resolve(sourceFile)}`;
    if (this.setting(key, false)) return { imported: 0, skipped: true };
    const { DatabaseSync } = require('node:sqlite');
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    let imported = 0;
    try {
      source.exec('PRAGMA busy_timeout=3000; BEGIN');
      const check = source.prepare('PRAGMA integrity_check').get();
      if (check.integrity_check !== 'ok') throw new Error('旧记忆数据库完整性检查失败');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const level of LEVELS) {
          if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(level)) continue;
          for (const original of source.prepare(`SELECT * FROM "${level}"`).all()) {
            if (typeof original.content !== 'string' || !original.content.trim()) throw new Error('旧记忆存在无效内容，已取消迁移');
            const id = createHash('sha256').update(resolve(sourceFile) + ':' + level + ':' + original.id).digest('hex');
            this.db.prepare('INSERT OR IGNORE INTO memories (id,workspace,level,content,project,keywords,importance,status,created_at,updated_at,source,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scopeOf(workspace), level, original.content, original.project || '全局', JSON.stringify(Array.isArray(JSON.parse(original.keywords || '[]')) ? JSON.parse(original.keywords || '[]') : []), original.importance || 1, original.status || 'active', original.created_at || Date.now(), original.updated_at || Date.now(), 'meow-memory', JSON.stringify(original));
            imported++;
          }
        }
        this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify({ imported, at: Date.now() }));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } finally { source.close(); }
    return { imported };
  }
  summary() {
    return { ...this.config(), count: this.db.prepare("SELECT count(*) AS n FROM memories WHERE status='active'").get().n,
      totalCount: this.db.prepare('SELECT count(*) AS n FROM memories').get().n,
      workspaces: this.db.prepare("SELECT workspace,count(*) AS count FROM memories WHERE status='active' GROUP BY workspace").all() };
  }
  exportRows() { return this.db.prepare('SELECT * FROM memories ORDER BY workspace,created_at,id').all().map(row => this.decode(row)); }
}
