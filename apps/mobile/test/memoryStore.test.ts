import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryStore } from '../src/db/memoryStore';
import type { Store } from '../src/db/store';

let store: Store;

const enqueue = (id: string, label = 'x') =>
  store.enqueue({ id, kind: 'transfer', path: '/transfers', payload: '{}', label });

beforeEach(() => {
  store = createMemoryStore();
});

describe('outbox', () => {
  it('re-enqueuing the same id does not create a second row or reset its attempts', async () => {
    // This is the offline contract: the id IS the clientRequestId, so a screen that
    // submits twice must not produce two queued transfers.
    await enqueue('req-1', 'first');
    await store.deferOutbox('req-1', 0, 'network down');

    const second = await enqueue('req-1', 'second');

    expect(second.label).toBe('first');
    expect(second.attempts).toBe(1);
    expect(await store.openOutbox()).toHaveLength(1);
  });

  it('hides a row until its backoff has elapsed, then offers it again', async () => {
    await enqueue('req-1');
    const now = Date.now();
    await store.deferOutbox('req-1', now + 10_000, 'timeout');

    expect(await store.dueOutbox(now)).toHaveLength(0);
    expect(await store.dueOutbox(now + 10_001)).toHaveLength(1);
  });

  it('returns due rows oldest-first so work replays in the order it happened', async () => {
    await enqueue('older');
    await new Promise((r) => setTimeout(r, 2));
    await enqueue('newer');

    const due = await store.dueOutbox(Date.now());
    expect(due.map((r) => r.id)).toEqual(['older', 'newer']);
  });

  it('a settled row leaves the queue; a rejected one stays visible for a human', async () => {
    await enqueue('sent');
    await enqueue('refused');
    await store.settleOutbox('sent', 'done', '{"ok":true}');
    await store.settleOutbox('refused', 'rejected', '{"code":"NO_VALID_SCANS"}');

    expect(await store.dueOutbox(Date.now())).toHaveLength(0);
    expect((await store.openOutbox()).map((r) => r.id)).toEqual(['refused']);

    await store.clearSettled();
    expect((await store.openOutbox()).map((r) => r.id)).toEqual(['refused']);
  });
});

describe('batch mirror', () => {
  const batch = {
    id: 'b1',
    projectId: 'p1',
    projectNumber: 'PRJ-1',
    siteId: 's1',
    contents: '2 × Nitrogen',
    projectManagerId: 'pm1',
    projectManagerName: 'T. Mashaba',
    status: 'ACTIVE',
    cachedAt: 1,
  };

  it('re-caching replaces the cylinder list rather than merging it', async () => {
    await store.cacheBatch(
      batch,
      [
        {
          serialCode: 'NIT26-001',
          batchId: 'b1',
          gasTypeName: 'Nitrogen',
          status: 'IN_STORES',
          currentSiteId: null,
        },
        {
          serialCode: 'NIT26-002',
          batchId: 'b1',
          gasTypeName: 'Nitrogen',
          status: 'IN_STORES',
          currentSiteId: null,
        },
      ],
      [],
    );
    // A cylinder the server no longer reports must disappear locally — otherwise the
    // scanner would keep accepting a serial that has left this batch.
    await store.cacheBatch(
      batch,
      [
        {
          serialCode: 'NIT26-001',
          batchId: 'b1',
          gasTypeName: 'Nitrogen',
          status: 'DEPLOYED',
          currentSiteId: 's2',
        },
      ],
      [],
    );

    const cyls = await store.getCachedCylinders('b1');
    expect(cyls.map((c) => c.serialCode)).toEqual(['NIT26-001']);
    expect(cyls[0]!.currentSiteId).toBe('s2');
  });

  it('sorts serials numerically so NIT26-1000 follows NIT26-999', async () => {
    await store.cacheBatch(
      batch,
      ['NIT26-1000', 'NIT26-002', 'NIT26-999'].map((serialCode) => ({
        serialCode,
        batchId: 'b1',
        gasTypeName: 'Nitrogen',
        status: 'IN_STORES',
        currentSiteId: null,
      })),
      [],
    );
    expect((await store.getCachedCylinders('b1')).map((c) => c.serialCode)).toEqual([
      'NIT26-002',
      'NIT26-999',
      'NIT26-1000',
    ]);
  });

  it('scopes cached sites to their project', async () => {
    await store.cacheBatch(
      batch,
      [],
      [
        { id: 's1', projectId: 'p1', name: 'Yard A', location: 'JHB' },
        { id: 's9', projectId: 'other', name: 'Foreign', location: 'CPT' },
      ],
    );
    expect((await store.getCachedSites('p1')).map((s) => s.id)).toEqual(['s1']);
  });
});
