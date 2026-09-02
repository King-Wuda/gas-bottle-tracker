import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMemoryStore } from '../src/db/memoryStore';
import type { Store } from '../src/db/store';

/**
 * M5 — the queue screen's two new verbs, and the full refuse → retry → accept cycle
 * through the real drain. The property that matters is that a *manual* retry is still
 * a replay: same id, therefore same `clientRequestId`, therefore the server answers
 * with the record it already made instead of creating a second transfer.
 */

class FakeApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const apiRequest = vi.fn();
let store: Store;

vi.mock('../src/api/client', () => ({
  ApiError: FakeApiError,
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));

vi.mock('../src/db', () => ({
  getStore: () => Promise.resolve(store),
}));

const { flushOutbox, enqueueMutation } = await import('../src/sync/worker');

const queue = (id: string, kind: 'transfer' | 'return' = 'transfer') =>
  enqueueMutation({
    id,
    kind,
    path: kind === 'transfer' ? '/transfers' : '/returns',
    body: { batchId: 'b1', clientRequestId: id },
    label: '3 cylinders → Yard B',
  });

/** Drives a row to `rejected` the way the server would: a 4xx refusal. */
async function refuse(id: string, status = 422, code = 'NO_VALID_SCANS'): Promise<void> {
  apiRequest.mockRejectedValueOnce(
    new FakeApiError(status, code, 'No scanned cylinder could be moved', {
      rejected: [
        { serialCode: 'NIT26-001', code: 'ALREADY_RETURNED', message: 'Already returned' },
      ],
    }),
  );
  await queue(id);
  await flushOutbox();
}

beforeEach(() => {
  store = createMemoryStore();
  apiRequest.mockReset();
});

describe('retryOutbox', () => {
  it('requeues a rejected row without minting a new id', async () => {
    await refuse('req-1');
    expect((await store.getOutbox('req-1'))?.status).toBe('rejected');

    await store.retryOutbox('req-1');

    const row = await store.getOutbox('req-1');
    expect(row?.id).toBe('req-1'); // the clientRequestId survives — the whole point
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.nextAttemptAt).toBe(0); // due immediately, not after a backoff
    expect(row?.lastError).toBeNull();
    expect(row?.result).toBeNull();
  });

  it('replays the original body, so the server can answer idempotently', async () => {
    await refuse('req-1');
    await store.retryOutbox('req-1');

    apiRequest.mockResolvedValueOnce({ transfer: { id: 't1' } });
    const summary = await flushOutbox();

    expect(summary.sent).toBe(1);
    expect(apiRequest).toHaveBeenLastCalledWith('/transfers', {
      method: 'POST',
      body: { batchId: 'b1', clientRequestId: 'req-1' },
    });
    expect((await store.getOutbox('req-1'))?.status).toBe('done');
  });

  it('re-rejects cleanly when the refusal was genuine, leaving the row actionable', async () => {
    await refuse('req-1');
    await store.retryOutbox('req-1');

    apiRequest.mockRejectedValueOnce(
      new FakeApiError(422, 'NO_VALID_SCANS', 'Still nothing to move'),
    );
    await flushOutbox();

    const row = await store.getOutbox('req-1');
    expect(row?.status).toBe('rejected');
    // Still listed and still retryable — a second refusal must not strand the row.
    expect(await store.openOutbox()).toHaveLength(1);
    expect(JSON.parse(row!.result!).message).toBe('Still nothing to move');
  });

  it('leaves a pending row untouched — it is already queued', async () => {
    await queue('req-1');
    const before = await store.getOutbox('req-1');

    await store.retryOutbox('req-1');

    expect(await store.getOutbox('req-1')).toEqual(before);
  });

  it('never resurrects an accepted row', async () => {
    apiRequest.mockResolvedValueOnce({ transfer: { id: 't1' } });
    await queue('req-1');
    await flushOutbox();

    await store.retryOutbox('req-1');

    // A `done` row that flipped back to pending would re-POST work the server has
    // already accepted; the id makes that harmless, but it must not happen at all.
    expect((await store.getOutbox('req-1'))?.status).toBe('done');
    expect(await store.dueOutbox(Date.now())).toHaveLength(0);
  });

  it('is a no-op on an id that is not in the queue', async () => {
    await expect(store.retryOutbox('nope')).resolves.toBeUndefined();
  });
});

describe('discardOutbox', () => {
  it('removes a rejected row for good', async () => {
    await refuse('req-1');

    await store.discardOutbox('req-1');

    expect(await store.getOutbox('req-1')).toBeNull();
    expect(await store.openOutbox()).toHaveLength(0);
  });

  it('refuses to bin unsent work', async () => {
    // A pending row is field work that has never reached the server. Discarding it
    // would lose a real cylinder movement silently.
    await queue('req-1');

    await store.discardOutbox('req-1');

    expect((await store.getOutbox('req-1'))?.status).toBe('pending');
  });

  it('leaves accepted rows to clearSettled', async () => {
    apiRequest.mockResolvedValueOnce({ transfer: { id: 't1' } });
    await queue('req-1');
    await flushOutbox();

    await store.discardOutbox('req-1');
    expect((await store.getOutbox('req-1'))?.status).toBe('done');

    await store.clearSettled();
    expect(await store.getOutbox('req-1')).toBeNull();
  });

  it('is a no-op on an unknown id', async () => {
    await expect(store.discardOutbox('nope')).resolves.toBeUndefined();
  });
});

describe('queue composition', () => {
  it('separates waiting work from work needing attention', async () => {
    await refuse('bad-1');
    await queue('good-1');
    await queue('good-2');

    const open = await store.openOutbox();
    expect(open.filter((r) => r.status === 'pending')).toHaveLength(2);
    expect(open.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('carries returns as well as transfers', async () => {
    await queue('t-1', 'transfer');
    await queue('r-1', 'return');

    const open = await store.openOutbox();
    expect(open.map((r) => r.kind).sort()).toEqual(['return', 'transfer']);
    expect(open.find((r) => r.kind === 'return')?.path).toBe('/returns');
  });

  it('keeps the refusal detail the queue screen renders per serial', async () => {
    await refuse('req-1');

    const row = await store.getOutbox('req-1');
    const body = JSON.parse(row!.result!) as {
      code: string;
      details: { rejected: { serialCode: string }[] };
    };
    expect(body.code).toBe('NO_VALID_SCANS');
    expect(body.details.rejected[0].serialCode).toBe('NIT26-001');
  });
});
