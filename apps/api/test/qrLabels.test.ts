import { describe, it, expect } from 'vitest';
import { LABEL_SHEET, labelSlots, renderQrSheet } from '../src/services/pdf.js';
import { renderQrPng } from '../src/services/qr.js';

/**
 * The QR labels are printed onto 100 × 75 mm stickers, so their geometry is a
 * physical fit, not a style: a label a few millimetres too big runs off its sticker.
 */
const MM = 72 / 25.4;
const close = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe('QR label sheet', () => {
  it('is six 100 × 75 mm labels — two across, three down — that fit A4 without overlapping', () => {
    const slots = labelSlots();
    expect(slots).toHaveLength(6);
    for (const s of slots) {
      expect(close(s.width, 100 * MM)).toBe(true);
      expect(close(s.height, 75 * MM)).toBe(true);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.width).toBeLessThanOrEqual(LABEL_SHEET.page.width * MM + 0.01);
      expect(s.y + s.height).toBeLessThanOrEqual(LABEL_SHEET.page.height * MM + 0.01);
    }
    // Side by side and stacked, edge to edge — no two stickers share space.
    for (const [i, a] of slots.entries()) {
      for (const b of slots.slice(i + 1)) {
        const apart =
          a.x + a.width <= b.x + 0.01 ||
          b.x + b.width <= a.x + 0.01 ||
          a.y + a.height <= b.y + 0.01 ||
          b.y + b.height <= a.y + 0.01;
        expect(apart).toBe(true);
      }
    }
  });

  it('centres the grid on the page unless a sheet pins it', () => {
    const [first] = labelSlots();
    expect(close(first!.x, 5 * MM)).toBe(true); // (210 − 200) / 2
    expect(close(first!.y, 36 * MM)).toBe(true); // (297 − 225) / 2
    const [pinned] = labelSlots({ ...LABEL_SHEET, origin: { left: 4, top: 10 } });
    expect(close(pinned!.x, 4 * MM)).toBe(true);
    expect(close(pinned!.y, 10 * MM)).toBe(true);
  });

  it('renders one A4 page per six labels', async () => {
    const cells = await Promise.all(
      Array.from({ length: 7 }, async (_, i) => {
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
