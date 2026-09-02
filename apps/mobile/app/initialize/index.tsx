import { BatchPicker } from '../../src/scanning/BatchPicker';

/**
 * The Initialize list — batches that have been created but never scanned in.
 *
 * `scope: 'initialize'` is the mirror image of what Transfer and Returns ask for:
 * they show only batches that HAVE been initialized, this shows only the ones that
 * have not. A batch leaves this list the moment it is initialized and appears in the
 * other two, which is the whole lifecycle in one filter.
 */
export default function InitializeFindBatch() {
  return (
    <BatchPicker
      next="/initialize/scan"
      config={{
        scope: 'initialize',
        // `all` rather than `active`: an uninitialized batch cannot have been
        // returned, so there is nothing for the status filter to usefully remove.
        status: 'all',
        intro:
          'Pick the batch whose QR labels have been printed and stuck on, then scan every ' +
          'cylinder and photograph the batch where it stands.',
        emptyTitle: 'Nothing waiting to be initialized',
        emptyHint:
          'Every batch on record has had its first scan. A new batch appears here as soon as it ' +
          'is created.',
      }}
    />
  );
}
