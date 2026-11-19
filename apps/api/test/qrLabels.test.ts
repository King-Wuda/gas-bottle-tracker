import { describe, it, expect } from 'vitest';
import { LABEL_SHEET, labelSize, labelSlots, renderQrSheet } from '../src/services/pdf.js';
import { renderQrPng } from '../src/services/qr.js';

/**
 * The QR labels are cut out and stuck on cylinders, eight to an A4 sheet with 5 mm
 * between every label and the paper's edges, so their geometry is a physical fit, not
 * a style.
 */
const MM = 72 / 25.4;
const close = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe('QR label sheet', () => {
  it('is eight 97.5 × 68 mm labels — two across, four down — on A4', () => {
    expect(labelSize()).toEqual({ width: 97.5, height: 68 });
    const slots = labelSlots();
    expect(slots).toHaveLength(8);
    for (const s of slots) {
      expect(close(s.width, 97.5 * MM)).toBe(true);
      expect(close(s.height, 68 * MM)).toBe(true);
    }
  });

  it('keeps exactly 5 mm to every edge of the paper and between neighbours', () => {
    const slots = labelSlots();
    const xs = [...new Set(slots.map((s) => Math.round(s.x * 100)))].map((v) => v / 100);
    const ys = [...new Set(slots.map((s) => Math.round(s.y * 100)))].map((v) => v / 100);
    const w = 97.5 * MM;
    const h = 68 * MM;
    // Edges: left/top at 5 mm, right/bottom 5 mm short of the page.
    expect(close(xs[0]!, 5 * MM)).toBe(true);
    expect(close(ys[0]!, 5 * MM)).toBe(true);
    expect(close(LABEL_SHEET.page.width * MM - (xs.at(-1)! + w), 5 * MM)).toBe(true);
    expect(close(LABEL_SHEET.page.height * MM - (ys.at(-1)! + h), 5 * MM)).toBe(true);
    // Between neighbours: 5 mm across and 5 mm down.
    expect(close(xs[1]! - (xs[0]! + w), 5 * MM)).toBe(true);
    for (let r = 1; r < ys.length; r++) expect(close(ys[r]! - (ys[r - 1]! + h), 5 * MM)).toBe(true);
  });

  it('resizes the labels when the sheet changes, keeping the spacing', () => {
    expect(labelSize({ ...LABEL_SHEET, rows: 3 })).toEqual({
      width: 97.5,
      height: (297 - 10 - 10) / 3,
    });
  });

  it('renders one A4 page per eight labels', async () => {
    const cells = await Promise.all(
      Array.from({ length: 9 }, async (_, i) => {
        const serialCode = `ARG26-${String(i + 1).padStart(3, '0')}`;
        return {
          serialCode,
          qrPng: await renderQrPng(serialCode),
          gasTypeName: 'Argon',
          supplierName: 'Supplier 1',
        };
      }),
    );
    const pdf = await renderQrSheet(
      {
        projectNumber: '525080-008-1-01',
        projectManagerName: 'Lambertus Philip',
        siteName: 'I&J',
        siteLocation: 'Boronia',
        createdAt: new Date('2026-11-18T10:00:00Z'),
      },
      cells,
    );
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? [];
    expect(pages).toHaveLength(2);
  });
});
