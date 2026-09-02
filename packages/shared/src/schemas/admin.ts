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
 * Neither is ever deleted. Both carry `active`, because a user who booked in a batch
 * last March is still the answer to "who booked this in?" long after they have left,
 * and a foreign key that can vanish would take that answer with it.
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
