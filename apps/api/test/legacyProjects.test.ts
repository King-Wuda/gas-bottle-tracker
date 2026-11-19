import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { removeLegacyProjects } from '../src/services/legacyProjects.js';
import {
  bearer,
  DEMO,
  loginAs,
  makeProjectManager,
  resetDb,
  supplierForGas,
  uniqueProjectNumber,
} from './helpers.js';

/**
 * The one-off clean-up of projects numbered in the old 6-3-1-2 shape.
 *
 * Production holds such projects under a constraint that still allowed them, so the test
 * rebuilds that state first: drop the constraint, insert an old-format project with a
 * batch on it beside a current one, then put back the migration's NOT VALID constraint.
 */
let app: FastifyInstance;
let techToken: string;

const STRICT = `CHECK ("projectNumber" ~ '^[0-9]{5}-[0-9]{3}-[0-9]{1}-[0-9]{2}$')`;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
});

afterAll(async () => {
  // Leave the constraint as the migration and the clean-up leave it in production.
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_projectNumber_format"',
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Project" ADD CONSTRAINT "Project_projectNumber_format" ${STRICT}`,
  );
  await app.close();
  await prisma.$disconnect();
});

async function projectWithBatch(projectNumber: string) {
  const pm = await makeProjectManager('Legacy PM');
  const client = await prisma.client.create({ data: { name: `Legacy client ${randomUUID()}` } });
  const site = await prisma.site.create({ data: { clientId: client.id, location: 'Yard' } });
  const project = await prisma.project.create({
    data: { projectNumber, clientId: client.id, projectManagerId: pm.id },
  });
  const gas = await prisma.gasType.findFirstOrThrow({ where: { name: 'Nitrogen' } });
  const res = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: bearer(techToken),
    payload: {
      projectId: project.id,
      siteId: site.id,
      clientRequestId: randomUUID(),
      lines: [
        {
          gasTypeId: gas.id,
          supplierId: await supplierForGas(gas.id),
          quantity: 2,
          initialDeliveryPoint: 'STORES',
        },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  return { projectId: project.id, batchId: res.json().batch.id as string };
}

const constraintValidated = async () =>
  (
    await prisma.$queryRaw<{ convalidated: boolean }[]>`
      SELECT "convalidated" FROM pg_constraint WHERE "conname" = 'Project_projectNumber_format'
    `
  )[0]?.convalidated;

describe('removing old-format projects', () => {
  it('deletes every project not numbered 5-3-1-2, with its batches, and keeps the rest', async () => {
    // Production as it stands before the clean-up.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_projectNumber_format"',
    );
    const old = await projectWithBatch('525080-008-1-01');
    const freeText = await projectWithBatch('PRJ-0001');
    const current = await projectWithBatch(uniqueProjectNumber());
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Project" ADD CONSTRAINT "Project_projectNumber_format" ${STRICT} NOT VALID`,
    );
    expect(await constraintValidated()).toBe(false);

    const lines: string[] = [];
    const result = await removeLegacyProjects((l) => lines.push(l));

    expect(result.deleted.map((d) => d.projectNumber).sort()).toEqual([
      '525080-008-1-01',
      'PRJ-0001',
    ]);
    expect(result.deleted.every((d) => d.impact.batches === 1 && d.impact.cylinders === 2)).toBe(
      true,
    );
    for (const gone of [old, freeText]) {
      expect(await prisma.project.count({ where: { id: gone.projectId } })).toBe(0);
      expect(await prisma.batch.count({ where: { id: gone.batchId } })).toBe(0);
      expect(await prisma.cylinder.count({ where: { batchId: gone.batchId } })).toBe(0);
    }
    expect(await prisma.batch.count({ where: { id: current.batchId } })).toBe(1);

    // And the database now guarantees the format for every row.
    expect(result.constraintValidated).toBe(true);
    expect(await constraintValidated()).toBe(true);
    expect(lines.join('\n')).toContain('525080-008-1-01');
  });

  it('does nothing the second time', async () => {
    const result = await removeLegacyProjects();
    expect(result.deleted).toEqual([]);
    expect(result.constraintValidated).toBe(true);
  });

  it('the database refuses an old-format number from here on', async () => {
    const pm = await makeProjectManager('After PM');
    const client = await prisma.client.create({ data: { name: `After client ${randomUUID()}` } });
    await expect(
      prisma.project.create({
        data: { projectNumber: '123456-789-1-23', clientId: client.id, projectManagerId: pm.id },
      }),
    ).rejects.toThrow();
  });
});
