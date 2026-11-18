import { z } from 'zod';

/** Roles — the source of truth. `apps/api/prisma/schema.prisma` mirrors this set by
 *  hand (shared cannot import the Prisma-generated enum); a test asserts parity. */
/**
 * PROJECT_MANAGER is the admin role. There is no separate ADMIN: the people who run
 * the console are the people the paperwork is addressed to, and every one of them has
 * a `ProjectManager` row as well as a login.
 */
export const roleSchema = z.enum([
  'TECHNICIAN',
  'SUBCONTRACTOR',
  'STORES_MANAGER',
  'PROJECT_MANAGER',
]);
export type Role = z.infer<typeof roleSchema>;

/**
 * The roles the People screen assigns. PROJECT_MANAGER is deliberately absent: making
 * someone a project manager also gives them a manager record that batches are
 * addressed to, so it happens on the Project managers screen and nowhere else.
 */
export const staffRoleSchema = z.enum(['TECHNICIAN', 'SUBCONTRACTOR', 'STORES_MANAGER']);
export type StaffRole = z.infer<typeof staffRoleSchema>;

/** Stable error envelope returned by every non-2xx API response. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
