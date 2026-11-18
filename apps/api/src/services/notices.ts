import type { Prisma } from '../db.js';

/**
 * The email a project manager gets on every transfer of one of their batches.
 *
 * Written from the transfer's own movement events, inside the transaction that created
 * them, so it lists exactly the cylinders that moved — never the ones merely scanned
 * and then rejected. The batch photo and the driver's ID go as attachments, read from
 * storage when the worker sends it (see `emailWorker.ts`), the same way the delivery
 * note is rendered at send time.
 */
export async function transferNotice(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<{ subject: string; text: string }> {
  const t = await tx.transfer.findUniqueOrThrow({
    where: { id: transferId },
    include: {
      user: { select: { name: true } },
      destinationSite: { select: { location: true } },
      batch: {
        select: {
          project: { select: { projectNumber: true } },
          site: { select: { client: { select: { name: true } } } },
        },
      },
      movementEvents: {
        select: {
          cage: true,
          contents: true,
          overridden: true,
          fromSite: { select: { location: true } },
          cylinder: { select: { serialCode: true, gasType: { select: { name: true } } } },
        },
        orderBy: { cylinder: { serialCode: 'asc' } },
      },
    },
  });

  const toStores = t.destinationType === 'STORES';
  const destination = toStores ? 'Stores' : (t.destinationSite?.location ?? 'a site');
  const n = t.movementEvents.length;
  const client = t.batch.site.client.name;
  const projectNumber = t.batch.project.projectNumber;

  const lines = t.movementEvents.map((m) => {
    const from = m.fromSite?.location ?? 'Stores';
    const where = toStores && m.cage ? `, cage ${m.cage}` : '';
    const state = toStores && m.contents ? `, ${m.contents === 'EMPTY' ? 'EMPTY' : 'full'}` : '';
    const unscanned = m.overridden ? ' (not scanned — project manager override)' : '';
    return `  ${m.cylinder.serialCode}  ${m.cylinder.gasType.name}  ${from} → ${destination}${where}${state}${unscanned}`;
  });

  const empty = t.movementEvents.filter((m) => m.contents === 'EMPTY').length;
  const summary = toStores
    ? `${n} cylinder(s) came back to stores: ${n - empty} full, ${empty} empty.`
    : `${n} cylinder(s) were sent to ${destination}.`;

  const text = [
    `Project ${projectNumber} — ${client}`,
    summary,
    '',
    'Driver',
    `  Name:       ${t.driverName ?? '—'}`,
    `  Phone:      ${t.driverPhone ?? '—'}`,
    `  ID number:  ${t.driverIdNumber ?? '—'}`,
    t.driverIdOverridden
      ? '  ID photo:   not taken — waived by a project manager'
      : '  ID photo:   attached',
    '',
    `Recorded by ${t.user.name} on ${t.createdAt.toISOString().replace('T', ' ').slice(0, 16)} UTC.`,
    t.photoOverridden
      ? 'Batch photo: not taken — waived by a project manager.'
      : 'Batch photo: attached.',
    '',
    'Cylinders',
    ...lines,
  ].join('\n');

  return {
    subject: `Transfer — ${n} cylinder(s) to ${destination}, project ${projectNumber}`,
    text,
  };
}
