import { describe, it, expect } from 'vitest';
import {
  createTransferRequestSchema,
  destinationTypeSchema,
  movementTypeSchema,
  scanInputSchema,
  transferDestinationSchema,
} from '../src/schemas/transfer';

const validScan = {
  serialCode: 'NIT26-001',
  qrPayload: `GCT2|NIT26-001|${'ab'.repeat(64)}`,
  scannedAt: '2026-08-28T07:00:00.000Z',
};

/** Every scan submission now carries the batch photo — see schemas/photo.ts. */
const validPhoto = {
  imageBase64: `data:image/jpeg;base64,${'A'.repeat(200)}`,
  capturedAt: '2026-08-28T07:00:00.000Z',
  latitude: -26.2041,
  longitude: 28.0473,
  accuracyM: 12,
  locationError: null,
};

describe('transfer schemas', () => {
  it('mirror the Prisma enum sets (parity guard)', () => {
    // Mirrors `enum DestinationType` / `enum MovementType` in schema.prisma.
    expect([...destinationTypeSchema.options].sort()).toEqual(['SITE', 'STORES']);
    expect([...movementTypeSchema.options].sort()).toEqual([
      'INITIALIZE',
      'INTAKE',
      'RETURN',
      'TRANSFER',
    ]);
  });

  it('rejects a serial that is not in [PREFIX][YY]-[SEQ] form', () => {
    expect(scanInputSchema.safeParse({ ...validScan, serialCode: '12345' }).success).toBe(false);
    expect(scanInputSchema.safeParse({ ...validScan, serialCode: 'NIT26-1000' }).success).toBe(
      true,
    );
  });

  it('requires a siteId for a SITE destination and forbids one for STORES', () => {
    expect(transferDestinationSchema.safeParse({ type: 'SITE', siteId: 'abc' }).success).toBe(true);
    expect(transferDestinationSchema.safeParse({ type: 'SITE' }).success).toBe(false);
    expect(transferDestinationSchema.safeParse({ type: 'STORES' }).success).toBe(true);

    // The union strips the stray key rather than routing it to the SITE branch, so a
    // STORES transfer can never smuggle in a destination site.
    const parsed = transferDestinationSchema.parse({ type: 'STORES', siteId: 'sneaky' });
    expect(parsed).not.toHaveProperty('siteId');
  });

  it('refuses a transfer with no scans — the spec’s mandatory-scan rule', () => {
    const base = {
      batchId: 'b1',
      clientRequestId: '11111111-2222-3333-4444-555555555555',
      destination: { type: 'STORES' as const },
      photo: validPhoto,
    };
    expect(createTransferRequestSchema.safeParse({ ...base, scans: [] }).success).toBe(false);
    expect(createTransferRequestSchema.safeParse({ ...base, scans: [validScan] }).success).toBe(
      true,
    );
  });

  it('refuses a transfer with neither a photo nor an admin override', () => {
    const base = {
      batchId: 'b1',
      clientRequestId: '11111111-2222-3333-4444-555555555555',
      destination: { type: 'STORES' as const },
      scans: [validScan],
    };
    expect(createTransferRequestSchema.safeParse({ ...base, photo: null }).success).toBe(false);
    expect(
      createTransferRequestSchema.safeParse({ ...base, photo: null, photoOverride: true }).success,
    ).toBe(true);
    // A position is optional; a REASON for not having one is how its absence is
    // recorded, so a fix that failed is still a valid submission.
    expect(
      createTransferRequestSchema.safeParse({
        ...base,
        photo: { ...validPhoto, latitude: null, longitude: null, accuracyM: null },
      }).success,
    ).toBe(true);
  });

  it('requires an idempotency key long enough to be a real UUID', () => {
    const base = { batchId: 'b1', destination: { type: 'STORES' as const }, scans: [validScan] };
    expect(createTransferRequestSchema.safeParse({ ...base, clientRequestId: 'x' }).success).toBe(
      false,
    );
  });
});
