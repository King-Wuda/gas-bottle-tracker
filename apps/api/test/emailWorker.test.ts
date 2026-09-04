import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { processPendingEmails } from '../src/services/emailWorker.js';
import { capturedMail, clearCapturedMail } from '../src/services/mailer/index.js';
import { readFileAt } from '../src/services/storage.js';
import { qrPayloadFor } from '../src/services/qr.js';
import {
  loginAs,
  bearer,
  DEMO,
  initializeBatch,
  makeProjectManager,
  resetDb,
  supplierForGas,
  testPhoto,
  uniqueProjectNumber,
  testDriverId,
} from './helpers.js';

let app: FastifyInstance;
let techToken: string;
let storesToken: string;
let pmEmail: string;
let batchId: string;
let serials: string[];

beforeAll(async () => {
  clearCapturedMail();
  await resetDb(); // exact drain counts regardless of other suites

  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);

  const workerPm = await makeProjectManager('Worker PM');
  pmEmail = workerPm.email;
  const project = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: workerPm.id,
      site: { name: 'Worker Yard', location: 'JHB' },
    },
  });
  const projectId = project.json().project.id;
  const siteId = project.json().project.sites[0].id;

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  const nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  const supplierId = await supplierForGas(nitrogenId);

  const batch = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: bearer(techToken),
    payload: {
      projectId,
      siteId,
      clientRequestId: randomUUID(),
      lines: [
        {
          gasTypeId: nitrogenId,
          supplierId,
          quantity: 5,
          initialDeliveryPoint: 'STORES',
        },
      ],
    },
  });
  batchId = batch.json().batch.id;
  serials = batch.json().serials;
  // The delivery-note test returns cylinders, and a return needs the batch scanned in.
  await initializeBatch(app, techToken, batchId, serials);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('email worker — QR sheet', () => {
  it('renders a PDF, marks the row SENT, and hands it to the transport', async () => {
    const pending = await prisma.outboundEmail.findFirstOrThrow({
      where: { type: 'QR_SHEET', payload: { path: ['batchId'], equals: batchId } },
    });
    expect(pending.status).toBe('PENDING');

    const processed = await processPendingEmails(10);
    expect(processed).toBeGreaterThanOrEqual(1);

    const row = await prisma.outboundEmail.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.status).toBe('SENT');
    expect(row.sentAt).not.toBeNull();
    expect(row.attachmentPaths).toHaveLength(1);

    const pdf = await readFileAt(row.attachmentPaths[0]!);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000); // 5 QR codes -> non-trivial

    // What the transport was actually handed — the recipient, and a real PDF under a
    // name the project manager will see in their client.
    const delivered = capturedMail().filter((m) => m.to === pmEmail);
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    const attachments = delivered[0]!.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.contentType).toBe('application/pdf');
    expect(attachments[0]!.filename.toLowerCase()).toContain('qr-sheet');
    expect(attachments[0]!.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('re-running the drain is a no-op (row already SENT)', async () => {
    const processed = await processPendingEmails(10);
    expect(processed).toBe(0);
  });
});

/**
 * Extracts the readable text from a pdfkit document. Three layers to get through:
 * content streams are Flate-compressed; show-text operands are hex-encoded
 * (`<50524a2d31>` = "PRJ-1"); and pdfkit splits a single string across several
 * operands to insert kerning (`[<Deliv> 25 <er> -30 <y Note> 0] TJ`). Reassembling
 * per TJ operator lets these assertions check what the PM will actually read, rather
 * than just "it is a PDF and it is big".
 */
function pdfText(pdf: Buffer): string {
  const streams: string[] = [];
  let i = 0;
  for (;;) {
    const start = pdf.indexOf('stream', i);
    if (start === -1) break;
    const end = pdf.indexOf('endstream', start);
    if (end === -1) break;
    let from = start + 'stream'.length;
    if (pdf[from] === 0x0d) from++;
    if (pdf[from] === 0x0a) from++;
    try {
      streams.push(inflateSync(pdf.subarray(from, end)).toString('latin1'));
    } catch {
      // Not deflated — e.g. the embedded signature PNG. Not text; skip it.
    }
    i = end + 'endstream'.length;
  }

  const lines: string[] = [];
  for (const [, inner] of streams.join('\n').matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    const run = [...(inner ?? '').matchAll(/<([0-9a-fA-F]+)>/g)]
      .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
      .join('');
    if (run) lines.push(run);
  }
  return lines.join('\n');
}

describe('email worker — delivery note', () => {
  /** 1×1 PNG; the note embeds whatever the driver actually drew. */
  const SIGNATURE =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('renders the signed note, records its path on the return, and emails the PM', async () => {
    const returned = await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        scans: serials.slice(0, 3).map((serialCode) => ({
          serialCode,
          qrPayload: qrPayloadFor(serialCode),
          scannedAt: new Date().toISOString(),
        })),
        driverName: 'Thabo Mokoena',
        ...testDriverId(),
        signaturePng: SIGNATURE,
      },
    });
    expect(returned.statusCode).toBe(201);
    const returnRecordId = returned.json().returnRecord.id as string;

    const pending = await prisma.outboundEmail.findFirstOrThrow({
      where: {
        type: 'DELIVERY_NOTE',
        payload: { path: ['returnRecordId'], equals: returnRecordId },
      },
    });
    expect(pending.status).toBe('PENDING');

    expect(await processPendingEmails(10)).toBeGreaterThanOrEqual(1);

    const row = await prisma.outboundEmail.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.status).toBe('SENT');
    expect(row.attachmentPaths).toHaveLength(1);

    const pdf = await readFileAt(row.attachmentPaths[0]!);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The serials and the driver's name must actually appear in the note — that IS
    // the evidence the PM is being sent.
    const text = pdfText(pdf);
    for (const serial of serials.slice(0, 3)) expect(text).toContain(serial);
    expect(text).toContain('Thabo Mokoena');
    // The identity half of the note: the number off the driver's document, and the
    // heading under which their ID photo is embedded.
    expect(text).toContain('8801015009087');
    expect(text).toContain('ID DOCUMENT PRESENTED');
    expect(text).toContain('Delivery Note');
    // 3 of 5 came back, so the note must say the batch is not finished.
    expect(text).toContain('outstanding');
    // …and must NOT list the two cylinders that stayed out.
    for (const serial of serials.slice(3)) expect(text).not.toContain(serial);

    // The worker writes the note's location back onto the record.
    const record = await prisma.returnRecord.findUniqueOrThrow({ where: { id: returnRecordId } });
    expect(record.deliveryNotePath).toBe(row.attachmentPaths[0]);

    const notes = capturedMail()
      .filter((m) => m.to === pmEmail)
      .flatMap((m) => m.attachments ?? []);
    expect(notes.some((a) => a.filename.toLowerCase().includes('delivery-note'))).toBe(true);
  });
});
