import { BatchPicker } from '../../src/scanning/BatchPicker';

/**
 * Section 8 — the Transfer list.
 *
 * Nothing is hidden for having moved before. A batch whose 3 nitrogen went to site
 * still has 4 at stores that need moving, and even a batch that went out whole can be
 * moved again — from that site to another, or back. The old "already transferred"
 * exclusion (and the toggle that undid it) assumed a batch moves exactly once, which
 * is simply not how the yard works.
 */
export default function TransferFindBatch() {
  return (
    <BatchPicker
      next="/transfer/scan"
      config={{
        scope: 'transfer',
        // Fully-returned batches are still dropped: a returned cylinder is terminal
        // and can never move again, so offering one would be offering an action that
        // cannot succeed.
        status: 'active',
        intro: 'Pick the batch whose cylinders you are moving, then scan them.',
        emptyTitle: 'Nothing left to transfer',
        emptyHint: 'Every batch on record has been fully returned.',
      }}
    />
  );
}
