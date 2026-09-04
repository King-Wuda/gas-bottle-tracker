import { describe, it, expect } from 'vitest';
import { createReturnRequestSchema } from '../src/schemas/return';

const scan = {
  serialCode: 'NIT26-001',
  qrPayload: `GCT2|NIT26-001|${'ab'.repeat(64)}`,
  scannedAt: '2026-08-28T07:00:00.000Z',
};
const signaturePng = `data:image/png;base64,${'A'.repeat(200)}`;
/** Every scan submission now carries the batch photo — see schemas/photo.ts. */
const photo = {
  imageBase64: `data:image/jpeg;base64,${'A'.repeat(200)}`,
  capturedAt: '2026-08-28T07:00:00.000Z',
  latitude: -26.2041,
  longitude: 28.0473,
  accuracyM: 12,
  locationError: null,
};

/** The driver's ID document, captured the same way the batch photo is. */
const driverIdPhoto = { ...photo, capturedAt: '2026-08-28T07:01:00.000Z' };

const base = {
  batchId: 'b1',
  clientRequestId: '11111111-2222-3333-4444-555555555555',
  scans: [scan],
  driverName: 'Sipho Ndlovu',
  driverIdNumber: '8801015009087',
  driverIdPhoto,
  signaturePng,
  photo,
};

describe('return schemas', () => {
  it('accepts a well-formed return', () => {
    expect(createReturnRequestSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a return with no scans — nothing comes back unscanned', () => {
    expect(createReturnRequestSchema.safeParse({ ...base, scans: [] }).success).toBe(false);
  });

  it('refuses a return with neither a photo nor an admin override', () => {
    // Mandatory for everyone; the override is checked server-side against the role,
    // because a schema cannot know who is asking.
    expect(createReturnRequestSchema.safeParse({ ...base, photo: null }).success).toBe(false);
    expect(
      createReturnRequestSchema.safeParse({ ...base, photo: null, photoOverride: true }).success,
    ).toBe(true);
  });

  it('refuses an unsigned or unnamed collection', () => {
    // The note has to say who took the cylinders; both halves are required.
    expect(createReturnRequestSchema.safeParse({ ...base, driverName: '' }).success).toBe(false);
    expect(createReturnRequestSchema.safeParse({ ...base, signaturePng: '' }).success).toBe(false);
    expect(createReturnRequestSchema.safeParse({ ...base, signaturePng: 'x' }).success).toBe(false);
  });

  it('bounds the signature so a malformed client cannot post an unbounded body', () => {
    expect(
      createReturnRequestSchema.safeParse({ ...base, signaturePng: 'A'.repeat(3_000_000) }).success,
    ).toBe(false);
  });

  it('requires the driver ID number', () => {
    expect(createReturnRequestSchema.safeParse({ ...base, driverIdNumber: '' }).success).toBe(
      false,
    );
    expect(createReturnRequestSchema.safeParse({ ...base, driverIdNumber: '123' }).success).toBe(
      false,
    );
    expect(
      createReturnRequestSchema.safeParse({ ...base, driverIdNumber: 'x'.repeat(41) }).success,
    ).toBe(false);
  });

  it('accepts any document number, not only a South African ID', () => {
    // A passport or a foreign licence has to be recordable: a driver who cannot be
    // recorded is a driver who leaves with the cylinders and no name against them.
    for (const number of ['8801015009087', 'A04512399', 'ZW-DL-88231/04', 'M 123 456 78']) {
      const parsed = createReturnRequestSchema.safeParse({ ...base, driverIdNumber: number });
      expect(parsed.success, number).toBe(true);
      if (parsed.success) expect(parsed.data.driverIdNumber).toBe(number.trim());
    }
  });

  it('trims the driver ID number rather than storing the spaces around it', () => {
    const parsed = createReturnRequestSchema.safeParse({
      ...base,
      driverIdNumber: '  8801015009087  ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.driverIdNumber).toBe('8801015009087');
  });

  it('refuses a return with neither an ID photo nor an admin override', () => {
    // Same rule as the batch photo, for the same reason: the role is checked
    // server-side, because a schema cannot know who is asking.
    expect(createReturnRequestSchema.safeParse({ ...base, driverIdPhoto: null }).success).toBe(
      false,
    );
    expect(
      createReturnRequestSchema.safeParse({ ...base, driverIdPhoto: null, driverIdOverride: true })
        .success,
    ).toBe(true);
  });

  it('defaults the ID override to false when the client omits it', () => {
    const parsed = createReturnRequestSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.driverIdOverride).toBe(false);
  });
});
