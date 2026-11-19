import { z } from 'zod';

/**
 * The stores side of a cylinder's life: which cage it sits in, and whether it is full.
 *
 * Cylinders move between stores and site indefinitely (transfers), and leave the
 * system only when returned to the supplier (returns). While they are in stores they
 * sit in one of three cages, and the stores manager needs to see, per gas, how many
 * are full and how many came back empty.
 */

/** The cages in the stores yard. A number rather than an enum on the server so a
 *  fourth cage is a constant change, but bounded by a CHECK in the database. */
export const CAGES = [1, 2, 3] as const;
export const cageSchema = z.number().int().min(1).max(3);
export type Cage = z.infer<typeof cageSchema>;

export const cylinderContentsSchema = z.enum(['FULL', 'EMPTY']);
export type CylinderContents = z.infer<typeof cylinderContentsSchema>;

/**
 * Which cage each gas goes into on this drop-off — "argon into cage 1, nitrogen into
 * cage 3". One cage per gas, not per cylinder: every cylinder of that gas in the
 * drop-off goes into the same cage. Required for every gas being put into stores.
 */
export const gasCagesSchema = z
  .array(z.object({ gasTypeId: z.string().min(1), cage: cageSchema }))
  .max(25)
  .refine((rows) => new Set(rows.map((r) => r.gasTypeId)).size === rows.length, {
    message: 'Each gas can only go into one cage.',
  });
export type GasCages = z.infer<typeof gasCagesSchema>;

/** What a drop-off put where — echoed on the result screen and in the email. */
export const cageAssignmentDtoSchema = z.object({
  gasTypeId: z.string(),
  gasTypeName: z.string(),
  cage: cageSchema,
});
export type CageAssignmentDto = z.infer<typeof cageAssignmentDtoSchema>;

// ------------------------------- the stores console -------------------------------

const fullEmptySchema = z.object({
  full: z.number().int().nonnegative(),
  empty: z.number().int().nonnegative(),
});

/**
 * One gas, as the stores console shows it.
 *
 * `total` is every cylinder still in rotation — in stores, on site or in transit —
 * because "how many argon bottles do we have?" includes the ones out on a job.
 * Returned cylinders are gone to the supplier and are not counted at all.
 *
 * Full and empty are only split out for cylinders IN STORES. A cylinder on site was
 * full when it left and nobody has looked since, so the console does not claim to know.
 */
export const storesGasSummarySchema = z.object({
  gasTypeId: z.string(),
  gasTypeName: z.string(),
  total: z.number().int().nonnegative(),
  inStores: fullEmptySchema,
  onSite: z.number().int().nonnegative(),
  inTransit: z.number().int().nonnegative(),
  /** One row per cage 1-3, always present (zeros included) so the grid never jumps. */
  cages: z.array(fullEmptySchema.extend({ cage: cageSchema })),
  /** In stores but arrived before cages were recorded. */
  noCage: fullEmptySchema,
});
export type StoresGasSummary = z.infer<typeof storesGasSummarySchema>;

export const storesSummaryResponseSchema = z.object({
  gases: z.array(storesGasSummarySchema),
  totals: z.object({
    total: z.number().int().nonnegative(),
    inStores: fullEmptySchema,
    onSite: z.number().int().nonnegative(),
    inTransit: z.number().int().nonnegative(),
  }),
});
export type StoresSummaryResponse = z.infer<typeof storesSummaryResponseSchema>;

// ------------------------------- moving a gas between cages -------------------------------

/**
 * A stores manager's one edit to a batch: which cage each gas is in.
 *
 * Choosing a cage is optional when cylinders come into stores, so this is where one is
 * set later, or changed when a gas is moved to another cage. `cage: null` takes the gas
 * out of any cage. It touches only the batch's cylinders that are physically in stores,
 * and is recorded on the batch's correction trail like any other change.
 */
export const setBatchCagesRequestSchema = z.object({
  cages: z
    .array(z.object({ gasTypeId: z.string().min(1), cage: cageSchema.nullable() }))
    .min(1, 'Choose a cage for at least one gas')
    .max(20)
    .refine(
      (cs) => new Set(cs.map((c) => c.gasTypeId)).size === cs.length,
      'Each gas can only be in one cage',
    ),
  reason: z.string().max(500).optional(),
});
export type SetBatchCagesRequest = z.infer<typeof setBatchCagesRequestSchema>;

/** One gas of a batch as the cage screen shows it: how many are in stores, and where. */
export const batchGasCagesDtoSchema = z.object({
  gasTypeId: z.string(),
  gasTypeName: z.string(),
  inStores: z.number().int().nonnegative(),
  /** How many of them are in each cage; `cage: null` = in no cage. */
  byCage: z.array(z.object({ cage: cageSchema.nullable(), count: z.number().int().positive() })),
});
export type BatchGasCagesDto = z.infer<typeof batchGasCagesDtoSchema>;

export const batchCagesResponseSchema = z.object({
  batchId: z.string(),
  projectNumber: z.string(),
  gases: z.array(batchGasCagesDtoSchema),
});
export type BatchCagesResponse = z.infer<typeof batchCagesResponseSchema>;
