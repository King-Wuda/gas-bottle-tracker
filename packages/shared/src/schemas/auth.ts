import { z } from 'zod';
import { roleSchema } from './common';

/**
 * What every profile starts with: the seed, the console's add forms, and the migration
 * that reset every existing account to it. Each person then changes their own from the
 * dashboard (`POST /me/password`).
 */
export const DEFAULT_PASSWORD = 'gea';

export const PASSWORD_MIN = 3;

/** Long rather than ornate: length is what actually resists guessing, and a rule the
 *  operator can satisfy is a rule they will not write on a sticky note. */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(200);

/**
 * Email addresses are compared without regard to case or surrounding spaces: phones
 * capitalise the first letter of a field, and "Sipho@Example.com" is the same mailbox
 * as "sipho@example.com". Every address is stored lowercased (the console lowercases on
 * the way in; migration 20261119150000 lowercased the ones already there), so the login
 * normalises what was typed the same way before looking it up.
 */
export const loginEmailSchema = z.string().trim().toLowerCase().email();

export const loginRequestSchema = z.object({
  email: loginEmailSchema,
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Safe user projection — never carries passwordHash. */
export const userDtoSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: roleSchema,
  /** The subcontractor's employer; null for everyone else. */
  company: z.string().nullable(),
  active: z.boolean(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  /** Opaque; rotated on every use. */
  refreshToken: z.string(),
  /** Access-token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export const loginResponseSchema = authTokensSchema.extend({ user: userDtoSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const refreshResponseSchema = authTokensSchema;
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const logoutRequestSchema = z.object({ refreshToken: z.string().min(1) });
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const meResponseSchema = z.object({ user: userDtoSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * Changing your own password. The current one is required even though the caller is
 * already signed in: a phone left unlocked on a site office desk must not be enough to
 * take over the account for good.
 */
export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/**
 * A fresh session. Changing a password ends every session the account holds — that is
 * the point of changing it on a phone you suspect was lost — so the device that made the
 * change is handed a new pair rather than being signed out with the rest.
 */
export const changePasswordResponseSchema = authTokensSchema;
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;
