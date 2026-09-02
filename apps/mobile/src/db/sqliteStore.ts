import * as SQLite from 'expo-sqlite';
import type { CachedBatch, CachedCylinder, CachedSite, OutboxRecord, Store } from './store';

/**
 * Bumped whenever a **cache** table changes shape.
 *
 * `CREATE TABLE IF NOT EXISTS` silently does nothing on a device that already holds
 * the previous version, so without this an upgraded app would keep the old columns
 * and every cacheBatch() would fail at runtime — on device only, invisibly to the web
 * build, whose store is in-memory and therefore always "migrated".
 *
 * Dropping is safe for exactly these two tables and no others: they are a read mirror
 * of the server, refetched whenever a batch is picked. The `outbox` is NOT dropped —
 * it holds field work that has not reached the server yet, and losing it would lose
 * the transfer someone recorded in a dead spot.
 */
const CACHE_SCHEMA_VERSION = 2;

const DROP_STALE_CACHE = `
DROP TABLE IF EXISTS cached_batch;
DROP TABLE IF EXISTS cached_cylinder;
DROP TABLE IF EXISTS cached_site;
`;

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS outbox (
  -- The row id IS the request's clientRequestId, minted at enqueue and never
  -- regenerated. A flush that times out and retries replays the same key, so the
  -- server returns the transfer it already created instead of making a second one.
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  path            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  result          TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS cached_batch (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  project_number        TEXT NOT NULL,
  site_id               TEXT NOT NULL,
  contents              TEXT NOT NULL,
  project_manager_id    TEXT NOT NULL,
  project_manager_name  TEXT NOT NULL,
  status                TEXT NOT NULL,
  cached_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cached_cylinder (
  serial_code     TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL,
  gas_type_name   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  current_site_id TEXT
);
CREATE INDEX IF NOT EXISTS cached_cylinder_batch ON cached_cylinder (batch_id);

CREATE TABLE IF NOT EXISTS cached_site (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  location   TEXT NOT NULL
);
`;

interface OutboxRow {
  id: string;
  kind: string;
  path: string;
  payload: string;
  label: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: OutboxRow): OutboxRecord => ({
  id: r.id,
  kind: r.kind as OutboxRecord['kind'],
  path: r.path,
  payload: r.payload,
  label: r.label,
  status: r.status as OutboxRecord['status'],
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  result: r.result,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function createSqliteStore(): Promise<Store> {
  const db = await SQLite.openDatabaseAsync('gct.db');

  // Migrate the cache tables before creating anything. `user_version` starts at 0 on
  // a fresh install, so a new device drops three tables that do not exist and then
  // creates them — harmless — while an upgraded one sheds its stale shape first.
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((row?.user_version ?? 0) < CACHE_SCHEMA_VERSION) {
    await db.execAsync(DROP_STALE_CACHE);
    await db.execAsync(`PRAGMA user_version = ${CACHE_SCHEMA_VERSION}`);
  }

  await db.execAsync(SCHEMA);

  return {
    async enqueue(rec) {
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
      // INSERT OR IGNORE: re-enqueuing an id that is already queued must not reset
      // its attempt count or resurrect a settled row.
      await db.runAsync(
        `INSERT OR IGNORE INTO outbox
           (id, kind, path, payload, label, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`,
        [rec.id, rec.kind, rec.path, rec.payload, rec.label, now, now],
      );
      return row;
    },

    async dueOutbox(now) {
      const rows = await db.getAllAsync<OutboxRow>(
        `SELECT * FROM outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY created_at ASC`,
        [now],
      );
      return rows.map(toRecord);
    },

    async openOutbox() {
      const rows = await db.getAllAsync<OutboxRow>(
        `SELECT * FROM outbox WHERE status IN ('pending', 'rejected') ORDER BY created_at ASC`,
      );
      return rows.map(toRecord);
    },

    async getOutbox(id) {
      const row = await db.getFirstAsync<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [id]);
      return row ? toRecord(row) : null;
    },

    async settleOutbox(id, status, result) {
      await db.runAsync(
        `UPDATE outbox SET status = ?, result = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
        [status, result, Date.now(), id],
      );
    },

    async deferOutbox(id, nextAttemptAt, lastError) {
      await db.runAsync(
        `UPDATE outbox
         SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        [nextAttemptAt, lastError, Date.now(), id],
      );
    },

    async retryOutbox(id) {
      // The WHERE clause carries the 'rejected' guard so the check and the write are
      // one statement — a drain that settles this row concurrently cannot slip in
      // between a read and an update.
      await db.runAsync(
        `UPDATE outbox
         SET status = 'pending', attempts = 0, next_attempt_at = 0,
             last_error = NULL, result = NULL, updated_at = ?
         WHERE id = ? AND status = 'rejected'`,
        [Date.now(), id],
      );
    },

    async discardOutbox(id) {
      await db.runAsync(`DELETE FROM outbox WHERE id = ? AND status = 'rejected'`, [id]);
    },

    async clearSettled() {
      await db.runAsync(`DELETE FROM outbox WHERE status = 'done'`);
    },

    async cacheBatch(batch: CachedBatch, cylinders: CachedCylinder[], sites: CachedSite[]) {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT OR REPLACE INTO cached_batch
             (id, project_id, project_number, site_id, contents,
              project_manager_id, project_manager_name, status, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            batch.id,
            batch.projectId,
            batch.projectNumber,
            batch.siteId,
            batch.contents,
            batch.projectManagerId,
            batch.projectManagerName,
            batch.status,
            batch.cachedAt,
          ],
        );
        // Replace wholesale: a cylinder dropped from the server's list is gone, and
        // a stale row would let the scanner accept a serial that no longer belongs.
        await db.runAsync('DELETE FROM cached_cylinder WHERE batch_id = ?', [batch.id]);
        for (const c of cylinders) {
          await db.runAsync(
            `INSERT OR REPLACE INTO cached_cylinder
               (serial_code, batch_id, gas_type_name, status, current_site_id)
             VALUES (?, ?, ?, ?, ?)`,
            [c.serialCode, c.batchId, c.gasTypeName, c.status, c.currentSiteId],
          );
        }
        for (const s of sites) {
          await db.runAsync(
            `INSERT OR REPLACE INTO cached_site (id, project_id, name, location) VALUES (?, ?, ?, ?)`,
            [s.id, s.projectId, s.name, s.location],
          );
        }
      });
    },

    async getCachedBatch(batchId) {
      const row = await db.getFirstAsync<{
        id: string;
        project_id: string;
        project_number: string;
        site_id: string;
        contents: string;
        project_manager_id: string;
        project_manager_name: string;
        status: string;
        cached_at: number;
      }>('SELECT * FROM cached_batch WHERE id = ?', [batchId]);
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.project_id,
        projectNumber: row.project_number,
        siteId: row.site_id,
        contents: row.contents,
        projectManagerId: row.project_manager_id,
        projectManagerName: row.project_manager_name,
        status: row.status,
        cachedAt: row.cached_at,
      };
    },

    async getCachedCylinders(batchId) {
      const rows = await db.getAllAsync<{
        serial_code: string;
        batch_id: string;
        gas_type_name: string;
        status: string;
        current_site_id: string | null;
      }>('SELECT * FROM cached_cylinder WHERE batch_id = ? ORDER BY serial_code ASC', [batchId]);
      return rows.map((r) => ({
        serialCode: r.serial_code,
        batchId: r.batch_id,
        gasTypeName: r.gas_type_name,
        status: r.status,
        currentSiteId: r.current_site_id,
      }));
    },

    async getCachedSites(projectId) {
      const rows = await db.getAllAsync<{
        id: string;
        project_id: string;
        name: string;
        location: string;
      }>('SELECT * FROM cached_site WHERE project_id = ? ORDER BY name ASC', [projectId]);
      return rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        name: r.name,
        location: r.location,
      }));
    },
  };
}
