/**
 * Outbox drain.
 *
 * Every field mutation is written to the local outbox first and POSTed second, so a
 * transfer completed in a dead spot is never lost. Each row replays under the
 * `clientRequestId` it was minted with, which is what makes retrying safe.
 */
import { ApiError, apiRequest } from '../api/client';
import { getStore, type OutboxRecord } from '../db';

/** 5s, 10s, 20s … capped at 5 min. */
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export const backoffFor = (attempts: number): number =>
  Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);

export interface FlushSummary {
  sent: number;
  rejected: number;
  deferred: number;
  /** Set when the drain stopped early because the session is gone. */
  authLost: boolean;
}

/**
 * A 4xx means the server understood us and said no — replaying byte-identical bytes
 * will get the same answer forever, so the row is parked as `rejected` for a human
 * instead of spinning. 5xx and network failures are the server's problem or the
 * network's, and those DO get retried.
 */
const isTerminal = (status: number): boolean => status >= 400 && status < 500 && status !== 401;

let inFlight: Promise<FlushSummary> | null = null;

async function drain(): Promise<FlushSummary> {
  const store = await getStore();
  const due = await store.dueOutbox(Date.now());
  const summary: FlushSummary = { sent: 0, rejected: 0, deferred: 0, authLost: false };

  for (const row of due) {
    try {
      const res = await apiRequest<unknown>(row.path, {
        method: 'POST',
        body: JSON.parse(row.payload) as unknown,
      });
      await store.settleOutbox(row.id, 'done', JSON.stringify(res));
      summary.sent++;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The session is gone; the client has already cleared it and told the UI.
        // Leave this row pending — it will flush after the next sign-in.
        summary.authLost = true;
        break;
      }
      if (err instanceof ApiError && isTerminal(err.status)) {
        await store.settleOutbox(
          row.id,
          'rejected',
          JSON.stringify({
            status: err.status,
            code: err.code,
            message: err.message,
            details: err.details,
          }),
        );
        summary.rejected++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      await store.deferOutbox(row.id, Date.now() + backoffFor(row.attempts), message);
      summary.deferred++;
    }
  }

  return summary;
}

/** Drains the outbox. Concurrent callers share one pass — never double-send. */
export function flushOutbox(): Promise<FlushSummary> {
  inFlight ??= drain().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function enqueueMutation(rec: {
  id: string;
  kind: OutboxRecord['kind'];
  path: string;
  body: unknown;
  label: string;
}): Promise<void> {
  const store = await getStore();
  await store.enqueue({
    id: rec.id,
    kind: rec.kind,
    path: rec.path,
    payload: JSON.stringify(rec.body),
    label: rec.label,
  });
}
