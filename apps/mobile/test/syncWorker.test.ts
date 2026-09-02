import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMemoryStore } from '../src/db/memoryStore';
import type { Store } from '../src/db/store';

/**
 * The worker pulls in the fetch client (expo-secure-store) and the store factory
 * (react-native `Platform`), neither of which exists in node. Both are mocked at the
 * module boundary so the drain logic itself can be tested for real.
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

const { flushOutbox, enqueueMutation, backoffFor } = await import('../src/sync/worker');

const queue = (id: string) =>
  enqueueMutation({
    id,
    kind: 'transfer',
    path: '/transfers',
    body: { batchId: 'b1', clientRequestId: id },
    label: '2 cylinders → Yard B',
  });

beforeEach(() => {
  store = createMemoryStore();
  apiRequest.mockReset();
});

describe('flushOutbox', () => {
  it('sends a queued mutation under the id it was minted with, then settles it', async () => {
    apiRequest.mockResolvedValue({ transfer: { id: 't1' } });
    await queue('req-1');

    const summary = await flushOutbox();

    expect(summary.sent).toBe(1);
    // The replayed body must carry the ORIGINAL clientRequestId — that is the whole
    // basis of the server's idempotency.
    expect(apiRequest).toHaveBeenCalledWith('/transfers', {
      method: 'POST',
      body: { batchId: 'b1', clientRequestId: 'req-1' },
    });
    const row = await store.getOutbox('req-1');
    expect(row?.status).toBe('done');
    expect(await store.dueOutbox(Date.now())).toHaveLength(0);
  });

  it('retries a network failure with a growing backoff instead of dropping it', async () => {
    apiRequest.mockRejectedValue(new TypeError('Network request failed'));
    await queue('req-1');

    await flushOutbox();
    const first = await store.getOutbox('req-1');
    expect(first?.status).toBe('pending');
    expect(first?.attempts).toBe(1);
    expect(first!.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(first?.lastError).toContain('Network request failed');

    // Still queued, just not yet due — the work is never lost.
    expect(await store.dueOutbox(Date.now())).toHaveLength(0);
    expect(await store.openOutbox()).toHaveLength(1);
  });

  it('retries a 5xx — that is the server’s problem, not a bad request', async () => {
    apiRequest.mockRejectedValue(new FakeApiError(503, 'UNAVAILABLE', 'down'));
    await queue('req-1');

    const summary = await flushOutbox();
    expect(summary.deferred).toBe(1);
    expect((await store.getOutbox('req-1'))?.status).toBe('pending');
  });

  it('parks a 422 as rejected — replaying identical bytes would loop forever', async () => {
    const details = { rejected: [{ serialCode: 'NIT26-001', code: 'CONFLICT', message: 'moved' }] };
    apiRequest.mockRejectedValue(
      new FakeApiError(422, 'NO_VALID_SCANS', 'nothing could move', details),
    );
    await queue('req-1');

    const summary = await flushOutbox();

    expect(summary.rejected).toBe(1);
    const row = await store.getOutbox('req-1');
    expect(row?.status).toBe('rejected');
    // The refusal detail is kept so the screen can name the offending cylinder.
    expect(JSON.parse(row!.result!).details).toEqual(details);
    expect(await store.dueOutbox(Date.now())).toHaveLength(0);
  });

  it('stops the drain on 401 and leaves everything queued for after re-login', async () => {
    apiRequest.mockRejectedValue(new FakeApiError(401, 'UNAUTHENTICATED', 'expired'));
    await queue('req-1');
    await queue('req-2');

    const summary = await flushOutbox();

    expect(summary.authLost).toBe(true);
    expect(apiRequest).toHaveBeenCalledTimes(1); // stopped, did not burn the second row
    expect(await store.openOutbox()).toHaveLength(2);
    expect((await store.getOutbox('req-1'))?.attempts).toBe(0);
  });

  it('keeps draining after one row is rejected', async () => {
    apiRequest
      .mockRejectedValueOnce(new FakeApiError(422, 'NO_VALID_SCANS', 'no'))
      .mockResolvedValueOnce({ transfer: { id: 't2' } });
    await queue('req-1');
    await new Promise((r) => setTimeout(r, 2));
    await queue('req-2');

    const summary = await flushOutbox();

    expect(summary).toMatchObject({ sent: 1, rejected: 1, deferred: 0 });
    expect((await store.getOutbox('req-2'))?.status).toBe('done');
  });

  it('concurrent flushes share one pass, so a row is never sent twice', async () => {
    let resolve: (v: unknown) => void = () => {};
    apiRequest.mockReturnValue(new Promise((r) => (resolve = r)));
    await queue('req-1');

    const a = flushOutbox();
    const b = flushOutbox();
    resolve({ transfer: { id: 't1' } });
    await Promise.all([a, b]);

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});

describe('backoffFor', () => {
  it('grows exponentially and then caps', () => {
    expect(backoffFor(0)).toBe(5_000);
    expect(backoffFor(1)).toBe(10_000);
    expect(backoffFor(3)).toBe(40_000);
    expect(backoffFor(99)).toBe(5 * 60_000);
  });
});
