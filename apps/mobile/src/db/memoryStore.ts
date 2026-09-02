import type { CachedBatch, CachedCylinder, CachedSite, OutboxRecord, Store } from './store';

/**
 * Web-only stand-in for the SQLite store.
 *
 * `expo-sqlite` on web needs a wasm asset plus cross-origin-isolation headers, which
 * the API's static `/app` mount does not send. Android is the field target; the web
 * export is a demo surface, so it gets the same interface backed by memory — the
 * whole flow stays exercisable, it just does not survive a page reload.
 */
export function createMemoryStore(): Store {
  const outbox = new Map<string, OutboxRecord>();
  const batches = new Map<string, CachedBatch>();
  const cylinders = new Map<string, CachedCylinder[]>();
  const sites = new Map<string, CachedSite>();

  const byCreated = (a: OutboxRecord, b: OutboxRecord) => a.createdAt - b.createdAt;

  return {
    async enqueue(rec) {
      const existing = outbox.get(rec.id);
      if (existing) return existing;
      const now = Date.now();
      const row: OutboxRecord = {
        ...rec,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      outbox.set(row.id, row);
      return row;
    },

    async dueOutbox(now) {
      return [...outbox.values()]
        .filter((r) => r.status === 'pending' && r.nextAttemptAt <= now)
        .sort(byCreated);
    },

    async openOutbox() {
      return [...outbox.values()]
        .filter((r) => r.status === 'pending' || r.status === 'rejected')
        .sort(byCreated);
    },

    async getOutbox(id) {
      return outbox.get(id) ?? null;
    },

    async settleOutbox(id, status, result) {
      const row = outbox.get(id);
      if (row) outbox.set(id, { ...row, status, result, lastError: null, updatedAt: Date.now() });
    },

    async deferOutbox(id, nextAttemptAt, lastError) {
      const row = outbox.get(id);
      if (row) {
        outbox.set(id, {
          ...row,
          attempts: row.attempts + 1,
          nextAttemptAt,
          lastError,
          updatedAt: Date.now(),
        });
      }
    },

    async retryOutbox(id) {
      const row = outbox.get(id);
      if (row?.status !== 'rejected') return;
      outbox.set(id, {
        ...row,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        result: null,
        updatedAt: Date.now(),
      });
    },

    async discardOutbox(id) {
      if (outbox.get(id)?.status === 'rejected') outbox.delete(id);
    },

    async clearSettled() {
      for (const [id, row] of outbox) if (row.status === 'done') outbox.delete(id);
    },

    async cacheBatch(batch, cyls, siteRows) {
      batches.set(batch.id, batch);
      cylinders.set(batch.id, [...cyls]);
      for (const s of siteRows) sites.set(s.id, s);
    },

    async getCachedBatch(batchId) {
      return batches.get(batchId) ?? null;
    },

    async getCachedCylinders(batchId) {
      return [...(cylinders.get(batchId) ?? [])].sort((a, b) =>
        a.serialCode.localeCompare(b.serialCode, 'en', { numeric: true }),
      );
    },

    async getCachedSites(projectId) {
      return [...sites.values()]
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
