import { BatchPicker } from '../../src/scanning/BatchPicker';

/**
 * Section 9 — the Returns list.
 *
 * `active` drops only the batches with nothing left to bring back. A partly-returned
 * batch stays, because the cylinders still out are exactly what this screen is for.
 */
export default function ReturnsFindBatch() {
  return (
    <BatchPicker
      next="/returns/scan"
      config={{
        scope: 'returns',
        status: 'active',
        intro: 'Pick the batch the driver is collecting, then scan what goes back.',
        emptyTitle: 'Nothing outstanding',
        emptyHint: 'Every batch has been fully returned.',
      }}
    />
  );
}
