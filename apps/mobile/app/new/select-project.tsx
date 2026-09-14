import { useRouter } from 'expo-router';
import type { BatchSummary } from '@gct/shared';
import { BatchBrowser } from '../../src/batches/BatchBrowser';

/**
 * "Edit existing site" — find a batch you have already booked in.
 *
 * This is the same list Transfers and Returns use, and that is the whole change: it
 * used to be a bespoke search over PROJECT NUMBERS, which meant knowing the number of
 * the job you were looking for. Nobody in the yard thinks that way. They think "the
 * McCains delivery we did last week", and the batch list is the thing that can be
 * searched by client, site, manager, gas or supplier to find it.
 *
 * Tapping a row opens that batch in full — its cylinders, QR sheet and delivery
 * status. Adding another batch to the same site starts from there, so this screen
 * stays a way of looking things up rather than a second, slightly different way of
 * creating them.
 *
 * Nothing is scoped away: `history` shows every batch including fully-returned ones,
 * because a returned batch still tells you where a client takes delivery, which is
 * exactly what someone on this screen is trying to find out.
 */
export default function SelectProject() {
  const router = useRouter();

  return (
    <BatchBrowser
      config={{
        scope: 'history',
        status: 'all',
        intro:
          'Find a batch you have already booked in — search by client, site, project number, ' +
          'manager, gas or supplier. Open it to see it in full, or to add another batch to the ' +
          'same site.',
        emptyTitle: 'No batches yet',
        emptyHint: 'Create the first one from "Create new site".',
      }}
      onPick={(batch: BatchSummary) => router.push(`/history/batch/${batch.id}`)}
    />
  );
}
