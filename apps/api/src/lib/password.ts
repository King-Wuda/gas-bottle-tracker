import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

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
