import { useState } from 'react';
import { useRouter, type Href } from 'expo-router';
import { summariseLines, type BatchSummary } from '@gct/shared';
import { ApiError, apiGetBatch, apiGetProject } from '../api/client';
import { getStore } from '../db';
import { BatchBrowser, type BatchBrowserConfig } from '../batches/BatchBrowser';
import { useScanFlow } from './ScanFlowContext';

/**
 * Workflow B1-B2 and C1-C2 are the same screen: find a batch, then select it.
 *
 * Selecting also mirrors the batch locally, because everything after this point —
 * scanning, signing, submitting — is designed to work with no signal. That mirroring
 * is the reason this wrapper exists at all: `BatchBrowser` is a pure list, and the
 * History tab uses it without ever caching anything.
 */
export function BatchPicker({ next, config }: { next: Href; config: BatchBrowserConfig }) {
  const router = useRouter();
  const { selectBatch } = useScanFlow();

  const [caching, setCaching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (b: BatchSummary): Promise<void> => {
    setCaching(b.id);
    setError(null);
    try {
      // Fetch the full cylinder list AND the project's sites now, while we still have
      // signal: every later screen reads from the local mirror, so the user can walk
      // into a dead spot after this point.
      const [{ batch }, { project }] = await Promise.all([
        apiGetBatch(b.id),
        apiGetProject(b.projectId),
      ]);

      const cached = {
        id: batch.id,
        projectId: batch.projectId,
        projectNumber: batch.projectNumber,
        siteId: batch.siteId,
        contents: summariseLines(batch.lines),
        projectManagerId: batch.projectManagerId,
        projectManagerName: batch.projectManagerName,
        status: batch.status,
        cachedAt: Date.now(),
      };
      // Each cylinder carries its own gas name, resolved from the line it belongs to.
      // A batch can hold several gases now, so the scan checklist has to be able to
      // group them without another round trip — which it will not have offline.
      const gasByLine = new Map(batch.lines.map((l) => [l.id, l.gasTypeName]));
      // Cylinders already returned are terminal — they cannot move or come back
      // again, so they are left out of the checklist the scanner works against.
      const cylinders = batch.cylinders
        .filter((c) => c.status !== 'RETURNED')
        .map((c) => ({
          serialCode: c.serialCode,
          batchId: batch.id,
          gasTypeName: gasByLine.get(c.batchLineId) ?? '—',
          status: c.status,
          currentSiteId: c.currentSiteId,
        }));
      const sites = project.sites.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        name: s.name,
        location: s.location,
      }));

      const store = await getStore();
      await store.cacheBatch(cached, cylinders, sites);
      selectBatch(cached, cylinders, sites);
      router.push(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this batch for offline use.');
    } finally {
      setCaching(null);
    }
  };

  return (
    <BatchBrowser
      config={config}
      onPick={(b) => void pick(b)}
      busyBatchId={caching}
      error={error}
    />
  );
}
