import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

/**
 * The `passwordHash` of a login that exists but has no password yet — a project manager
 * carried over by the migration that made managers into logins. It is not an argon2
 * string, so `verifyPassword` treats it as a non-match and nobody can sign in with it
 * until another project manager sets a real one.
 */
export const NO_PASSWORD = '!no-password';

export const hasUsablePassword = (hash: string): boolean => hash !== NO_PASSWORD;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * A real argon2id hash of a value nobody can supply, used to equalise the cost of a
 * login attempt against an unknown email. Without it, `user && verify(...)` short-
 * circuits and an unknown address answers ~60x faster than a wrong password — a
 * trivially measurable user-enumeration oracle.
 */
let dummyHashPromise: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHashPromise;
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // malformed hash, etc. — treat as a non-match rather than a 500
    return false;
  }
}
