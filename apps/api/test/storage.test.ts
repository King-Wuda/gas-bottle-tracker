import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/db.js';
import { resetEnvCache } from '../src/env.js';
import { absolutePath, readFileAt, saveFile } from '../src/services/storage.js';

/**
 * The two storage drivers have to be interchangeable, because the difference between
 * them is a deployment decision made long after this code was written — and the thing
 * they hold is the photographs and signatures the whole system exists to produce.
 *
 * So the same assertions run against both, from one table of cases. A driver that
 * quietly differed here would show up as evidence that cannot be opened, months later,
 * on whichever host happened to pick the other one.
 */
const DIRS: string[] = [];

async function withDriver<T>(driver: 'fs' | 'db', fn: () => Promise<T>): Promise<T> {
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousDir = process.env.STORAGE_DIR;
  process.env.STORAGE_DRIVER = driver;
  // `env()` caches after the first read, on purpose — see resetEnvCache().
  resetEnvCache();
  if (driver === 'fs') {
    const dir = await mkdtemp(path.join(tmpdir(), 'gct-storage-'));
    DIRS.push(dir);
    process.env.STORAGE_DIR = dir;
    resetEnvCache();
  }
  try {
    return await fn();
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousDir;
    resetEnvCache();
  }
}

beforeEach(async () => {
  await prisma.storedFile.deleteMany();
});

afterAll(async () => {
  await Promise.all(DIRS.map((d) => rm(d, { recursive: true, force: true })));
  await prisma.storedFile.deleteMany();
});

for (const driver of ['fs', 'db'] as const) {
  describe(`storage driver: ${driver}`, () => {
    it('round-trips bytes exactly', async () => {
      await withDriver(driver, async () => {
        // Every byte value, so nothing here is doing a lossy string conversion on the
        // way through — these blobs are JPEGs and PNGs, not text.
        const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const rel = await saveFile('photos', 'round-trip.bin', data);
        expect(await readFileAt(rel)).toEqual(data);
      });
    });

    it('returns a relative, kind-prefixed path', async () => {
      await withDriver(driver, async () => {
        const rel = await saveFile('signatures', 'signature-abc.png', Buffer.from('x'));
        expect(rel).toBe('signatures/signature-abc.png');
        expect(path.isAbsolute(rel)).toBe(false);
      });
    });

    it('overwrites its own file on a retry rather than colliding', async () => {
      // Filenames are derived from the idempotency key, so the second write of the
      // same submission must replace the first.
      await withDriver(driver, async () => {
        await saveFile('notes', 'delivery-note-1.pdf', Buffer.from('first'));
        const rel = await saveFile('notes', 'delivery-note-1.pdf', Buffer.from('second'));
        expect((await readFileAt(rel)).toString()).toBe('second');
      });
    });

    it('keeps different kinds apart', async () => {
      await withDriver(driver, async () => {
        const a = await saveFile('photos', 'same-name.bin', Buffer.from('photo'));
        const b = await saveFile('qr', 'same-name.bin', Buffer.from('qr sheet'));
        expect(a).not.toBe(b);
        expect((await readFileAt(a)).toString()).toBe('photo');
        expect((await readFileAt(b)).toString()).toBe('qr sheet');
      });
    });

    it('fails with ENOENT for something that was never stored', async () => {
      await withDriver(driver, async () => {
        await expect(readFileAt('photos/never-written.jpg')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    });
  });
}

describe('storage driver: db specifics', () => {
  it('refuses to invent a filesystem path it does not have', async () => {
    await withDriver('db', async () => {
      expect(() => absolutePath('photos/x.jpg')).toThrow(/STORAGE_DRIVER=db/);
    });
  });

  it('really does put the bytes in the database', async () => {
    await withDriver('db', async () => {
      await saveFile('photos', 'in-the-database.jpg', Buffer.from('evidence'));
      const row = await prisma.storedFile.findUniqueOrThrow({
        where: { path: 'photos/in-the-database.jpg' },
      });
      expect(Buffer.from(row.bytes).toString()).toBe('evidence');
    });
  });

  it('writes nothing to the database under the fs driver', async () => {
    await withDriver('fs', async () => {
      await saveFile('photos', 'on-disk.jpg', Buffer.from('evidence'));
      expect(await prisma.storedFile.count()).toBe(0);
    });
  });
});
