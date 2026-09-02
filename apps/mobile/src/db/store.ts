/**
 * Local persistence contract for offline work.
 *
 * Two things live here:
 *  - the **outbox**: mutations captured in the field and flushed when the network
 *    comes back (Workflow B and, from M4, Workflow C);
 *  - a **read mirror** of the batch being worked on, so the scanner can validate a
 *    serial with no connectivity at all.
 *
 * The interface is domain-level rather than SQL so the web build can back it with
 * memory (see `memoryStore.ts`) while Android uses SQLite.
 */

/**
 * Which mutation an outbox row replays.
 *
 * Stored as free text in SQLite, so adding 'initialize' needs no cache migration —
 * and the `outbox` table is deliberately never dropped, since it holds field work that
 * has not reached the server yet.
 */
export type OutboxKind = 'transfer' | 'return' | 'initialize';

export type OutboxStatus =
  /** waiting to be sent (or waiting out a backoff) */
  | 'pending'
  /** accepted by the server */
  | 'done'
  /** the server refused it and retrying cannot help — needs a human */
  | 'rejected';

export interface OutboxRecord {
  /** ALSO the request's `clientRequestId`. Minted once, at enqueue. */
  id: string;
  kind: OutboxKind;
  path: string;
  /** JSON request body, already carrying `clientRequestId: id`. */
  payload: string;
  /** Human-readable summary for the pending/queue UI, e.g. "3 cylinders → Yard B". */
  label: string;
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms; a pending row is not eligible until now() passes this. */
  nextAttemptAt: number;
  lastError: string | null;
  /** JSON server response once accepted (or the refusal, when rejected). */
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CachedBatch {
  id: string;
  projectId: string;
  projectNumber: string;
  siteId: string;
  /** "7 × Nitrogen, 4 × Argon" — a batch is no longer one gas, so the mirror carries
   *  the summary rather than a single gas/supplier pair it could not represent. */
  contents: string;
  /** The manager the batch is currently addressed to, so the transfer screen can
   *  show who it is being handed over from with no signal. */
  projectManagerId: string;
  projectManagerName: string;
  status: string;
  cachedAt: number;
}

export interface CachedCylinder {
  serialCode: string;
  batchId: string;
  /** Which gas this particular cylinder is. The scan checklist groups by it, which
   *  only became necessary once one batch could hold several. */
  gasTypeName: string;
  status: string;
  currentSiteId: string | null;
}

export interface CachedSite {
  id: string;
  projectId: string;
  name: string;
  location: string;
}

export interface Store {
  enqueue(
    rec: Pick<OutboxRecord, 'id' | 'kind' | 'path' | 'payload' | 'label'>,
  ): Promise<OutboxRecord>;
  /** Pending rows whose backoff has elapsed, oldest first. */
  dueOutbox(now: number): Promise<OutboxRecord[]>;
  /** Everything still unsent or refused — what the queue badge counts. */
  openOutbox(): Promise<OutboxRecord[]>;
  getOutbox(id: string): Promise<OutboxRecord | null>;
  settleOutbox(id: string, status: 'done' | 'rejected', result: string): Promise<void>;
  deferOutbox(id: string, nextAttemptAt: number, lastError: string): Promise<void>;
  /**
   * Put a `rejected` row back in the queue, due immediately (M5 queue screen).
   *
   * The id — and therefore the `clientRequestId` — is deliberately NOT regenerated:
   * if the server did accept the original after all, the replay returns that same
   * record instead of creating a second transfer. Attempts reset so the operator
   * gets a prompt first try rather than inheriting a five-minute backoff.
   *
   * A no-op on rows that are not `rejected`: `pending` is already queued, and
   * `done` must never be resurrected.
   */
  retryOutbox(id: string): Promise<void>;
  /**
   * Permanently drop a `rejected` row the operator has decided not to resubmit.
   * Restricted to `rejected` so this can never silently bin unsent field work.
   */
  discardOutbox(id: string): Promise<void>;
  clearSettled(): Promise<void>;

  cacheBatch(batch: CachedBatch, cylinders: CachedCylinder[], sites: CachedSite[]): Promise<void>;
  getCachedBatch(batchId: string): Promise<CachedBatch | null>;
  getCachedCylinders(batchId: string): Promise<CachedCylinder[]>;
  getCachedSites(projectId: string): Promise<CachedSite[]>;
}
