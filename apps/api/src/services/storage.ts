import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';

/**
 * Local-filesystem blob store for generated PDFs and signature PNGs. Shaped so an
 * S3 adapter can drop in later: callers only ever hold the returned relative path.
 */
export type StorageKind = 'qr' | 'notes' | 'signatures' | 'photos';

const root = (): string => path.resolve(env().STORAGE_DIR);

export async function saveFile(kind: StorageKind, filename: string, data: Buffer): Promise<string> {
  const dir = path.join(root(), kind);
  await mkdir(dir, { recursive: true });
  const rel = path.join(kind, filename);
  await writeFile(path.join(root(), rel), data);
  return rel;
}

export function absolutePath(relPath: string): string {
  return path.join(root(), relPath);
}

export function readFileAt(relPath: string): Promise<Buffer> {
  return readFile(absolutePath(relPath));
}
