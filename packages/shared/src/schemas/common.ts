import { z } from 'zod';

/** Roles — the source of truth. `apps/api/prisma/schema.prisma` mirrors this set by
 *  hand (shared cannot import the Prisma-generated enum); a test asserts parity. */
export const roleSchema = z.enum(['TECHNICIAN', 'STORES_MANAGER', 'ADMIN']);
export type Role = z.infer<typeof roleSchema>;

/** Stable error envelope returned by every non-2xx API response. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
