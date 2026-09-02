import PDFDocument from 'pdfkit';

export interface QrSheetCell {
  serialCode: string;
  qrPng: Buffer;
  /** This cylinder's own gas and supplier — they differ line to line within a batch. */
  gasTypeName: string;
  supplierName: string;
}

export interface QrSheetMeta {
  projectNumber: string;
  projectManagerName: string;
  siteName: string;
  siteLocation: string;
  /** When the batch was booked in — the date printed on every label. */
  createdAt: Date;
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 40;

/**
 * 2 × 3 labels per A4 page.
 *
 * The old sheet was a 3 × 4 grid of bare QR codes with the batch details printed once
 * in the page header. That works while the sheet is intact and stops working the
 * moment it is cut up — which is exactly what happens to it, because each label gets
 * stuck on a different cylinder that then goes to a different place. A label that has
 * left the sheet has to be able to answer "what is this and whose is it?" on its own,
 * so every label now carries the batch's details itself. Six per page is what that
 * costs, and the trade is worth it: the sheet is printed once, the labels are read for
 * the life of the rental.
 */
const COLS = 2;
const ROWS = 3;

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

const labelDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(d);

/** A4 sheet of self-describing QR labels — one per cylinder — for the PM to print. */
export async function renderQrSheet(meta: QrSheetMeta, cells: QrSheetCell[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, autoFirstPage: false });
  const done = collect(doc);

  const gridW = PAGE.width - MARGIN * 2;
  const headerH = 34;
  const cellW = gridW / COLS;
  const cellH = (PAGE.height - MARGIN * 2 - headerH) / ROWS;
  const perPage = COLS * ROWS;

  // Inside one label: a detail block on the left, the QR square on the right, and the
  // serial across the bottom in the largest type on the label — it is what a person
  // reads out over the phone when the camera will not focus.
  const PAD = 10;
  // Sized to fill the space the detail block leaves rather than a round number: a
  // bigger module size is the difference between a scan that works across a yard in
  // low light and one that needs the phone held against the cylinder.
  const qrSize = 150;
  const detailW = cellW - qrSize - PAD * 3;

  const detail = (x: number, y: number, label: string, value: string): number => {
    doc.fontSize(6.5).fillColor('#777').text(label.toUpperCase(), x, y, { width: detailW });
    doc
      .fontSize(8.5)
      .fillColor('#111')
      .text(value, x, y + 8, { width: detailW, lineBreak: true });
    // Advance by what the value actually consumed, so a long site name pushes the
    // next row down instead of being overprinted by it.
    return y + 8 + doc.heightOfString(value, { width: detailW }) + 4;
  };

  cells.forEach((cell, i) => {
    if (i % perPage === 0) {
      doc.addPage();
      doc
        .fontSize(12)
        .fillColor('#000')
        .text(`Cylinder labels — ${meta.projectNumber}`, MARGIN, MARGIN);
      doc
        .fontSize(8)
        .fillColor('#666')
        .text(
          `${meta.siteName} · ${cells.length} label(s) · page ${Math.floor(i / perPage) + 1} of ` +
            `${Math.ceil(cells.length / perPage)} · cut along the boxes`,
          MARGIN,
          MARGIN + 16,
        );
    }

    const idx = i % perPage;
    const x = MARGIN + (idx % COLS) * cellW;
    const y = MARGIN + headerH + Math.floor(idx / COLS) * cellH;

    // The cut line. Dashed so it reads as "cut here" rather than as a table border.
    doc
      .save()
      .dash(2, { space: 2 })
      .rect(x + 3, y + 3, cellW - 6, cellH - 6)
      .strokeColor('#bbb')
      .lineWidth(0.5)
      .stroke()
      .restore();

    let dy = y + PAD + 2;
    dy = detail(x + PAD, dy, 'Project', meta.projectNumber);
    dy = detail(x + PAD, dy, 'Project manager', meta.projectManagerName);
    dy = detail(x + PAD, dy, 'Gas', cell.gasTypeName);
    dy = detail(x + PAD, dy, 'Supplier', cell.supplierName);
    dy = detail(x + PAD, dy, 'Site', `${meta.siteName} — ${meta.siteLocation}`);
    detail(x + PAD, dy, 'Date', labelDate(meta.createdAt));

    doc.image(cell.qrPng, x + cellW - qrSize - PAD, y + PAD + 2, {
      width: qrSize,
      height: qrSize,
    });

    doc
      .fontSize(15)
      .fillColor('#000')
      .text(cell.serialCode, x + PAD, y + cellH - 30, {
        width: cellW - PAD * 2,
        align: 'center',
      });
  });

  if (cells.length === 0) {
    doc.addPage().fontSize(12).text('No cylinders in this batch.', MARGIN, MARGIN);
  }

  doc.end();
  return done;
}

export interface DeliveryNoteRow {
  serialCode: string;
  /** A batch can hold several gases, so the note names each cylinder's own. */
  gasTypeName: string;
  /** Where the cylinder was collected from — a site name, or "Stores". */
  fromLocation: string;
  /** Device clock at the moment it was scanned back in. */
  scannedAt: Date;
  /** TRUE when an admin recorded this return without scanning the cylinder. Printed,
   *  because the note is the evidence someone signs against. */
  overridden: boolean;
}

export interface DeliveryNoteMeta {
  noteNumber: string;
  projectNumber: string;
  projectManagerName: string;
  projectManagerEmail: string;
  siteName: string;
  /** "7 × Nitrogen (Afrox), 4 × Argon (Air Products)" — the batch is no longer one gas. */
  contents: string;
  driverName: string;
  storesManagerName: string;
  returnedAt: Date;
  /** Cylinders from this batch still not returned — the batch is PARTIAL if > 0. */
  outstandingCount: number;
}

const fmt = (d: Date): string =>
  `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;

/**
 * The signed delivery note emailed to the PM on return (Workflow C5). This is the
 * document that proves a cylinder stopped accruing rental and who signed for it, so
 * it carries the serials, both timestamps, and the driver's actual signature image.
 */
export async function renderDeliveryNote(
  meta: DeliveryNoteMeta,
  rows: DeliveryNoteRow[],
  signaturePng: Buffer,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, autoFirstPage: false });
  const done = collect(doc);

  const contentW = PAGE.width - MARGIN * 2;
  const cols = { serial: MARGIN, gas: MARGIN + 110, from: MARGIN + 220, at: MARGIN + 360 };

  const tableHeader = (y: number): void => {
    doc.fontSize(9).fillColor('#555');
    doc.text('SERIAL', cols.serial, y);
    doc.text('GAS', cols.gas, y);
    doc.text('COLLECTED FROM', cols.from, y);
    doc.text('SCANNED AT', cols.at, y);
    doc
      .moveTo(MARGIN, y + 13)
      .lineTo(MARGIN + contentW, y + 13)
      .strokeColor('#bbb')
      .stroke();
  };

  doc.addPage();
  doc.fontSize(20).fillColor('#000').text('Delivery Note', MARGIN, MARGIN);
  doc
    .fontSize(9)
    .fillColor('#555')
    .text(`No. ${meta.noteNumber}`, MARGIN, MARGIN + 26);

  let y = MARGIN + 52;
  const line = (label: string, value: string): void => {
    doc.fontSize(9).fillColor('#555').text(label, MARGIN, y);
    doc
      .fontSize(11)
      .fillColor('#000')
      .text(value, MARGIN + 130, y - 2);
    y += 18;
  };
  line('Project', meta.projectNumber);
  line('Project Manager', `${meta.projectManagerName} <${meta.projectManagerEmail}>`);
  line('Site', meta.siteName);
  line('Contents', meta.contents);
  line('Returned', fmt(meta.returnedAt));
  line('Received by', meta.storesManagerName);
  line('Cylinders returned', String(rows.length));
  const overriddenCount = rows.filter((r) => r.overridden).length;
  if (overriddenCount > 0) {
    line('Recorded without a scan', `${overriddenCount} — marked "no scan" below`);
  }
  if (meta.outstandingCount > 0) {
    doc
      .fontSize(10)
      .fillColor('#b8860b')
      .text(
        `${meta.outstandingCount} cylinder(s) from this batch remain outstanding — this is a PARTIAL return.`,
        MARGIN,
        y,
      );
    y += 20;
  }

  y += 10;
  tableHeader(y);
  y += 20;

  // Reserve room for the signature block so the last rows never collide with it.
  const SIGNATURE_BLOCK_H = 150;
  const pageBottom = PAGE.height - MARGIN - SIGNATURE_BLOCK_H;

  for (const row of rows) {
    if (y > pageBottom) {
      doc.addPage();
      y = MARGIN;
      tableHeader(y);
      y += 20;
    }
    doc.fontSize(10).fillColor('#000').text(row.serialCode, cols.serial, y);
    doc.fillColor('#333').text(row.gasTypeName, cols.gas, y, { width: 100 });
    doc.fillColor('#333').text(row.fromLocation, cols.from, y, { width: 130 });
    doc.fillColor('#333').text(fmt(row.scannedAt), cols.at, y);
    if (row.overridden) {
      // Marked on the note itself, not just in the database: the person signing this
      // is entitled to see which lines were verified by a scan and which were not.
      doc
        .fontSize(7)
        .fillColor('#b8860b')
        .text('no scan', cols.at + 108, y + 1);
    }
    y += 16;
  }

  // Signature block — always at the foot of the final page.
  const sigY = PAGE.height - MARGIN - SIGNATURE_BLOCK_H + 20;
  doc
    .moveTo(MARGIN, sigY - 10)
    .lineTo(MARGIN + contentW, sigY - 10)
    .strokeColor('#bbb')
    .stroke();
  doc.fontSize(9).fillColor('#555').text('COLLECTION DRIVER — SIGNED ON DEVICE', MARGIN, sigY);
  try {
    doc.image(signaturePng, MARGIN, sigY + 16, { fit: [220, 80] });
  } catch {
    // A signature that will not decode must not lose the whole note — the rest of
    // the document is still the evidence that matters.
    doc
      .fontSize(10)
      .fillColor('#c0392b')
      .text('[signature image unavailable]', MARGIN, sigY + 30);
  }
  doc
    .moveTo(MARGIN, sigY + 102)
    .lineTo(MARGIN + 240, sigY + 102)
    .strokeColor('#333')
    .stroke();
  doc
    .fontSize(11)
    .fillColor('#000')
    .text(meta.driverName, MARGIN, sigY + 108);
  doc
    .fontSize(9)
    .fillColor('#555')
    .text(fmt(meta.returnedAt), MARGIN + 300, sigY + 108);

  doc.end();
  return done;
}
