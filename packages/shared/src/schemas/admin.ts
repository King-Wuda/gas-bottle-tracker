import { z } from 'zod';
import { roleSchema } from './common';
import { batchLineInputSchema } from './batch';

/**
 * The admin console's contract — who can use the system, who the paperwork is
 * addressed to, and correcting a batch that was booked in wrong.
 *
 * Two different populations live behind one screen, and the difference matters:
 *
 *  - **Users** (TECHNICIAN / STORES_MANAGER / ADMIN) log in. They appear in the audit
 *    trail as the person who scanned a cylinder.
 *  - **Project managers** never log in. They are the addressees of QR sheets and
 *    delivery notes, which is why a batch snapshots one rather than pointing at a
 *    login.
 *
 * Both carry `active`, because a user who booked in a batch last March is still the
 * answer to "who booked this in?" long after they have left, and a foreign key that
 * can vanish would take that answer with it. Deactivating is still the everyday move.
 *
 * Deleting is the other one, and it is genuinely destructive — see the reference-data
 * and client sections at the foot of this file. A deleted CLIENT takes its locations,
 * batches, cylinders, movement log, signatures and delivery notes with it. A deleted
 * USER does not: their account is destroyed, but the records they authored survive
 * under their name, because a technician's departure must not erase other clients'
 * deliveries as collateral.
 */

// ----------------------------- users -----------------------------

export const PASSWORD_MIN = 10;

/** Long rather than ornate: length is what actually resists guessing, and a rule the
 *  operator can satisfy is a rule they will not write on a sticky note. */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(200);

export const adminUserDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  active: z.boolean(),
  createdAt: z.string(),
  /** What deactivating them would leave behind — shown so the decision is informed. */
  batchesCreated: z.number().int().nonnegative(),
  movementsRecorded: z.number().int().nonnegative(),
});
export type AdminUserDto = z.infer<typeof adminUserDtoSchema>;

export const adminUsersResponseSchema = z.object({ users: z.array(adminUserDtoSchema) });
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;

export const createUserRequestSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200),
  role: roleSchema,
  password: passwordSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    role: roleSchema.optional(),
    active: z.boolean().optional(),
    /** Present only when the admin is resetting it. */
    password: passwordSchema.optional(),
  })
  .refine((u) => Object.keys(u).length > 0, { message: 'Nothing to update' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const adminUserResponseSchema = z.object({ user: adminUserDtoSchema });
export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;

// ----------------------------- project managers -----------------------------

export const adminProjectManagerDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  projectCount: z.number().int().nonnegative(),
  /** Batches still addressed to them. Deactivating does not orphan these — it means
   *  the next transfer of each one has to name a successor. */
  openBatchCount: z.number().int().nonnegative(),
});
export type AdminProjectManagerDto = z.infer<typeof adminProjectManagerDtoSchema>;

export const adminProjectManagersResponseSchema = z.object({
  projectManagers: z.array(adminProjectManagerDtoSchema),
});
export type AdminProjectManagersResponse = z.infer<typeof adminProjectManagersResponseSchema>;

export const createProjectManagerRequestSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
});
export type CreateProjectManagerRequest = z.infer<typeof createProjectManagerRequestSchema>;

export const updateProjectManagerRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().max(320).optional(),
    active: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });
export type UpdateProjectManagerRequest = z.infer<typeof updateProjectManagerRequestSchema>;

export const adminProjectManagerResponseSchema = z.object({
  projectManager: adminProjectManagerDtoSchema,
});
export type AdminProjectManagerResponse = z.infer<typeof adminProjectManagerResponseSchema>;

// ----------------------------- batch correction -----------------------------

/**
 * An admin's edit to one line of a batch.
 *
 * `id` names an existing line; omitting it adds a new one. Which fields may actually
 * change depends on what has already happened to that line's cylinders, and the
 * server — not this schema — is the judge of that:
 *
 *  - supplier and delivery point are paperwork, correctable at any time;
 *  - the **gas type** determines the serial prefix, so changing it re-issues every
 *    serial on the line and is refused once any of its cylinders has moved;
 *  - **quantity** up allocates more serials; quantity down deletes only cylinders
 *    that have never moved, and is refused if it would have to delete one that has.
 *
 * Anything already scanned onto a site is evidence, not a typo.
 */
export const batchLineEditSchema = batchLineInputSchema.partial().extend({
  id: z.string().min(1).optional(),
});
export type BatchLineEdit = z.infer<typeof batchLineEditSchema>;

export const updateBatchRequestSchema = z
  .object({
    projectManagerId: z.string().min(1).optional(),
    siteId: z.string().min(1).optional(),
    lines: z.array(batchLineEditSchema).max(25).optional(),
    /** Line ids to drop entirely. Same untouched-cylinder rule as shrinking one. */
    removeLineIds: z.array(z.string().min(1)).max(25).optional(),
    /** Free text for the amendment log — why the original entry was wrong. */
    reason: z.string().max(500).optional(),
  })
  .refine(
    (b) =>
      b.projectManagerId !== undefined ||
      b.siteId !== undefined ||
      (b.lines?.length ?? 0) > 0 ||
      (b.removeLineIds?.length ?? 0) > 0,
    { message: 'Nothing to update' },
  );
export type UpdateBatchRequest = z.infer<typeof updateBatchRequestSchema>;

/** One recorded correction. An admin rewriting a record without a trail would be a
 *  hole in exactly the accountability this system exists to provide. */
export const batchAmendmentDtoSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  userId: z.string(),
  userName: z.string(),
  /** Human-readable "field: was → now" lines, built server-side. */
  changes: z.array(z.string()),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type BatchAmendmentDto = z.infer<typeof batchAmendmentDtoSchema>;

export const batchAmendmentsResponseSchema = z.object({
  amendments: z.array(batchAmendmentDtoSchema),
});
export type BatchAmendmentsResponse = z.infer<typeof batchAmendmentsResponseSchema>;

// ------------------------- what a delete would destroy -------------------------

/**
 * The row counts a destructive delete would remove, shown in the confirmation.
 *
 * This exists so that "delete McCains" is never a leap in the dark. The screens render
 * these numbers before anything runs, and an empty impact is what makes a delete
 * legible as safe — a client with no batches yet is a very different decision from one
 * with four hundred, and the button should not look the same for both.
 */
export const deletionImpactSchema = z.object({
  sites: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  cylinders: z.number().int().nonnegative(),
  movementEvents: z.number().int().nonnegative(),
  transfers: z.number().int().nonnegative(),
  returns: z.number().int().nonnegative(),
  initializations: z.number().int().nonnegative(),
  photos: z.number().int().nonnegative(),
  amendments: z.number().int().nonnegative(),
  emails: z.number().int().nonnegative(),
  /** Signature PNGs, ID photographs, batch photos and delivery-note PDFs. */
  files: z.number().int().nonnegative(),
});
export type DeletionImpact = z.infer<typeof deletionImpactSchema>;

export const deletionImpactResponseSchema = z.object({ impact: deletionImpactSchema });
export type DeletionImpactResponse = z.infer<typeof deletionImpactResponseSchema>;

/** What a completed delete reports back: what it actually removed. */
export const deletionResponseSchema = z.object({
  deleted: z.literal(true),
  impact: deletionImpactSchema,
});
export type DeletionResponse = z.infer<typeof deletionResponseSchema>;

/** True when this delete would take evidence with it, not just a name off a list. */
export const impactIsDestructive = (i: DeletionImpact): boolean =>
  i.batches + i.cylinders + i.movementEvents + i.transfers + i.returns + i.photos > 0;

/**
 * "3 batches, 41 cylinders and 2 signed delivery notes" — the sentence under the
 * confirm button.
 *
 * Only non-zero counts appear, in the order an operator cares about, because a list
 * padded with "0 transfers, 0 photos" buries the number that should stop them. Returns
 * null when nothing but the record itself would go.
 */
export const describeImpact = (i: DeletionImpact): string | null => {
  const parts: string[] = [];
  const push = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  push(i.sites, 'location', 'locations');
  push(i.batches, 'batch', 'batches');
  push(i.cylinders, 'cylinder', 'cylinders');
  push(i.movementEvents, 'movement record', 'movement records');
  push(i.returns, 'signed delivery note', 'signed delivery notes');
  push(i.transfers, 'transfer', 'transfers');
  push(i.photos, 'photo', 'photos');
  push(i.files, 'stored file', 'stored files');
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
};

// ----------------------------- gases and suppliers -----------------------------

/**
 * A gas as the admin console sees it — with the suppliers paired to it, which is the
 * whole reason this screen is separate from the read-only `/gas-types` list the batch
 * form uses.
 */
export const adminGasTypeDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The serial prefix, e.g. "N" — immutable once cylinders carry it. */
  prefix: z.string(),
  active: z.boolean(),
  suppliers: z.array(z.object({ id: z.string(), name: z.string() })),
  /** How many batch lines have been booked against it; 0 means deleting is free. */
  usageCount: z.number().int().nonnegative(),
});
export type AdminGasTypeDto = z.infer<typeof adminGasTypeDtoSchema>;

export const adminGasTypesResponseSchema = z.object({
  gasTypes: z.array(adminGasTypeDtoSchema),
});
export type AdminGasTypesResponse = z.infer<typeof adminGasTypesResponseSchema>;

/**
 * The prefix is the first character of every serial the gas ever issues, so it is
 * constrained here rather than left to the operator's typing: 1-3 upper-case letters,
 * which keeps `N-25-001` readable on a label at arm's length.
 */
export const gasPrefixSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{1,3}$/, 'Prefix must be 1-3 capital letters, e.g. N or AR');

export const createGasTypeRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prefix: gasPrefixSchema,
});
export type CreateGasTypeRequest = z.infer<typeof createGasTypeRequestSchema>;

export const updateGasTypeRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateGasTypeRequest = z.infer<typeof updateGasTypeRequestSchema>;

export const adminGasTypeResponseSchema = z.object({ gasType: adminGasTypeDtoSchema });
export type AdminGasTypeResponse = z.infer<typeof adminGasTypeResponseSchema>;

export const adminSupplierDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  /** The gases this supplier is offered for. */
  gasTypes: z.array(z.object({ id: z.string(), name: z.string() })),
  usageCount: z.number().int().nonnegative(),
});
export type AdminSupplierDto = z.infer<typeof adminSupplierDtoSchema>;

export const adminSuppliersResponseSchema = z.object({
  suppliers: z.array(adminSupplierDtoSchema),
});
export type AdminSuppliersResponse = z.infer<typeof adminSuppliersResponseSchema>;

export const createSupplierRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Optional at creation: a supplier with no gases yet simply appears in no picker. */
  gasTypeIds: z.array(z.string().min(1)).optional(),
});
export type CreateSupplierRequest = z.infer<typeof createSupplierRequestSchema>;

export const updateSupplierRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateSupplierRequest = z.infer<typeof updateSupplierRequestSchema>;

export const adminSupplierResponseSchema = z.object({ supplier: adminSupplierDtoSchema });
export type AdminSupplierResponse = z.infer<typeof adminSupplierResponseSchema>;

/**
 * Pairing a supplier to a gas, and unpairing it.
 *
 * The only genuinely reversible delete in this file. `BatchLine` snapshots the
 * supplier NAME at intake, so unpairing changes what the batch form offers tomorrow
 * and nothing about what it recorded yesterday — no batch, no cylinder and no delivery
 * note is touched. That is why it needs no impact preview and no confirmation.
 */
export const gasSupplierPairingRequestSchema = z.object({ supplierId: z.string().min(1) });
export type GasSupplierPairingRequest = z.infer<typeof gasSupplierPairingRequestSchema>;

// --------------------------------- clients ---------------------------------

/**
 * A client and its locations — "McCains", with Delmas, Cape Town and Durban under it.
 *
 * This is the `Project` row and its `Site` rows, named the way the depot names them.
 * The app's own vocabulary grew from the paperwork (a project number identifies the
 * job), but nobody in the yard says "project 4521", they say "McCains".
 */
export const adminClientLocationDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string(),
  batchCount: z.number().int().nonnegative(),
});
export type AdminClientLocationDto = z.infer<typeof adminClientLocationDtoSchema>;

export const adminClientDtoSchema = z.object({
  id: z.string(),
  projectNumber: z.string(),
  projectManagerId: z.string(),
  projectManagerName: z.string(),
  status: z.enum(['ACTIVE', 'CLOSED']),
  createdAt: z.string(),
  locations: z.array(adminClientLocationDtoSchema),
  batchCount: z.number().int().nonnegative(),
});
export type AdminClientDto = z.infer<typeof adminClientDtoSchema>;

export const adminClientsResponseSchema = z.object({ clients: z.array(adminClientDtoSchema) });
export type AdminClientsResponse = z.infer<typeof adminClientsResponseSchema>;

export const adminClientResponseSchema = z.object({ client: adminClientDtoSchema });
export type AdminClientResponse = z.infer<typeof adminClientResponseSchema>;
