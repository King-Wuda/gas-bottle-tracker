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

/** PDF points per millimetre. Every label measurement below is in mm, because that
 *  is what a sticker sheet's packaging and a ruler both say. */
const MM = 72 / 25.4;

/**
 * The sticker sheet the QR labels are printed onto, in millimetres.
 *
 * Each label is one 100 × 75 mm sticker. On an A4 sheet that is at most 2 across ×
 * 3 down (200 mm of the 210 mm width; 225 mm of the 297 mm height) — no other
 * arrangement fits more — and the grid is centred, which is how such sheets are cut.
 * If a sheet with different margins or gaps is bought, THIS is the only thing to
 * change: `origin` pins the top-left sticker, `gap` is the space between stickers.
 *
 * Print at 100% ("Actual size"). "Fit to page" shrinks every label off its sticker.
 */
export const LABEL_SHEET = {
  page: { width: 210, height: 297 },
  label: { width: 100, height: 75 },
  cols: 2,
  rows: 3,
  gap: { x: 0, y: 0 },
  /** Top-left corner of the first sticker; null centres the grid on the page. */
  origin: null as null | { left: number; top: number },
};

export type LabelSheet = typeof LABEL_SHEET;

/** Where each sticker on one sheet is, in PDF points, row by row. */
export function labelSlots(
  sheet: LabelSheet = LABEL_SHEET,
): { x: number; y: number; width: number; height: number }[] {
  const gridW = sheet.cols * sheet.label.width + (sheet.cols - 1) * sheet.gap.x;
  const gridH = sheet.rows * sheet.label.height + (sheet.rows - 1) * sheet.gap.y;
  const left = sheet.origin?.left ?? (sheet.page.width - gridW) / 2;
  const top = sheet.origin?.top ?? (sheet.page.height - gridH) / 2;
  const slots = [];
  for (let r = 0; r < sheet.rows; r++) {
    for (let c = 0; c < sheet.cols; c++) {
      slots.push({
        x: (left + c * (sheet.label.width + sheet.gap.x)) * MM,
        y: (top + r * (sheet.label.height + sheet.gap.y)) * MM,
        width: sheet.label.width * MM,
        height: sheet.label.height * MM,
      });
    }
  }
  return slots;
}

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

/**
 * QR labels, one per cylinder, laid out on 100 × 75 mm stickers — see `LABEL_SHEET`.
 *
 * Every label carries the batch's details itself rather than the page header: the
 * sheet is cut up the moment it is printed, each label goes onto a different cylinder
 * that then goes somewhere different, and a label that has left the sheet still has
 * to answer "what is this and whose is it?" on its own.
 *
 * Inside a label: the QR square on the left, as large as the height allows; the gas
 * in bold beside it, because that is what someone at a cage looks for first; then the
 * batch details; and the serial across the bottom in the largest type on the label —
 * what a person reads out over the phone when the camera will not focus.
 */
export async function renderQrSheet(meta: QrSheetMeta, cells: QrSheetCell[]): Promise<Buffer> {
  // margin 0: every position below is exact, and pdfkit would otherwise start a new
  // page whenever text came near the bottom margin of a sheet whose last row of
  // stickers sits there.
  const doc = new PDFDocument({
    size: [LABEL_SHEET.page.width * MM, LABEL_SHEET.page.height * MM],
    margin: 0,
    autoFirstPage: false,
  });
  const done = collect(doc);

  const slots = labelSlots();
  const perPage = slots.length;
  const pages = Math.ceil(cells.length / perPage);

  const PAD = 4 * MM;
  const SERIAL_H = 11 * MM;
  const QR = LABEL_SHEET.label.height * MM - PAD * 2 - SERIAL_H - 1 * MM;
  const GUTTER = 3 * MM;

  cells.forEach((cell, i) => {
    if (i % perPage === 0) {
      doc.addPage();
      // In the top margin, which on a sticker sheet is the bare edge above the first
      // row — never on a sticker.
      const top = slots[0]!.y;
      if (top >= 10 * MM) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor('#666')
          .text(
            `Cylinder labels — ${meta.projectNumber} · ${meta.siteName} · ` +
              `${cells.length} label(s) · page ${Math.floor(i / perPage) + 1} of ${pages} · ` +
              'print at 100% (Actual size), not "Fit to page"',
            6 * MM,
            Math.max(4 * MM, top / 2 - 4),
            { width: LABEL_SHEET.page.width * MM - 12 * MM, align: 'center', lineBreak: false },
          );
      }
    }

    const { x, y, width, height } = slots[i % perPage]!;

    // The sticker's own edge, hairline and pale: on a sticker sheet it falls on the die
    // cut, and on plain paper it is the line to cut along.
    doc
      .save()
      .dash(1.5, { space: 1.5 })
      .roundedRect(x, y, width, height, 2 * MM)
      .strokeColor('#c8c8c8')
      .lineWidth(0.4)
      .stroke()
      .restore();

    doc.image(cell.qrPng, x + PAD, y + PAD, { width: QR, height: QR });

    // The details column, beside the QR and no taller than it.
    const cx = x + PAD + QR + GUTTER;
    const cw = x + width - PAD - cx;
    let cy = y + PAD;

    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .fillColor('#000')
      .text(cell.gasTypeName, cx, cy, { width: cw, height: 17, ellipsis: true, lineBreak: false });
    cy += 21;

    const field = (label: string, value: string, lines = 1): void => {
      doc.font('Helvetica').fontSize(5.5).fillColor('#777');
      doc.text(label.toUpperCase(), cx, cy, { width: cw, lineBreak: false });
      cy += 7;
      doc.font('Helvetica').fontSize(8).fillColor('#111');
      const lineH = doc.currentLineHeight(true);
      // At most `lines` lines, then "…": a long site name must not run off the
      // sticker or over the next field.
      doc.text(value, cx, cy, { width: cw, height: lineH * lines, ellipsis: true });
      cy += Math.min(doc.heightOfString(value, { width: cw }), lineH * lines) + 3;
    };
    field('Project', meta.projectNumber);
    field('Project manager', meta.projectManagerName, 2);
    field('Supplier', cell.supplierName);
    field('Site', `${meta.siteName} — ${meta.siteLocation}`, 2);
    field('Date', labelDate(meta.createdAt));

    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor('#000')
      .text(cell.serialCode, x + PAD, y + height - PAD - SERIAL_H + 2 * MM, {
        width: width - PAD * 2,
        align: 'center',
        lineBreak: false,
      });
  });

  if (cells.length === 0) {
    doc
      .addPage()
      .font('Helvetica')
      .fontSize(12)
      .text('No cylinders in this batch.', 20 * MM, 20 * MM);
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
  /** Off whatever document the driver presented. Null on returns that predate ID
   *  capture — printed as such, rather than left blank as if nobody had looked. */
  driverIdNumber: string | null;
  /** Null on returns recorded before the phone number was asked for. */
  driverPhone: string | null;
  /** True when an admin waived the ID photograph. Printed, because the note is the
   *  evidence somebody signs against and they are entitled to know what is missing. */
  driverIdOverridden: boolean;
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
 * it carries the serials, both timestamps, the driver's actual signature image and —
 * where one was taken — the ID document they presented.
 *
 * `driverIdImage` is optional and nullable on purpose. A note whose ID photo cannot
 * be read must still render: the serials, the timestamps and the signature are the
 * evidence that matters, and losing all of it over one unreadable JPEG would be the
 * expensive failure.
 */
export async function renderDeliveryNote(
  meta: DeliveryNoteMeta,
  rows: DeliveryNoteRow[],
  signaturePng: Buffer,
  driverIdImage?: Buffer | null,
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
  line('Driver ID number', meta.driverIdNumber ?? 'Not recorded');
  line('Driver phone', meta.driverPhone ?? 'Not recorded');
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
  // Taller than it needs to be for the signature alone: the ID document sits beside
  // it, and an ID photographed in portrait is the deeper of the two.
  const SIGNATURE_BLOCK_H = 170;
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

  // The ID document, to the right of the signature. Together they are the claim the
  // note makes about identity: a drawn signature over a typed name, next to the
  // document that name came off.
  const idX = MARGIN + 300;
  doc.fontSize(9).fillColor('#555').text('ID DOCUMENT PRESENTED', idX, sigY);
  if (driverIdImage) {
    try {
      doc.image(driverIdImage, idX, sigY + 16, { fit: [200, 92] });
    } catch {
      doc
        .fontSize(9)
        .fillColor('#c0392b')
        .text('[ID image unavailable]', idX, sigY + 30);
    }
  } else {
    doc
      .fontSize(9)
      .fillColor(meta.driverIdOverridden ? '#b8860b' : '#777')
      .text(
        meta.driverIdOverridden
          ? 'Not photographed — admin override. The number above is the only ' +
              'identification on this return.'
          : 'No ID document on record for this return.',
        idX,
        sigY + 18,
        { width: 200 },
      );
  }

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
  // Under the name rather than beside it: the right half of this band now holds the
  // ID document, and the timestamp used to be printed straight over the bottom of it.
  doc
    .fontSize(9)
    .fillColor('#555')
    .text(fmt(meta.returnedAt), MARGIN, sigY + 124);

  doc.end();
  return done;
}
