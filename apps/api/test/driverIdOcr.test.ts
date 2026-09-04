import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { stopIdOcr } from '../src/services/idOcr.js';
import { loginAs, bearer, DEMO, resetDb } from './helpers.js';

/**
 * Reading the driver's ID number off a photograph (Workflow C4).
 *
 * The fixtures are rendered ID cards, not photographs of real documents — a real one
 * cannot go in a repository. They carry the layout and the type sizes that matter
 * (a 13-digit number under a bilingual label, beside other numbers that are not it),
 * and one of them is skewed, because a card photographed on a counter always is.
 *
 * What these tests are actually protecting is the REFUSAL. Autofill that guesses is
 * worse than no autofill: a misread thirteen-digit number looks exactly as convincing
 * as the right one, and it would end up on a signed delivery note.
 */
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const asDataUrl = async (name: string): Promise<string> =>
  `data:image/png;base64,${(await readFile(path.join(fixtures, name))).toString('base64')}`;

/** The number printed on both fixtures: born 1980-01-01, male, citizen. */
const PRINTED = '8001015009087';

let app: FastifyInstance;
let storesToken: string;
let techToken: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  storesToken = await loginAs(app, DEMO.stores);
  techToken = await loginAs(app, DEMO.technician);
});

afterAll(async () => {
  await stopIdOcr();
  await app.close();
});

const read = (imageBase64: string, token = storesToken) =>
  app.inject({
    method: 'POST',
    url: '/driver-id/read',
    headers: bearer(token),
    payload: { imageBase64 },
  });

describe('POST /driver-id/read', () => {
  it('reads the number off a photographed ID card', async () => {
    const res = await read(await asDataUrl('sa-id-card.png'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.idNumber).toBe(PRINTED);
    expect(body.reason).toBeNull();
    // The description is what the operator checks against the card in their hand, so
    // it has to carry more than the digits they would have to compare one by one.
    expect(body.description).toContain(PRINTED);
    expect(body.description).toContain('1980-01-01');
    expect(body.description).toContain('male');
  }, 30_000);

  it('still reads it off a card photographed at an angle', async () => {
    const res = await read(await asDataUrl('sa-id-card-skewed.png'));
    expect(res.statusCode).toBe(200);
    expect(res.json().idNumber).toBe(PRINTED);
  }, 30_000);

  it('says it found nothing rather than failing, for an image with no ID on it', async () => {
    // A blank frame is what a fumbled capture produces, and the operator's next move
    // is the same as always: type the number. So this is a 200 with a reason, not an
    // error that dead-ends the sign-off screen.
    const blank = `data:image/png;base64,${BLANK_PNG}`;
    const res = await read(blank);
    expect(res.statusCode).toBe(200);
    expect(res.json().idNumber).toBeNull();
    expect(res.json().reason).toMatch(/could not be read|Type it instead/i);
  }, 30_000);

  it('rejects a payload that is not an image at all', async () => {
    const res = await read(
      `data:image/png;base64,${Buffer.from('x'.repeat(200)).toString('base64')}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().idNumber).toBeNull();
    expect(res.json().reason).toMatch(/JPEG or PNG/i);
  });

  it('bounds the request body', async () => {
    expect((await read('short')).statusCode).toBe(400);
  });

  it('403s a technician — the sign-off screen is the stores manager’s', async () => {
    const res = await read(await asDataUrl('sa-id-card.png'), techToken);
    expect(res.statusCode).toBe(403);
  });

  it('401s without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/driver-id/read',
      payload: { imageBase64: `data:image/png;base64,${BLANK_PNG}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores nothing — it is a reading, not a record', async () => {
    const { prisma } = await import('../src/db.js');
    const before = await prisma.returnRecord.count();
    await read(await asDataUrl('sa-id-card.png'));
    expect(await prisma.returnRecord.count()).toBe(before);
  }, 30_000);
});

/** A real, blank 240x150 PNG — what a fumbled capture produces: an image the
 *  decoder is perfectly happy with and there is nothing on to read. */
const BLANK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAYAAADg+AXVAAABuElEQVR4nO3TMQ0AIAAEMfBv93fQcUnroXfbO0CSwBAmMIQJ' +
  'DGECQ5jAECYwhAkMYQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jAECYwhAkMYQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jA' +
  'ECYwhAkMYQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jAECYwhAkMYQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jAECYwhAkM' +
  'YQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jAECYwhAkMYQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jAECYwhAkMYQJDmMAQ' +
  'JjCECQxhAkOYwBAmMIQJDGECQ5jAECYwhAkMYQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jAECYwhAkMYQJDmMAQJjCECQxh' +
  'AkOYwBAmMIQJDGECQ5jAECYwhAkMYQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jAECYwhAkMYQJDmMAQJjCECQxhAkOYwBAm' +
  'MIQJDGECQ5jAECYwhAkMYQJDmMAQJjCECQxhAkOYwBAmMIQJDGECQ5jAEPYBo69DB73sDHcAAAAASUVORK5CYII=';
