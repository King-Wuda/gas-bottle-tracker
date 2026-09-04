import { describe, it, expect } from 'vitest';
import { createReturnRequestSchema } from '../src/schemas/return';
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

/** Every scan submission carries the batch photo — see schemas/photo.ts. */
const validPhoto = {
  imageBase64: `data:image/jpeg;base64,${'A'.repeat(200)}`,
  capturedAt: '2026-08-28T07:00:00.000Z',
  latitude: -26.2041,
  longitude: 28.0473,
  accuracyM: 12,
  locationError: null,
};

/**
 * A transfer also carries the driver sign-off now — the same four things a return
 * asks for, because both hand cylinders to a named person who drives away with them.
 * See schemas/driver.ts. Spread into every fixture so a test about scans or photos
 * fails for the reason it is named after.
 */
const validSignOff = {
  driverName: 'Sipho Ndlovu',
  driverIdNumber: '8801015009087',
  driverIdPhoto: { ...validPhoto, capturedAt: '2026-08-28T07:01:00.000Z' },
  signaturePng: `data:image/png;base64,${'A'.repeat(200)}`,
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
      ...validSignOff,
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
      ...validSignOff,
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
    const base = {
      batchId: 'b1',
      destination: { type: 'STORES' as const },
      scans: [validScan],
      photo: validPhoto,
      ...validSignOff,
    };
    expect(createTransferRequestSchema.safeParse({ ...base, clientRequestId: 'x' }).success).toBe(
      false,
    );
  });
});

describe('transfer driver sign-off', () => {
  const base = {
    batchId: 'b1',
    clientRequestId: '11111111-2222-3333-4444-555555555555',
    destination: { type: 'STORES' as const },
    scans: [validScan],
    photo: validPhoto,
    ...validSignOff,
  };

  it('accepts a fully signed transfer', () => {
    expect(createTransferRequestSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a transfer with nobody named against it', () => {
    // The whole point of adding this to transfers: a batch could previously cross the
    // country with no record of who took it.
    expect(createTransferRequestSchema.safeParse({ ...base, driverName: '' }).success).toBe(false);
    expect(createTransferRequestSchema.safeParse({ ...base, driverIdNumber: '' }).success).toBe(
      false,
    );
    expect(createTransferRequestSchema.safeParse({ ...base, signaturePng: '' }).success).toBe(
      false,
    );
  });

  it('refuses a transfer with neither an ID photo nor an admin override', () => {
    expect(createTransferRequestSchema.safeParse({ ...base, driverIdPhoto: null }).success).toBe(
      false,
    );
    expect(
      createTransferRequestSchema.safeParse({
        ...base,
        driverIdPhoto: null,
        driverIdOverride: true,
      }).success,
    ).toBe(true);
  });

  it('demands the same driver evidence a return does', () => {
    // Behavioural parity, not a shape comparison: drop each field in turn from BOTH
    // schemas and require that both reject it. If a future change relaxes one flow
    // and not the other, this fails — which is the whole reason the rules live in
    // schemas/driver.ts rather than being written out twice.
    const returnBase = {
      batchId: 'b1',
      clientRequestId: base.clientRequestId,
      scans: [validScan],
      photo: validPhoto,
      ...validSignOff,
    };

    for (const field of ['driverName', 'driverIdNumber', 'signaturePng'] as const) {
      const transfer = { ...base, [field]: '' };
      const ret = { ...returnBase, [field]: '' };
      expect(createTransferRequestSchema.safeParse(transfer).success, `transfer.${field}`).toBe(
        false,
      );
      expect(createReturnRequestSchema.safeParse(ret).success, `return.${field}`).toBe(false);
    }

    // And the ID photo, whose absence is only allowed alongside an override.
    expect(createTransferRequestSchema.safeParse({ ...base, driverIdPhoto: null }).success).toBe(
      false,
    );
    expect(
      createReturnRequestSchema.safeParse({ ...returnBase, driverIdPhoto: null }).success,
    ).toBe(false);
  });
});
