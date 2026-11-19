import type { Prisma } from '../db.js';

/**
 * The email a project manager gets on every transfer of one of their batches.
 *
 * Written from the transfer's own movement events, inside the transaction that created
 * them, so it lists exactly the cylinders that moved — never the ones merely scanned
 * and then rejected. The batch photo goes as an attachment (and, on transfers recorded
 * while it was still asked for, the photo of the driver's ID), read from
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
    `  Email:      ${t.driverEmail ?? '—'}`,
    // Only transfers recorded while the driver's ID was still asked for have these.
    ...(t.driverIdNumber ? [`  ID number:  ${t.driverIdNumber}`] : []),
    ...(t.driverIdPath ? ['  ID photo:   attached'] : []),
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

/**
 * Every active stores manager gets a copy of each event email — a new batch's QR sheet,
 * every transfer notice and every return's delivery note — so stores knows what is
 * coming in and going out without waiting to be told.
 *
 * A copy is the same email (same type, subject, body and attachments, rendered by the
 * worker from the same payload) to a different address, marked `copy: 'stores'` in its
 * payload so the batch screen's "was the QR sheet delivered?" keeps reporting on the
 * project manager's email, not on whichever copy happened to be queued last. Nobody gets
 * it twice: an address already on the event is skipped.
 */
export async function copyToStoresManagers(
  tx: Prisma.TransactionClient,
  email: {
    type: 'QR_SHEET' | 'TRANSFER_NOTICE' | 'DELIVERY_NOTE';
    subject: string;
    bodyText: string;
    payload: Record<string, string | boolean>;
    alreadyTo: string;
  },
): Promise<number> {
  const managers = await tx.user.findMany({
    where: { role: 'STORES_MANAGER', active: true, deletedAt: null },
    select: { email: true },
  });
  const skip = email.alreadyTo.trim().toLowerCase();
  const to = [...new Set(managers.map((m) => m.email.trim().toLowerCase()))].filter(
    (address) => address !== skip,
  );
  if (to.length === 0) return 0;
  await tx.outboundEmail.createMany({
    data: to.map((address) => ({
      to: address,
      type: email.type,
      subject: email.subject,
      bodyText: email.bodyText,
      payload: { ...email.payload, copy: 'stores' },
    })),
  });
  return to.length;
}
