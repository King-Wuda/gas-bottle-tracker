import { z } from 'zod';

/**
 * Who took the cylinders, and how that is proved.
 *
 * Shared by Workflow B (transfer) and Workflow C (return), because both hand physical
 * cylinders to a named person who is not the operator, and both need the same answer
 * to "who signed for these?" months later. It lives in its own module rather than in
 * either flow's file so neither owns it — a transfer importing its driver rules from
 * `return.ts` would read as an accident, and would become one the first time the two
 * needed to differ.
 */

/** ~2 MB of base64 ≈ a 1.5 MB PNG — far above any signature canvas, but bounded so a
 *  malformed client cannot post an unbounded body. Accepts a bare base64 string or a
 *  `data:image/png;base64,…` URL, which is what a signature canvas hands back. */
export const signaturePngSchema = z
  .string()
  .min(64, 'Signature is empty')
  .max(2_800_000, 'Signature image is too large');

/**
 * The driver's phone number — so the project manager can call whoever has the
 * cylinders. Loose on format: a foreign number or one written with spaces must still be
 * recordable. It needs at least seven digits.
 */
export const driverPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9(][0-9 ()-]{5,24}$/, 'Enter the driver’s phone number')
  .refine((v) => v.replace(/\D/g, '').length >= 7, 'Enter the driver’s phone number');

/** Stored lowercased, like every other address in the system. */
export const driverEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter the driver’s email address')
  .max(200);

const personNameSchema = (what: string) =>
  z.string().trim().min(1, `Enter the driver’s ${what}`).max(100);

/**
 * Who took the cylinders, as a transfer or a return records it.
 *
 * Either a registered driver — `driverId` names their profile, and the server copies
 * the profile's name, email and phone onto the record — or an unregistered one, typed
 * in on the spot (`driverId` null). The name, email and phone travel either way: they
 * are what the record keeps, so a profile edited or deleted later never rewrites who
 * signed for a delivery months ago, and an offline submission queued against a profile
 * that has since gone still says who it was.
 *
 * The ID number and photo of the driver's ID are no longer asked for. Records made
 * while they were still carry them, and the DTO still exposes them for those.
 */
export const driverSignOffFields = {
  driverId: z.string().min(1).nullable().default(null),
  driverName: z.string().trim().min(1, 'Enter the driver’s name').max(200),
  driverEmail: driverEmailSchema,
  driverPhone: driverPhoneSchema,
} as const;

// ----------------------------------------------------------------- driver profiles

/** A regular driver, kept so their details need not be typed on every collection. */
export const driverProfileDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  surname: z.string(),
  /** "Name Surname" — what a record copies as `driverName`. */
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  active: z.boolean(),
  /** How many transfers and returns name this driver. Deleting the profile keeps them,
   *  with the name, email and phone they were signed for under. */
  transfers: z.number().int().nonnegative(),
  returns: z.number().int().nonnegative(),
});
export type DriverProfileDto = z.infer<typeof driverProfileDtoSchema>;

export const driverFullName = (d: { name: string; surname: string }): string =>
  `${d.name.trim()} ${d.surname.trim()}`.trim();

export const createDriverRequestSchema = z.object({
  name: personNameSchema('name'),
  surname: personNameSchema('surname'),
  email: driverEmailSchema,
  phone: driverPhoneSchema,
});
export type CreateDriverRequest = z.infer<typeof createDriverRequestSchema>;

export const updateDriverRequestSchema = createDriverRequestSchema
  .partial()
  .extend({ active: z.boolean().optional() });
export type UpdateDriverRequest = z.infer<typeof updateDriverRequestSchema>;

export const driversResponseSchema = z.object({ drivers: z.array(driverProfileDtoSchema) });
export type DriversResponse = z.infer<typeof driversResponseSchema>;

export const driverResponseSchema = z.object({ driver: driverProfileDtoSchema });
export type DriverResponse = z.infer<typeof driverResponseSchema>;

/** The DTO fields both a transfer and a return expose about the driver. Every one is
 *  nullable or false for records made before sign-off was collected on that flow. */
export const driverSignOffDtoFields = {
  /** Null on records that predate driver sign-off on this flow. */
  driverName: z.string().nullable(),
  /** The registered driver's profile; null for an unregistered driver, for older
   *  records, and once the profile has been deleted (the details above stay). */
  driverId: z.string().nullable(),
  /** Null on records made before the email address was asked for. */
  driverEmail: z.string().nullable(),
  /** Only on records made while the ID number was still asked for. */
  driverIdNumber: z.string().nullable(),
  /** Null on records made before the phone number was asked for. */
  driverPhone: z.string().nullable(),
  /** True when an admin waived the ID photo. `driverIdCaptured` is then false. */
  driverIdOverridden: z.boolean(),
  /** Whether an ID document image is actually on file. */
  driverIdCaptured: z.boolean(),
} as const;

/**
 * What deleting a driver profile touches: the transfers and returns that name them.
 * Nothing is destroyed — each keeps the name, email and phone it was signed under, and
 * only loses the link back to the profile. The screen says so before the delete.
 */
export const driverImpactResponseSchema = z.object({
  transfers: z.number().int().nonnegative(),
  returns: z.number().int().nonnegative(),
});
export type DriverImpactResponse = z.infer<typeof driverImpactResponseSchema>;
