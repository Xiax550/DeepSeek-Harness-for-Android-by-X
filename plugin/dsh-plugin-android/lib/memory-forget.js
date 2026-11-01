import { createHash } from 'node:crypto';
import { nextReviewChunk, reviewSlot } from './memory-review.js';
import { matchesForgetScope } from './memory-session-policy.js';

const DAY = 86400000;
const fingerprint = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
export class MemoryForget {
  constructor({ store, services, now = () => Date.now() }) {
    this.store = store; this.services = services; this.now = now; this.active = null; this.disposed = false;
  }
  status() { return { available: !!this.services.remove, ...this.store.setting('forgetState', {}), running: !!this.active }; }
  start() {
    const tick = async () => {
      if (this.disposed) return;
      try { await this.tick(); } catch { /* Status retains the error for settings. */ }
      if (!this.disposed) { this.timer = setTimeout(tick, 3600000); this.timer.unref?.(); }
    };
    this.timer = setTimeout(tick, 30000); this.timer.unref?.();
  }
  async dispose() { this.disposed = true; clearTimeout(this.timer); await this.active?.catch(() => {}); }
  tick(force = false) {
    if (this.disposed || !this.store.config().enabled || !this.store.config().forgetEnabled) return Promise.resolve();
    if (this.active) return this.active;
    const state = this.store.setting('forgetState', {});
    const config = this.store.config();
    const slot = reviewSlot(this.now(), config.forgetTime, config.reviewTimeZone);
    if (!force && (state.slot === slot || this.now() - (state.checkedAt || 0) < 3600000)) return Promise.resolve();
    this.active = this.perform(slot).finally(() => { this.active = null; });
    return this.active;
  }
  protected(id) { return this.disposed || !this.store.config().enabled || !this.store.config().forgetEnabled || this.services.isPinned(id) || this.services.isRunning(id); }
  async perform(slot) {
    let archived = 0, deleted = 0, skipped = 0;
    const records = this.store.setting('forgetRecords', {});
    try {
      await this.services.sweep?.();
      const items = await this.services.list();
      const related = new Set(items.flatMap(item => [item.parentSessionId, item.forkedFrom?.sessionId].filter(Boolean)));
      for (const item of items) {
        if (archived + deleted >= 40 || this.disposed || !this.store.config().enabled || !this.store.config().forgetEnabled) break;
        const id = item.sessionId;
        if (this.protected(id) || item.running || item.origin === 'subagent' || item.parentSessionId || related.has(id)) { skipped++; continue; }
        if (records[id] && !this.services.isArchived(id)) {
          if (!records[id].restoredAt) {
            records[id] = { restoredAt: this.now() }; this.store.setSetting('forgetRecords', records);
            continue;
          }
        }
        let snapshot;
        try { snapshot = await this.services.inspect(id); } catch { skipped++; continue; }
        if (!snapshot?.meta?.cwd || snapshot.meta.parentSession || snapshot.meta.parentSessionId || snapshot.meta.origin === 'subagent') continue;
        const config = this.store.config();
        if (!matchesForgetScope(config, snapshot)) { skipped++; continue; }
        const digest = fingerprint(snapshot);
        if (records[id]?.digest && records[id].digest !== digest) {
          delete records[id]; this.store.setSetting('forgetRecords', records); skipped++; continue;
        }
        const updated = snapshot.events.reduce((latest, e) => Math.max(latest, e.time || 0), Math.max(item.updatedAt || 0, snapshot.meta.createdAt || 0, records[id]?.restoredAt || 0));
        if (!updated || updated > this.now() || this.now() - updated < config.forgetArchiveDays * DAY) continue;
        if (config.forgetProtectUnreviewed && nextReviewChunk(snapshot.events, this.store.setting('reviewCursor:' + id, { seq: -1, offset: 0 })).messages.length) { skipped++; continue; }
        // Attachments are not summarized by textual recollection; leave these conversations intact.
        if (snapshot.events.some(e => ['user/message', 'assistant/message'].includes(e.type) && e.data?.content?.some(b => b.type !== 'text'))) { skipped++; continue; }
        if (this.services.isArchived(id)) {
          const record = records[id];
          if (!record?.digest) continue; // Never delete a user's manually archived conversations.
          if (this.now() - record.at < config.forgetDeleteDays * DAY || this.protected(id) || this.services.isLoaded?.(id)) continue;
          if (!this.services.remove) throw new Error('当前会话存储不支持安全删除');
          await this.services.remove(id, snapshot, () => !this.protected(id) && this.services.isArchived(id) && matchesForgetScope(this.store.config(), snapshot));
          delete records[id]; this.store.setSetting('forgetRecords', records);
          this.store.db.prepare('DELETE FROM metadata WHERE key=?').run('reviewCursor:' + id);
          deleted++;
        } else {
          const fresh = await this.services.inspect(id);
          if (fingerprint(fresh) !== digest || this.protected(id) || !matchesForgetScope(this.store.config(), fresh)) { skipped++; continue; }
          await this.services.archive(id);
          records[id] = { at: this.now(), digest };
          this.store.setSetting('forgetRecords', records); archived++;
        }
      }
      // Keep only entries still present; this metadata stores no conversation text.
      const known = new Set(items.map(item => item.sessionId));
      for (const id of Object.keys(records)) if (!known.has(id)) delete records[id];
      this.store.setSetting('forgetRecords', records);
      this.store.setSetting('forgetState', { checkedAt: this.now(), slot, archived, deleted, skipped, message: `本轮归档 ${archived} 个，删除 ${deleted} 个，保护 ${skipped} 个会话` });
    } catch (error) {
      this.store.setSetting('forgetState', { checkedAt: this.now(), archived, deleted, skipped, message: '遗忘未完成：' + error.message });
      throw error;
    }
  }
}
