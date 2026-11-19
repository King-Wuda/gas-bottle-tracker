import type { FastifyInstance } from 'fastify';
import {
  createDriverRequestSchema,
  driverFullName,
  updateDriverRequestSchema,
  type DriverImpactResponse,
  type DriverProfileDto,
  type DriverResponse,
  type DriversResponse,
} from '@gct/shared';
import { prisma, Prisma } from '../db.js';

/**
 * Driver profiles: the regular collection drivers, so a transfer or a return picks one
 * instead of re-typing their name, email and phone every time.
 *
 * Anyone who moves cylinders can READ the active profiles (`GET /drivers`) — that is
 * the picker on the sign-off screen. Only a project manager creates, edits,
 * deactivates or deletes one, from the admin console.
 *
 * A profile is reference data, not evidence. Every transfer and return copies the
 * driver's details at the moment of signing, so editing a profile never rewrites a
 * past delivery and deleting one only unlinks the records that named it.
 */
type DriverRow = {
  id: string;
  name: string;
  surname: string;
  email: string;
  phone: string;
  active: boolean;
  _count: { transfers: number; returns: number };
};

const driverInclude = { _count: { select: { transfers: true, returns: true } } } as const;

const toDriverDto = (d: DriverRow): DriverProfileDto => ({
  id: d.id,
  name: d.name,
  surname: d.surname,
  fullName: driverFullName(d),
  email: d.email,
  phone: d.phone,
  active: d.active,
  transfers: d._count.transfers,
  returns: d._count.returns,
});

const notFound = { error: { code: 'NOT_FOUND', message: 'Driver not found' } };
const emailTaken = {
  error: { code: 'DRIVER_EXISTS', message: 'A driver with that email address already exists.' },
};

export async function driverRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = { preHandler: app.requireRole('PROJECT_MANAGER') };

  /** The picker: active drivers only, by name. */
  app.get('/drivers', { preHandler: app.authenticate }, async () => {
    const rows = await prisma.driver.findMany({
      where: { active: true },
      include: driverInclude,
      orderBy: [{ name: 'asc' }, { surname: 'asc' }],
    });
    const body: DriversResponse = { drivers: rows.map(toDriverDto) };
    return body;
  });

  /** The console: everyone, active first. */
  app.get('/admin/drivers', adminOnly, async () => {
    const rows = await prisma.driver.findMany({
      include: driverInclude,
      orderBy: [{ active: 'desc' }, { name: 'asc' }, { surname: 'asc' }],
    });
    const body: DriversResponse = { drivers: rows.map(toDriverDto) };
    return body;
  });

  app.post('/admin/drivers', adminOnly, async (request, reply) => {
    const input = createDriverRequestSchema.parse(request.body);
    try {
      const driver = await prisma.driver.create({ data: input, include: driverInclude });
      const body: DriverResponse = { driver: toDriverDto(driver) };
      return reply.code(201).send(body);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send(emailTaken);
      }
      throw err;
    }
  });

  app.patch('/admin/drivers/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateDriverRequestSchema.parse(request.body);
    if (!(await prisma.driver.findUnique({ where: { id } }))) {
      return reply.code(404).send(notFound);
    }
    try {
      const driver = await prisma.driver.update({
        where: { id },
        data: input,
        include: driverInclude,
      });
      const body: DriverResponse = { driver: toDriverDto(driver) };
      return body;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send(emailTaken);
      }
      throw err;
    }
  });

  app.get('/admin/drivers/:id/impact', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driver = await prisma.driver.findUnique({ where: { id }, include: driverInclude });
    if (!driver) return reply.code(404).send(notFound);
    const body: DriverImpactResponse = {
      transfers: driver._count.transfers,
      returns: driver._count.returns,
    };
    return body;
  });

  /** Unlinks the transfers and returns that named them (ON DELETE SET NULL); each keeps
   *  the details it was signed under. */
  app.delete('/admin/drivers/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driver = await prisma.driver.findUnique({ where: { id }, include: driverInclude });
    if (!driver) return reply.code(404).send(notFound);
    await prisma.driver.delete({ where: { id } });
    request.log.warn(
      { driverId: id, transfers: driver._count.transfers, returns: driver._count.returns },
      'admin deleted a driver profile',
    );
    const body: DriverImpactResponse = {
      transfers: driver._count.transfers,
      returns: driver._count.returns,
    };
    return body;
  });
}
