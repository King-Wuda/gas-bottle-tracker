import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { DEMO, bearer, loginAs, resetDb } from './helpers.js';

/**
 * Driver profiles: a project manager keeps the regular drivers, and everyone who moves
 * cylinders picks from them at sign-off. See routes/drivers.ts.
 */
let app: FastifyInstance;
let adminToken: string;
let techToken: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  adminToken = await loginAs(app, DEMO.admin);
  techToken = await loginAs(app, DEMO.technician);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const create = (payload: Record<string, unknown>, token = adminToken) =>
  app.inject({ method: 'POST', url: '/admin/drivers', headers: bearer(token), payload });

const bongani = {
  name: 'Bongani',
  surname: 'Zulu',
  email: 'Bongani.Zulu@Example.com',
  phone: '071 234 5678',
};

describe('driver profiles', () => {
  it('a project manager creates one with name, surname, email and phone', async () => {
    const res = await create(bongani);
    expect(res.statusCode).toBe(201);
    expect(res.json().driver).toMatchObject({
      name: 'Bongani',
      surname: 'Zulu',
      fullName: 'Bongani Zulu',
      // Lowercased, like every address in the system.
      email: 'bongani.zulu@example.com',
      phone: '071 234 5678',
      active: true,
      transfers: 0,
      returns: 0,
    });
  });

  it('refuses a second driver with the same email, whatever its case', async () => {
    const res = await create({ ...bongani, email: 'BONGANI.ZULU@example.com' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DRIVER_EXISTS');
  });

  it('requires every field', async () => {
    for (const field of ['name', 'surname', 'email', 'phone'] as const) {
      const res = await create({ ...bongani, email: `x-${field}@example.com`, [field]: '' });
      expect(res.statusCode, field).toBe(400);
    }
  });

  it('only a project manager manages them', async () => {
    expect((await create({ ...bongani, email: 'tech@example.com' }, techToken)).statusCode).toBe(
      403,
    );
    const list = await app.inject({
      method: 'GET',
      url: '/admin/drivers',
      headers: bearer(techToken),
    });
    expect(list.statusCode).toBe(403);
  });

  it('everyone signed in can pick from the active ones; a deactivated one drops out', async () => {
    const pieter = (
      await create({
        name: 'Pieter',
        surname: 'van Wyk',
        email: 'pieter@example.com',
        phone: '082 444 1234',
      })
    ).json().driver;

    const before = await app.inject({ method: 'GET', url: '/drivers', headers: bearer(techToken) });
    expect(before.statusCode).toBe(200);
    expect(before.json().drivers.map((d: { fullName: string }) => d.fullName)).toEqual([
      'Bongani Zulu',
      'Pieter van Wyk',
    ]);

    const off = await app.inject({
      method: 'PATCH',
      url: `/admin/drivers/${pieter.id}`,
      headers: bearer(adminToken),
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/drivers', headers: bearer(techToken) });
    expect(after.json().drivers.map((d: { fullName: string }) => d.fullName)).toEqual([
      'Bongani Zulu',
    ]);
    // Still listed in the console, so they can be switched back on.
    const console = await app.inject({
      method: 'GET',
      url: '/admin/drivers',
      headers: bearer(adminToken),
    });
    expect(console.json().drivers).toHaveLength(2);
  });

  it('edits a profile', async () => {
    const [driver] = (
      await app.inject({ method: 'GET', url: '/drivers', headers: bearer(techToken) })
    ).json().drivers;
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/drivers/${driver.id}`,
      headers: bearer(adminToken),
      payload: { phone: '072 000 1111' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().driver.phone).toBe('072 000 1111');
  });

  it('previews and deletes a profile, unlinking the records that named it', async () => {
    const driver = await prisma.driver.findFirstOrThrow({ where: { name: 'Bongani' } });
    const impact = await app.inject({
      method: 'GET',
      url: `/admin/drivers/${driver.id}/impact`,
      headers: bearer(adminToken),
    });
    expect(impact.statusCode).toBe(200);
    expect(impact.json()).toEqual({ transfers: 0, returns: 0 });

    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/drivers/${driver.id}`,
      headers: bearer(adminToken),
    });
    expect(del.statusCode).toBe(200);
    expect(await prisma.driver.findUnique({ where: { id: driver.id } })).toBeNull();

    const again = await app.inject({
      method: 'DELETE',
      url: `/admin/drivers/${driver.id}`,
      headers: bearer(adminToken),
    });
    expect(again.statusCode).toBe(404);
  });
});
