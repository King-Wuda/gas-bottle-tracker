import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  loginAs,
  bearer,
  DEMO,
  makeProjectManager,
  resetDb,
  uniqueProjectNumber as uniqueNo,
} from './helpers.js';

let app: FastifyInstance;
let techToken: string;
let storesToken: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('GET /gas-types', () => {
  it('returns the seeded active gas types', async () => {
    const res = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
    expect(res.statusCode).toBe(200);
    const names = res.json().gasTypes.map((g: { name: string }) => g.name);
    expect(names).toEqual(expect.arrayContaining(['Nitrogen', 'Argon']));
    // Deactivated by the seed, so the dropdown offers only what the spec asks for.
    expect(names).not.toContain('Oxygen');
    const nit = res.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen');
    expect(nit.prefix).toBe('NIT');
  });

  it('401s without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/gas-types' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /projects — create new site', () => {
  it('creates project + PM + first site (201)', async () => {
    const projectNumber = uniqueNo();
    const pm = await makeProjectManager('Lerato Dlamini');
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber,
        projectManagerId: pm.id,
        site: { name: 'North Yard', location: 'Pretoria' },
      },
    });
    expect(res.statusCode).toBe(201);
    const { project } = res.json();
    expect(project.projectNumber).toBe(projectNumber);
    expect(project.projectManager.name).toBe('Lerato Dlamini');
    expect(project.sites).toHaveLength(1);
    expect(project.sites[0]).toMatchObject({ name: 'North Yard', location: 'Pretoria' });
    expect(project.activeBatchCount).toBe(0);
  });

  it('409s on a duplicate project number', async () => {
    const projectNumber = uniqueNo();
    const pm = await makeProjectManager('Dup');
    const payload = {
      projectNumber,
      projectManagerId: pm.id,
      site: { name: 'Yard', location: 'Here' },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');
  });

  it('403s for a stores manager', async () => {
    const pm = await makeProjectManager('Forbidden');
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(storesToken),
      payload: {
        projectNumber: uniqueNo(),
        projectManagerId: pm.id,
        site: { name: 'Y', location: 'Z' },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400s on a malformed body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: { projectNumber: '', projectManagerId: '', site: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('rejects a project number that is not ######-###-#-##', async () => {
    const pm = await makeProjectManager('Format PM');
    // The old free-text shape, a right-length-but-wrong-grouping number, and letters.
    for (const projectNumber of ['PRJ-0001', '123456-789-12-3', '12345A-789-1-23']) {
      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: bearer(techToken),
        payload: {
          projectNumber,
          projectManagerId: pm.id,
          site: { name: 'Yard', location: 'Here' },
        },
      });
      expect(res.statusCode, projectNumber).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
  });

  it('400s when the project manager id is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber: uniqueNo(),
        projectManagerId: 'no-such-manager',
        site: { name: 'Yard', location: 'Here' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PROJECT_MANAGER');
  });

  it('refuses a bad project number at the database too, not only in zod', async () => {
    // The CHECK constraint is the backstop for anything that reaches Postgres without
    // passing through the route — a migration, a script, psql.
    const pm = await makeProjectManager('Constraint PM');
    await expect(
      prisma.project.create({ data: { projectNumber: 'PRJ-0002', projectManagerId: pm.id } }),
    ).rejects.toThrow();
  });
});

describe('GET /projects — search', () => {
  it('finds by project number and by PM name substring', async () => {
    const projectNumber = uniqueNo();
    const pm = await makeProjectManager(`Zanele Search ${projectNumber}`);
    await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber,
        projectManagerId: pm.id,
        site: { name: 'S', location: 'L' },
      },
    });

    const byNumber = await app.inject({
      method: 'GET',
      // A substring from the middle: the trgm index has to serve ILIKE '%...%'.
      url: `/projects?q=${encodeURIComponent(projectNumber.slice(3, 10))}`,
      headers: bearer(techToken),
    });
    expect(byNumber.statusCode).toBe(200);
    expect(
      byNumber
        .json()
        .projects.some((p: { projectNumber: string }) => p.projectNumber === projectNumber),
    ).toBe(true);

    const byPm = await app.inject({
      method: 'GET',
      url: `/projects?q=${encodeURIComponent('Zanele Search')}`,
      headers: bearer(techToken),
    });
    expect(
      byPm
        .json()
        .projects.some((p: { projectNumber: string }) => p.projectNumber === projectNumber),
    ).toBe(true);
    const row = byPm
      .json()
      .projects.find((p: { projectNumber: string }) => p.projectNumber === projectNumber);
    expect(row.siteCount).toBe(1);
    expect(row.activeBatchCount).toBe(0);
  });
});

describe('GET /projects/:id', () => {
  it('returns sites; 404 for an unknown id', async () => {
    const projectNumber = uniqueNo();
    const pm = await makeProjectManager('Detail PM');
    const created = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber,
        projectManagerId: pm.id,
        site: { name: 'First', location: 'Loc' },
      },
    });
    const id = created.json().project.id;

    const ok = await app.inject({
      method: 'GET',
      url: `/projects/${id}`,
      headers: bearer(techToken),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().project.sites).toHaveLength(1);

    const missing = await app.inject({
      method: 'GET',
      url: '/projects/does-not-exist',
      headers: bearer(techToken),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /projects/:id/sites — edit existing site', () => {
  it('adds a site; 409 on duplicate name; 404 on unknown project', async () => {
    const projectNumber = uniqueNo();
    const pm = await makeProjectManager('Sites PM');
    const created = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber,
        projectManagerId: pm.id,
        site: { name: 'Alpha', location: 'A' },
      },
    });
    const id = created.json().project.id;

    const added = await app.inject({
      method: 'POST',
      url: `/projects/${id}/sites`,
      headers: bearer(techToken),
      payload: { name: 'Beta', location: 'B' },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().site).toMatchObject({ name: 'Beta', location: 'B', projectId: id });

    const dup = await app.inject({
      method: 'POST',
      url: `/projects/${id}/sites`,
      headers: bearer(techToken),
      payload: { name: 'Alpha', location: 'again' },
    });
    expect(dup.statusCode).toBe(409);

    const missing = await app.inject({
      method: 'POST',
      url: '/projects/nope/sites',
      headers: bearer(techToken),
      payload: { name: 'X', location: 'Y' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
