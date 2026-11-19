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

const base = {
  batchId: 'b1',
  clientRequestId: '11111111-2222-3333-4444-555555555555',
  scans: [scan],
  driverName: 'Sipho Ndlovu',
  driverPhone: '082 555 0199',
  driverEmail: 'sipho@example.com',
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

  it('no longer asks for the driver’s ID number or a photo of their ID', () => {
    const parsed = createReturnRequestSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('driverIdNumber');
      expect(parsed.data).not.toHaveProperty('driverIdPhoto');
    }
  });

  it('takes either a registered driver or an unregistered one, with email and phone', () => {
    expect(createReturnRequestSchema.safeParse({ ...base, driverId: 'drv1' }).success).toBe(true);
    const parsed = createReturnRequestSchema.safeParse(base);
    if (parsed.success) expect(parsed.data.driverId).toBeNull();
    expect(createReturnRequestSchema.safeParse({ ...base, driverEmail: '' }).success).toBe(false);
    expect(createReturnRequestSchema.safeParse({ ...base, driverEmail: 'nope' }).success).toBe(
      false,
    );
  });

  it('lowercases the driver’s email address', () => {
    const parsed = createReturnRequestSchema.safeParse({
      ...base,
      driverEmail: ' Sipho@Example.COM ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.driverEmail).toBe('sipho@example.com');
  });
});
