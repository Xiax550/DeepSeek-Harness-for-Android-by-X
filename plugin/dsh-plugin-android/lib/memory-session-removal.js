import { dirname, join, relative, resolve, sep } from 'node:path';
import { mkdir, realpath, rename, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAutomationSession } from './memory-session-policy.js';

// The archive gate blocks new prompts; the persistence write lease excludes existing writers.
export function sessionRemoval(scope, store, directory) {
  const persistence = scope.sessionPersistence;
  if (persistence?.name !== 'session-persistence-jsonl' || !persistence.root || !persistence.locate || !persistence.open) return {};
  const trash = resolve(directory, 'forget-trash');
  const loaded = id => !!scope.agents?.get(id) || !!scope.sessions?.get(id);
  const sweep = async () => {
    const pending = store.setting('forgetTrash', []);
    for (const entry of [...pending]) {
      if (!store.config().enabled || !store.config().forgetEnabled) break;
      if (store.config().forgetScope !== 'all' && entry.automation !== true) continue;
      const { path, id } = entry;
      if (dirname(path) !== trash || !/^[0-9a-f-]{36}$/.test(relative(trash, path))) throw new Error('遗忘清理路径无效');
      let exists = false;
      try { await lstat(path); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!store.config().enabled || !store.config().forgetEnabled || store.config().forgetScope !== 'all' && entry.automation !== true) continue;
      await rm(path, { recursive: true, force: true });
      if (exists || entry.moved) await scope.workspaceRegistry.unarchiveSession(id);
      pending.splice(pending.indexOf(entry), 1); store.setSetting('forgetTrash', pending);
    }
  };
  return {
    isLoaded: loaded, sweep,
    async remove(id, snapshot, allowed) {
      if (loaded(id) || !allowed()) throw new Error('会话仍在使用，已保护');
      const handle = await persistence.open(id, 'write');
      try {
        const read = await handle.read();
        if (handle.header.id !== id || !isDeepStrictEqual(handle.header, snapshot.meta) || !isDeepStrictEqual(read.events, snapshot.events)) throw new Error('会话内容已变化，已保护');
        const root = await realpath(persistence.root);
        const source = dirname(persistence.locate(handle.header).path);
        const actual = await realpath(source);
        const parts = relative(root, actual).split(sep);
        if (actual !== resolve(source) || parts.length !== 2 || parts.some(part => !part || part === '..') || (await lstat(source)).isSymbolicLink()) throw new Error('会话目录不在安全范围');
        await mkdir(trash, { recursive: true, mode: 0o700 });
        if (await realpath(trash) !== trash) throw new Error('遗忘暂存目录无效');
        if (loaded(id) || !allowed()) throw new Error('会话状态已变化，已保护');
        const target = join(trash, randomUUID());
        const pending = store.setting('forgetTrash', []);
        const entry = { path: target, id, moved: false, automation: isAutomationSession(snapshot) };
        store.setSetting('forgetTrash', [...pending, entry]);
        await rename(actual, target);
        if (loaded(id) || !allowed()) {
          await rename(target, actual);
          store.setSetting('forgetTrash', pending);
          throw new Error('会话已恢复，已取消删除');
        }
        entry.moved = true; store.setSetting('forgetTrash', [...pending, entry]);
      } finally { await handle.close(); }
      await sweep();
    }
  };
}
