import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../db.js';
import { getMailer, type MailAttachment } from './mailer/index.js';
import { renderQrPng } from './qr.js';
import { renderDeliveryNote, renderQrSheet } from './pdf.js';
import { readFileAt, saveFile } from './storage.js';

const MAX_ATTEMPTS = 5;
const POLL_MS = 3000;

/** How long a row may sit in SENDING before another worker may re-claim it. */
const STALE_SENDING_MS = 5 * 60_000;

/**
 * Atomically claim up to `limit` rows (status -> SENDING).
 *
 * Also re-claims rows stranded in SENDING: only processOne moves a row out of that
 * state, so a crash between the claim and the send (PDF render + SMTP, easily
 * hundreds of ms) would otherwise strand the row forever and the PM would never get
 * their QR sheet. `updatedAt` is stamped by this statement, so it doubles as the
 * lease clock.
 */
async function claim(limit: number): Promise<string[]> {
  const staleBefore = new Date(Date.now() - STALE_SENDING_MS);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "OutboundEmail"
    SET "status" = 'SENDING', "attempts" = "attempts" + 1, "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "OutboundEmail"
      WHERE "attempts" < ${MAX_ATTEMPTS}
        AND (
          "status" = 'PENDING'
          OR ("status" = 'SENDING' AND "updatedAt" < ${staleBefore})
        )
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `;
  return rows.map((r) => r.id);
}

async function buildQrSheet(
  batchId: string,
): Promise<{ attachment: MailAttachment; relPath: string }> {
  const batch = await prisma.batch.findUniqueOrThrow({
    where: { id: batchId },
    include: {
      project: true,
      projectManager: true,
      site: true,
      lines: { include: { gasType: { select: { name: true } } } },
      cylinders: { orderBy: { serialCode: 'asc' } },
    },
  });

  // Each label names its OWN gas and supplier, which within one batch differ line to
  // line. Reading them off the batch would print "Nitrogen" on the argon labels.
  const lineById = new Map(batch.lines.map((l) => [l.id, l]));

  const cells = await Promise.all(
    batch.cylinders.map(async (c) => {
      const line = lineById.get(c.batchLineId);
      return {
        serialCode: c.serialCode,
        qrPng: await renderQrPng(c.serialCode),
        gasTypeName: line?.gasType.name ?? '—',
        supplierName: line?.supplierName ?? '—',
      };
    }),
  );
  const pdf = await renderQrSheet(
    {
      projectNumber: batch.project.projectNumber,
      projectManagerName: batch.projectManager.name,
      siteName: batch.site.name,
      siteLocation: batch.site.location,
      createdAt: batch.createdAt,
    },
    cells,
  );

  const relPath = await saveFile('qr', `qr-sheet-${batchId}.pdf`, pdf);
  return {
    relPath,
    attachment: {
      filename: `qr-sheet-${batch.project.projectNumber}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    },
  };
}

/**
 * Renders the signed delivery note at SEND time, from the movement events the return
 * actually created — so the note lists exactly the cylinders that were marked
 * returned, never the ones merely scanned.
 */
async function buildDeliveryNote(
  returnRecordId: string,
): Promise<{ attachment: MailAttachment; relPath: string }> {
  const record = await prisma.returnRecord.findUniqueOrThrow({
    where: { id: returnRecordId },
    include: {
      storesManager: { select: { name: true } },
      batch: {
        include: {
          project: true,
          projectManager: true,
          site: true,
          lines: { include: { gasType: { select: { name: true } } } },
        },
      },
      movementEvents: {
        include: {
          cylinder: { select: { serialCode: true, gasType: { select: { name: true } } } },
          fromSite: { select: { name: true } },
        },
        orderBy: { cylinder: { serialCode: 'asc' } },
      },
    },
  });

  const outstandingCount = await prisma.cylinder.count({
    where: { batchId: record.batchId, status: { not: 'RETURNED' } },
  });

  const pdf = await renderDeliveryNote(
    {
      noteNumber: record.id,
      projectNumber: record.batch.project.projectNumber,
      // The batch's own manager and the address it was actually sent to — a transfer
      // or an admin correction may have handed it to someone else since intake.
      projectManagerName: record.batch.projectManager.name,
      projectManagerEmail: record.batch.projectManagerEmail,
      siteName: record.batch.site.name,
      contents: record.batch.lines
        .map((l) => `${l.quantity} × ${l.gasType.name} (${l.supplierName})`)
        .join(', '),
      driverName: record.driverName,
      storesManagerName: record.storesManager.name,
      returnedAt: record.createdAt,
      outstandingCount,
    },
    record.movementEvents.map((m) => ({
      serialCode: m.cylinder.serialCode,
      gasTypeName: m.cylinder.gasType.name,
      fromLocation: m.fromSite?.name ?? 'Stores',
      scannedAt: m.deviceAt,
      overridden: m.overridden,
    })),
    await readFileAt(record.signaturePath),
  );

  const relPath = await saveFile('notes', `delivery-note-${record.id}.pdf`, pdf);
  // The note's location is part of the audit trail, so record it on the return.
  await prisma.returnRecord.update({
    where: { id: record.id },
    data: { deliveryNotePath: relPath },
  });

  return {
    relPath,
    attachment: {
      filename: `delivery-note-${record.batch.project.projectNumber}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    },
  };
}

async function processOne(id: string, log?: FastifyBaseLogger): Promise<void> {
  const row = await prisma.outboundEmail.findUniqueOrThrow({ where: { id } });
  try {
    let attachments: MailAttachment[] = [];
    let relPaths: string[] = [];

    if (row.type === 'QR_SHEET') {
      const batchId = (row.payload as { batchId?: string } | null)?.batchId;
      if (!batchId) throw new Error('QR_SHEET email has no payload.batchId');
      const { attachment, relPath } = await buildQrSheet(batchId);
      attachments = [attachment];
      relPaths = [relPath];
    } else if (row.type === 'DELIVERY_NOTE') {
      const returnRecordId = (row.payload as { returnRecordId?: string } | null)?.returnRecordId;
      if (!returnRecordId) throw new Error('DELIVERY_NOTE email has no payload.returnRecordId');
      const { attachment, relPath } = await buildDeliveryNote(returnRecordId);
      attachments = [attachment];
      relPaths = [relPath];
    } else {
      throw new Error(`email type ${row.type as string} not supported`);
    }

    await getMailer().send({
      to: row.to,
      subject: row.subject,
      text: row.bodyText,
      html: row.bodyHtml ?? undefined,
      attachments,
    });

    await prisma.outboundEmail.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date(), lastError: null, attachmentPaths: relPaths },
    });
    log?.info({ id, to: row.to, type: row.type }, 'email sent');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const done = row.attempts >= MAX_ATTEMPTS;
    await prisma.outboundEmail.update({
      where: { id },
      data: { status: done ? 'FAILED' : 'PENDING', lastError: message },
    });
    log?.error({ id, err: message, willRetry: !done }, 'email send failed');
  }
}

/** One drain pass. Returns the number of rows processed. Exposed for tests. */
export async function processPendingEmails(limit = 10, log?: FastifyBaseLogger): Promise<number> {
  const ids = await claim(limit);
  for (const id of ids) await processOne(id, log);
  return ids.length;
}

let timer: NodeJS.Timeout | undefined;

export function startEmailWorker(log?: FastifyBaseLogger): void {
  if (timer) return;
  const tick = (): void => {
    void processPendingEmails(10, log).catch((err) =>
      log?.error({ err }, 'email worker tick failed'),
    );
  };
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  tick();
}

export function stopEmailWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
