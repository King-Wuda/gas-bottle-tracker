import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { prisma } from '../db.js';

/**
 * Blob store for generated PDFs, signature PNGs, batch photos and driver ID
 * documents. Callers only ever hold the relative path this returns, which is what
 * lets the backing store change without anything above knowing.
 *
 * ## Two drivers, and why
 *
 * `STORAGE_DRIVER=fs` (the default) writes under `STORAGE_DIR`. That is the right
 * thing on a real server and on a laptop: files are cheap, inspectable, and out of
 * the database.
 *
 * `STORAGE_DRIVER=db` writes the bytes into Postgres instead. It exists for hosts
 * with no durable filesystem - a free Render web service has an EPHEMERAL disk that
 * is wiped whenever the instance spins down, which it does after fifteen idle
 * minutes. On such a host the filesystem driver leaves the database referencing
 * photographs and signatures that no longer exist: every batch still lists its
 * evidence, and every attempt to open it fails. Since the evidence is the entire
 * point of this system, silently losing it is the one outcome worth spending a
 * database column to avoid.
 *
 * Neither driver is "the real one". The path format is identical, so a deployment can
 * move between them, and an S3 driver can still drop in later exactly as intended.
 */
export type StorageKind = 'qr' | 'notes' | 'signatures' | 'photos';

const root = (): string => path.resolve(env().STORAGE_DIR);

const usingDatabase = (): boolean => env().STORAGE_DRIVER === 'db';

/**
 * Always POSIX-style, and always relative.
 *
 * The path is a database key under the `db` driver, so it must not pick up a
 * separator from a host that joins paths differently and stop matching what was
 * written elsewhere.
 */
const keyFor = (kind: StorageKind, filename: string): string => `${kind}/${filename}`;

export async function saveFile(kind: StorageKind, filename: string, data: Buffer): Promise<string> {
  const rel = keyFor(kind, filename);

  if (usingDatabase()) {
    // Upsert, not create: every filename here is derived from an idempotency key, so
    // a retry is meant to overwrite its own row rather than collide with it.
    // Prisma types a Bytes column as `Uint8Array<ArrayBuffer>`; a Node `Buffer` is
    // typed over `ArrayBufferLike`, which could in principle be a SharedArrayBuffer
    // and so is not assignable. Copying into a fresh array is the only form that
    // satisfies the type without a cast, and at these sizes the copy is free.
    const bytes = Uint8Array.from(data);
    await prisma.storedFile.upsert({
      where: { path: rel },
      create: { path: rel, bytes },
      update: { bytes },
    });
    return rel;
  }

  await mkdir(path.join(root(), kind), { recursive: true });
  await writeFile(path.join(root(), rel), data);
  return rel;
}

/**
 * The absolute path of a stored file.
 *
 * Only meaningful under the `fs` driver - there is no path to give for a row in a
 * table - so it throws rather than returning something plausible that would then be
 * read as an empty file.
 */
export function absolutePath(relPath: string): string {
  if (usingDatabase()) {
    throw new Error(
      'absolutePath() is meaningless under STORAGE_DRIVER=db - read the file with readFileAt()',
    );
  }
  return path.join(root(), relPath);
}

export async function readFileAt(relPath: string): Promise<Buffer> {
  if (usingDatabase()) {
    const row = await prisma.storedFile.findUnique({ where: { path: relPath } });
    // Same shape of failure as a missing file, so callers that already handle a
    // vanished attachment keep working unchanged.
    if (!row) {
      const err = new Error(`stored file not found: ${relPath}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return Buffer.from(row.bytes);
  }
  return readFile(absolutePath(relPath));
}
