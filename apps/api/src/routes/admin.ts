import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  createGasTypeRequestSchema,
  createProjectManagerRequestSchema,
  createSupplierRequestSchema,
  createUserRequestSchema,
  gasSupplierPairingRequestSchema,
  serialYear,
  systemClock,
  updateBatchRequestSchema,
  updateGasTypeRequestSchema,
  updateProjectManagerRequestSchema,
  updateSupplierRequestSchema,
  updateUserRequestSchema,
  type AdminClientDto,
  type AdminClientsResponse,
  type AdminGasTypeDto,
  type AdminGasTypeResponse,
  type AdminGasTypesResponse,
  type AdminProjectManagerDto,
  type AdminProjectManagerResponse,
  type AdminProjectManagersResponse,
  type AdminSupplierDto,
  type AdminSupplierResponse,
  type AdminSuppliersResponse,
  type AdminUserDto,
  type AdminUserResponse,
  type AdminUsersResponse,
  type BatchAmendmentDto,
  type BatchAmendmentsResponse,
  type BatchDetailResponse,
  type DeletionImpactResponse,
  type DeletionResponse,
  type MovementType,
} from '@gct/shared';
import { prisma, Prisma } from '../db.js';
import { env } from '../env.js';
import { hashPassword } from '../lib/password.js';
import { allocateSerials } from '../services/serial.js';
import { emailDeliveryFor, loadBatchDto } from '../services/batchView.js';
import {
  deleteAllSitesOfProject,
  deleteGasType,
  deleteProject,
  deleteSite,
  deleteSupplier,
  gasTypeImpact,
  projectImpact,
  siteImpact,
  supplierImpact,
} from '../services/adminDelete.js';

/**
 * The admin console: who can use the system, who the paperwork goes to, and fixing a
 * batch that was booked in wrong.
 *
 * Every route here is ADMIN-only, and every one of them is careful about the same
 * thing: this system's product is *evidence*. A batch that was mis-keyed can be
 * corrected, but only in ways that do not contradict what the movement log already
 * proves, and never without recording that the correction happened.
 *
 * Deactivating remains the everyday way to retire a person, a gas or a supplier, and
 * it is what the pickers respect. The DELETE routes below are the deliberate
 * exception: a depot that has finished with a client wants the client gone, not
 * greyed out. They are destructive on purpose, they report exactly what they removed,
 * and every one of them has a matching `/impact` route so the screen can say "3
 * batches, 41 cylinders and 2 signed delivery notes" before anyone confirms.
 *
 * Users are the one thing a delete does NOT cascade through, because their foreign
 * keys run into other clients' records — see DELETE /admin/users/:id.
 */

/** One recorded field change, as stored in `BatchAmendment.changes`. */
interface Change {
  field: string;
  from: string;
  to: string;
}

const renderChanges = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return (raw as Change[])
    .filter((c) => c && typeof c.field === 'string')
    .map((c) => `${c.field}: ${c.from} → ${c.to}`);
};

/** Refuses a correction that would contradict the movement log. */
class ImmutableHistoryError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = { preHandler: app.requireRole('ADMIN') };

  // ------------------------------------------------------------------ users

  const toUserDto = (u: {
    id: string;
    email: string;
    name: string;
    role: AdminUserDto['role'];
    active: boolean;
    createdAt: Date;
    _count: { batchesCreated: number; movementEvents: number };
  }): AdminUserDto => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt.toISOString(),
    batchesCreated: u._count.batchesCreated,
    movementsRecorded: u._count.movementEvents,
  });

  const userCounts = {
    _count: { select: { batchesCreated: true, movementEvents: true } },
  } as const;

  app.get('/admin/users', adminOnly, async () => {
    const rows = await prisma.user.findMany({
      // A deleted account is not an account any more: it survives only to give the
      // history a name, and listing it would invite someone to "reactivate" a login
      // whose password was scrambled on the way out.
      where: { deletedAt: null },
      include: userCounts,
      // Active first, then by role, then by name: the list is read to find someone,
      // and a deactivated account is the one you are least likely to be looking for.
      orderBy: [{ active: 'desc' }, { role: 'asc' }, { name: 'asc' }],
    });
    const body: AdminUsersResponse = { users: rows.map(toUserDto) };
    return body;
  });

  app.post('/admin/users', adminOnly, async (request, reply) => {
    const input = createUserRequestSchema.parse(request.body);
    const email = input.email.trim().toLowerCase();

    try {
      const user = await prisma.user.create({
        data: {
          email,
          name: input.name.trim(),
          role: input.role,
          passwordHash: await hashPassword(input.password),
        },
        include: userCounts,
      });
      const body: AdminUserResponse = { user: toUserDto(user) };
      return reply.code(201).send(body);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply
          .code(409)
          .send({ error: { code: 'EMAIL_TAKEN', message: 'That email already has an account' } });
      }
      throw err;
    }
  });

  app.patch('/admin/users/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateUserRequestSchema.parse(request.body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    // An admin who deactivates or demotes themselves is one tap from locking the
    // whole organisation out of this console. Refuse it rather than let them discover
    // it on the next login.
    const selfDemotion =
      target.id === request.user.sub &&
      (input.active === false || (input.role !== undefined && input.role !== 'ADMIN'));
    if (selfDemotion) {
      return reply.code(400).send({
        error: {
          code: 'CANNOT_DEMOTE_SELF',
          message: 'You cannot deactivate or change the role of your own account.',
        },
      });
    }

    // Likewise the last one standing: losing every admin means no route back in
    // short of a database console.
    const losingAdmin =
      target.role === 'ADMIN' &&
      target.active &&
      (input.active === false || (input.role !== undefined && input.role !== 'ADMIN'));
    if (losingAdmin) {
      const otherAdmins = await prisma.user.count({
        where: { role: 'ADMIN', active: true, id: { not: target.id } },
      });
      if (otherAdmins === 0) {
        return reply.code(400).send({
          error: {
            code: 'LAST_ADMIN',
            message: 'This is the only active admin. Promote someone else first.',
          },
        });
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.password !== undefined
          ? { passwordHash: await hashPassword(input.password) }
          : {}),
      },
      include: userCounts,
    });

    // A deactivated or demoted account must lose its existing sessions too: the
    // access token in its pocket is still signed and still valid, and only revoking
    // the refresh tokens stops it being renewed indefinitely. (The access token
    // itself expires on its own short TTL.)
    if (input.active === false || input.role !== undefined || input.password !== undefined) {
      await prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const body: AdminUserResponse = { user: toUserDto(user) };
    return body;
  });

  // ------------------------------------------------------- project managers

  const toPmDto = (p: {
    id: string;
    name: string;
    email: string;
    active: boolean;
    createdAt: Date;
    _count: { projects: number };
    batches?: { id: string }[];
  }): AdminProjectManagerDto => ({
    id: p.id,
    name: p.name,
    email: p.email,
    active: p.active,
    createdAt: p.createdAt.toISOString(),
    projectCount: p._count.projects,
    openBatchCount: p.batches?.length ?? 0,
  });

  const pmInclude = {
    _count: { select: { projects: true } },
    // Only the batches still live: a manager with 400 closed batches behind them is
    // not the question being asked before deactivating them.
    batches: { where: { status: { not: 'RETURNED' as const } }, select: { id: true } },
  } as const;

  app.get('/admin/project-managers', adminOnly, async () => {
    const rows = await prisma.projectManager.findMany({
      include: pmInclude,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    const body: AdminProjectManagersResponse = { projectManagers: rows.map(toPmDto) };
    return body;
  });

  app.post('/admin/project-managers', adminOnly, async (request, reply) => {
    const input = createProjectManagerRequestSchema.parse(request.body);
    try {
      const pm = await prisma.projectManager.create({
        data: { name: input.name.trim(), email: input.email.trim().toLowerCase() },
        include: pmInclude,
      });
      const body: AdminProjectManagerResponse = { projectManager: toPmDto(pm) };
      return reply.code(201).send(body);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({
          error: { code: 'EMAIL_TAKEN', message: 'A project manager already uses that email' },
        });
      }
      throw err;
    }
  });

  app.patch('/admin/project-managers/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateProjectManagerRequestSchema.parse(request.body);

    const target = await prisma.projectManager.findUnique({ where: { id } });
    if (!target) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Project manager not found' } });
    }

    try {
      const pm = await prisma.projectManager.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
        include: pmInclude,
      });
      // NB: changing the email here deliberately does NOT rewrite
      // `Batch.projectManagerEmail` on batches already addressed to them. That column
      // answers "where did this batch's paperwork actually go?", and correcting a
      // typo in someone's address must not retroactively change the answer. Handing a
      // batch to a different manager is a separate, explicit act — a transfer, or the
      // batch correction below.
      const body: AdminProjectManagerResponse = { projectManager: toPmDto(pm) };
      return body;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({
          error: { code: 'EMAIL_TAKEN', message: 'A project manager already uses that email' },
        });
      }
      throw err;
    }
  });

  // ------------------------------------------------------ batch correction

  app.get('/admin/batches/:id/amendments', adminOnly, async (request) => {
    const { id } = request.params as { id: string };
    const rows = await prisma.batchAmendment.findMany({
      where: { batchId: id },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const body: BatchAmendmentsResponse = {
      amendments: rows.map((a): BatchAmendmentDto => ({
        id: a.id,
        batchId: a.batchId,
        userId: a.userId,
        userName: a.user.name,
        changes: renderChanges(a.changes),
        reason: a.reason,
        createdAt: a.createdAt.toISOString(),
      })),
    };
    return body;
  });

  /**
   * Correct a batch that was entered wrong.
   *
   * The rule that shapes every branch below: **a cylinder that has moved is evidence,
   * not a typo.** Paperwork fields (manager, site label, supplier, delivery point) are
   * always correctable. Anything that would rewrite what a serial *is* — its gas, and
   * therefore its printed label — or make cylinders vanish is allowed only while the
   * cylinders in question have never left stores and have no movement beyond their
   * INTAKE. Otherwise the correction is refused with a reason, because silently
   * dropping a scanned cylinder would erase a rental someone is being charged for.
   */
  app.patch('/admin/batches/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateBatchRequestSchema.parse(request.body);

    const batch = await prisma.batch.findUnique({
      where: { id },
      include: {
        site: true,
        projectManager: true,
        lines: { include: { gasType: true } },
      },
    });
    if (!batch) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
    }

    const changes: Change[] = [];
    const userId = request.user.sub;
    const year = serialYear(systemClock, env().SERIAL_YEAR_TZ);

    try {
      await prisma.$transaction(
        async (tx) => {
          // --- addressee ---
          if (input.projectManagerId && input.projectManagerId !== batch.projectManagerId) {
            const pm = await tx.projectManager.findUnique({
              where: { id: input.projectManagerId },
            });
            if (!pm || !pm.active) {
              throw new ImmutableHistoryError(
                'INVALID_PROJECT_MANAGER',
                'Unknown or deactivated project manager',
              );
            }
            await tx.batch.update({
              where: { id },
              data: { projectManagerId: pm.id, projectManagerEmail: pm.email },
            });
            changes.push({
              field: 'Project manager',
              from: batch.projectManager.name,
              to: pm.name,
            });
          }

          // --- site ---
          if (input.siteId && input.siteId !== batch.siteId) {
            const site = await tx.site.findUnique({ where: { id: input.siteId } });
            if (!site || site.projectId !== batch.projectId) {
              throw new ImmutableHistoryError(
                'INVALID_SITE',
                'Site does not belong to this batch’s project',
              );
            }
            await tx.batch.update({ where: { id }, data: { siteId: site.id } });
            changes.push({ field: 'Site', from: batch.site.name, to: site.name });
          }

          // --- line removals ---
          for (const lineId of input.removeLineIds ?? []) {
            const line = batch.lines.find((l) => l.id === lineId);
            if (!line) {
              throw new ImmutableHistoryError('UNKNOWN_LINE', 'That line is not on this batch');
            }
            await assertLineUntouched(tx, lineId, `remove the ${line.gasType.name} line`);
            // Cylinder rows cascade from BatchLine; their INTAKE events do not, so
            // they are cleared explicitly. Safe only because assertLineUntouched has
            // just proved INTAKE is all there is.
            const cylinderIds = (
              await tx.cylinder.findMany({ where: { batchLineId: lineId }, select: { id: true } })
            ).map((c) => c.id);
            await tx.movementEvent.deleteMany({ where: { cylinderId: { in: cylinderIds } } });
            await tx.cylinder.deleteMany({ where: { batchLineId: lineId } });
            await tx.batchLine.delete({ where: { id: lineId } });
            changes.push({
              field: 'Line removed',
              from: `${line.quantity} × ${line.gasType.name}`,
              to: '—',
            });
          }

          // --- line edits and additions ---
          const ctx = { tx, batchId: id, userId, year, changes };
          for (const edit of input.lines ?? []) {
            if (edit.id) await editLine(ctx, edit);
            else await addLine(ctx, edit);
          }

          if (changes.length === 0) {
            throw new ImmutableHistoryError('NO_CHANGES', 'Nothing on this batch would change');
          }

          // The amendment is written in the SAME transaction as the edit it records.
          // A trail that can be committed separately from the change is a trail that
          // will eventually be missing the change that mattered.
          await tx.batchAmendment.create({
            data: {
              batchId: id,
              userId,
              changes: changes as unknown as Prisma.InputJsonValue,
              reason: input.reason?.trim() || null,
            },
          });
        },
        { timeout: 30_000, maxWait: 15_000 },
      );
    } catch (err) {
      if (err instanceof ImmutableHistoryError) {
        return reply.code(400).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }

    const dto = await loadBatchDto(id);
    const body: BatchDetailResponse = {
      batch: dto!,
      emailDelivery: await emailDeliveryFor(dto!.id),
    };
    return body;
  });

  // ------------------------------------------------------------ deleting a user

  /**
   * Delete an account — including another admin's.
   *
   * Two outcomes, and which one happens is decided by the data rather than by a
   * setting. An account that has never authored anything is deleted outright: nothing
   * points at it, so there is nothing to keep. An account that HAS is tombstoned —
   * password scrambled, email released for reuse, every session revoked — and its name
   * stays on the batches, scans and sign-offs it produced.
   *
   * That asymmetry is not a hedge. `Batch.createdByUserId` and five more are required
   * foreign keys, so a true cascade here would delete every batch the person ever
   * booked in, which for a depot technician means other clients' deliveries, their
   * signed delivery notes and their movement log. Removing one employee must not be a
   * way to destroy four customers' records.
   */
  app.delete('/admin/users/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };

    const target = await prisma.user.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            batchesCreated: true,
            movementEvents: true,
            transfers: true,
            returnsManaged: true,
            amendments: true,
            initializations: true,
            batchPhotos: true,
          },
        },
      },
    });
    if (!target || target.deletedAt) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    // The same two guards the PATCH route applies, for the same reason: an admin who
    // deletes themselves, or the last admin, locks the organisation out of this
    // console entirely — and unlike a deactivation there is no undoing it.
    if (target.id === request.user.sub) {
      return reply.code(400).send({
        error: {
          code: 'CANNOT_DELETE_SELF',
          message: 'You cannot delete your own account. Ask another admin to do it.',
        },
      });
    }
    if (target.role === 'ADMIN') {
      const otherAdmins = await prisma.user.count({
        where: { role: 'ADMIN', active: true, deletedAt: null, id: { not: target.id } },
      });
      if (otherAdmins === 0) {
        return reply.code(400).send({
          error: {
            code: 'LAST_ADMIN',
            message: 'This is the only active admin. Promote someone else first.',
          },
        });
      }
    }

    const authored = Object.values(target._count).reduce((n, c) => n + c, 0);

    await prisma.$transaction(async (tx) => {
      // Sessions die first either way: the access token already in their pocket is
      // still signed, and only revoking the refresh tokens stops it being renewed.
      await tx.refreshToken.deleteMany({ where: { userId: id } });

      if (authored === 0) {
        await tx.user.delete({ where: { id } });
        return;
      }

      await tx.user.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          active: false,
          // Released so the address can be given to a new account, and scrambled so
          // the old hash cannot be checked against anything. The name is deliberately
          // untouched — it is what History attributes their work to.
          email: `deleted+${id}@deleted.invalid`,
          passwordHash: await hashPassword(randomUUID() + randomUUID()),
        },
      });
    });

    request.log.warn(
      { userId: id, name: target.name, authored, purged: authored === 0 },
      'admin deleted a user account',
    );
    return { deleted: true, authoredRecordsKept: authored };
  });

  // --------------------------------------------------------------- gases

  const gasInclude = {
    suppliers: { include: { supplier: { select: { id: true, name: true } } } },
    _count: { select: { batchLines: true } },
  } as const;

  type GasRow = {
    id: string;
    name: string;
    prefix: string;
    active: boolean;
    suppliers: { supplier: { id: string; name: string } }[];
    _count: { batchLines: number };
  };

  const toGasDto = (g: GasRow): AdminGasTypeDto => ({
    id: g.id,
    name: g.name,
    prefix: g.prefix,
    active: g.active,
    suppliers: g.suppliers.map((s) => s.supplier).sort((a, b) => a.name.localeCompare(b.name)),
    usageCount: g._count.batchLines,
  });

  app.get('/admin/gas-types', adminOnly, async () => {
    const rows = await prisma.gasType.findMany({
      include: gasInclude,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    const body: AdminGasTypesResponse = { gasTypes: rows.map(toGasDto) };
    return body;
  });

  app.post('/admin/gas-types', adminOnly, async (request, reply) => {
    const input = createGasTypeRequestSchema.parse(request.body);
    try {
      const gasType = await prisma.gasType.create({
        data: { name: input.name, prefix: input.prefix },
        include: gasInclude,
      });
      const body: AdminGasTypeResponse = { gasType: toGasDto(gasType) };
      return reply.code(201).send(body);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Both name and prefix are unique, and the prefix is the one that matters:
        // two gases sharing it would issue serials that collide on a label.
        const field = (err.meta?.target as string[] | undefined)?.includes('prefix')
          ? 'prefix'
          : 'name';
        return reply.code(409).send({
          error: {
            code: 'GAS_TYPE_EXISTS',
            message: `A gas with that ${field} already exists.`,
          },
        });
      }
      throw err;
    }
  });

  /** Rename, or take it out of the pickers without destroying anything. */
  app.patch('/admin/gas-types/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateGasTypeRequestSchema.parse(request.body);
    const existing = await prisma.gasType.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Gas not found' } });
    }
    // The prefix is deliberately not editable: it is stamped into every serial the gas
    // has already issued, and those are printed on labels stuck to physical cylinders.
    const gasType = await prisma.gasType.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      include: gasInclude,
    });
    const body: AdminGasTypeResponse = { gasType: toGasDto(gasType) };
    return body;
  });

  app.get('/admin/gas-types/:id/impact', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.gasType.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Gas not found' } });
    }
    const body: DeletionImpactResponse = { impact: await gasTypeImpact(id) };
    return body;
  });

  app.delete('/admin/gas-types/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.gasType.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Gas not found' } });
    }
    const body: DeletionResponse = { deleted: true, impact: await deleteGasType(id, request.log) };
    return body;
  });

  // ------------------------------------------------- suppliers for a gas

  /**
   * Offer a supplier for a gas, or stop offering it.
   *
   * The only reversible delete in this console: `BatchLine` snapshots the supplier's
   * NAME at intake, so unpairing changes what tomorrow's batch form offers and nothing
   * about what yesterday's recorded. No impact preview, because there is no impact.
   */
  app.post('/admin/gas-types/:id/suppliers', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { supplierId } = gasSupplierPairingRequestSchema.parse(request.body);

    const [gas, supplier] = await Promise.all([
      prisma.gasType.findUnique({ where: { id } }),
      prisma.supplier.findUnique({ where: { id: supplierId } }),
    ]);
    if (!gas || !supplier) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Gas or supplier not found' } });
    }

    // Idempotent: pairing something already paired is the same end state, and the
    // screen should not have to care whether its list was a second stale.
    await prisma.gasSupplier.upsert({
      where: { gasTypeId_supplierId: { gasTypeId: id, supplierId } },
      create: { gasTypeId: id, supplierId },
      update: {},
    });

    const gasType = await prisma.gasType.findUniqueOrThrow({ where: { id }, include: gasInclude });
    const body: AdminGasTypeResponse = { gasType: toGasDto(gasType) };
    return body;
  });

  app.delete('/admin/gas-types/:id/suppliers/:supplierId', adminOnly, async (request, reply) => {
    const { id, supplierId } = request.params as { id: string; supplierId: string };
    if (!(await prisma.gasType.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Gas not found' } });
    }
    await prisma.gasSupplier.deleteMany({ where: { gasTypeId: id, supplierId } });
    const gasType = await prisma.gasType.findUniqueOrThrow({ where: { id }, include: gasInclude });
    const body: AdminGasTypeResponse = { gasType: toGasDto(gasType) };
    return body;
  });

  // --------------------------------------------------------------- suppliers

  const supplierInclude = {
    gasTypes: { include: { gasType: { select: { id: true, name: true } } } },
    _count: { select: { batchLines: true } },
  } as const;

  type SupplierRow = {
    id: string;
    name: string;
    active: boolean;
    gasTypes: { gasType: { id: string; name: string } }[];
    _count: { batchLines: number };
  };

  const toSupplierDto = (s: SupplierRow): AdminSupplierDto => ({
    id: s.id,
    name: s.name,
    active: s.active,
    gasTypes: s.gasTypes.map((g) => g.gasType).sort((a, b) => a.name.localeCompare(b.name)),
    usageCount: s._count.batchLines,
  });

  app.get('/admin/suppliers', adminOnly, async () => {
    const rows = await prisma.supplier.findMany({
      include: supplierInclude,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    const body: AdminSuppliersResponse = { suppliers: rows.map(toSupplierDto) };
    return body;
  });

  app.post('/admin/suppliers', adminOnly, async (request, reply) => {
    const input = createSupplierRequestSchema.parse(request.body);
    try {
      const supplier = await prisma.supplier.create({
        data: {
          name: input.name,
          ...(input.gasTypeIds?.length
            ? { gasTypes: { create: input.gasTypeIds.map((gasTypeId) => ({ gasTypeId })) } }
            : {}),
        },
        include: supplierInclude,
      });
      const body: AdminSupplierResponse = { supplier: toSupplierDto(supplier) };
      return reply.code(201).send(body);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') {
          return reply.code(409).send({
            error: {
              code: 'SUPPLIER_EXISTS',
              message: 'A supplier with that name already exists.',
            },
          });
        }
        // A gas id that does not exist — a stale form, not a reason to create one.
        if (err.code === 'P2003' || err.code === 'P2025') {
          return reply.code(400).send({
            error: { code: 'UNKNOWN_GAS_TYPE', message: 'One of those gases no longer exists.' },
          });
        }
      }
      throw err;
    }
  });

  app.patch('/admin/suppliers/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateSupplierRequestSchema.parse(request.body);
    if (!(await prisma.supplier.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Supplier not found' } });
    }
    const supplier = await prisma.supplier.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      include: supplierInclude,
    });
    const body: AdminSupplierResponse = { supplier: toSupplierDto(supplier) };
    return body;
  });

  app.get('/admin/suppliers/:id/impact', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.supplier.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Supplier not found' } });
    }
    const body: DeletionImpactResponse = { impact: await supplierImpact(id) };
    return body;
  });

  app.delete('/admin/suppliers/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.supplier.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Supplier not found' } });
    }
    const body: DeletionResponse = { deleted: true, impact: await deleteSupplier(id, request.log) };
    return body;
  });

  // ----------------------------------------------------- clients and locations

  const clientInclude = {
    projectManager: { select: { id: true, name: true } },
    sites: {
      orderBy: { name: 'asc' as const },
      include: { _count: { select: { batches: true } } },
    },
    _count: { select: { batches: true } },
  } as const;

  type ClientRow = {
    id: string;
    projectNumber: string;
    projectManagerId: string;
    status: 'ACTIVE' | 'CLOSED';
    createdAt: Date;
    projectManager: { id: string; name: string };
    sites: { id: string; name: string; location: string; _count: { batches: number } }[];
    _count: { batches: number };
  };

  const toClientDto = (p: ClientRow): AdminClientDto => ({
    id: p.id,
    projectNumber: p.projectNumber,
    projectManagerId: p.projectManagerId,
    projectManagerName: p.projectManager.name,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    locations: p.sites.map((s) => ({
      id: s.id,
      name: s.name,
      location: s.location,
      batchCount: s._count.batches,
    })),
    batchCount: p._count.batches,
  });

  app.get('/admin/clients', adminOnly, async () => {
    const rows = await prisma.project.findMany({
      include: clientInclude,
      orderBy: [{ status: 'asc' }, { projectNumber: 'asc' }],
    });
    const body: AdminClientsResponse = { clients: rows.map(toClientDto) };
    return body;
  });

  app.get('/admin/clients/:id/impact', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.project.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }
    const body: DeletionImpactResponse = { impact: await projectImpact(id) };
    return body;
  });

  /** The client, every location under it, and everything those locations hold. */
  app.delete('/admin/clients/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.project.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }
    const body: DeletionResponse = { deleted: true, impact: await deleteProject(id, request.log) };
    return body;
  });

  app.get('/admin/clients/:id/locations/:siteId/impact', adminOnly, async (request, reply) => {
    const { id, siteId } = request.params as { id: string; siteId: string };
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site || site.projectId !== id) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Location not found' } });
    }
    const body: DeletionImpactResponse = { impact: await siteImpact(siteId) };
    return body;
  });

  /** One location of a client. */
  app.delete('/admin/clients/:id/locations/:siteId', adminOnly, async (request, reply) => {
    const { id, siteId } = request.params as { id: string; siteId: string };
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    // Checked against the client in the path, not just by id: a mistyped site id that
    // happens to exist under a DIFFERENT client must not silently delete that one.
    if (!site || site.projectId !== id) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Location not found' } });
    }
    const body: DeletionResponse = { deleted: true, impact: await deleteSite(siteId, request.log) };
    return body;
  });

  /** Every location of a client, keeping the client itself. */
  app.delete('/admin/clients/:id/locations', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.project.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }
    const body: DeletionResponse = {
      deleted: true,
      impact: await deleteAllSitesOfProject(id, request.log),
    };
    return body;
  });
}

/**
 * The events a cylinder can carry and still count as "never touched".
 *
 * INTAKE is the booking-in. INITIALIZE is the first scan, which proves the printed
 * label is physically on the cylinder — it records that the cylinder was SEEN where it
 * already was, and moves nothing. Treating it as history would be a quiet disaster
 * now that initialization is mandatory before anything can move: every batch in a
 * usable state would carry it, so admins could never correct any batch that had got
 * past its first day. A correction is refused because a cylinder went somewhere, not
 * because somebody looked at it.
 */
const NO_HISTORY_TYPES: MovementType[] = ['INTAKE', 'INITIALIZE'];

/**
 * Proves every cylinder on a line is still exactly as it was booked in — at stores,
 * not returned, and carrying nothing but its INTAKE and INITIALIZE events. Anything
 * else means the line has a history, and history is not editable.
 */
async function assertLineUntouched(
  tx: Prisma.TransactionClient,
  lineId: string,
  what: string,
): Promise<void> {
  const moved = await tx.cylinder.count({
    where: {
      batchLineId: lineId,
      OR: [
        { status: { not: 'IN_STORES' } },
        { currentSiteId: { not: null } },
        { movementEvents: { some: { type: { notIn: NO_HISTORY_TYPES } } } },
      ],
    },
  });
  if (moved > 0) {
    throw new ImmutableHistoryError(
      'CYLINDERS_ALREADY_MOVED',
      `Cannot ${what}: ${moved} of its cylinders have already been transferred or returned. ` +
        `Their movement history is a record of where they physically went.`,
    );
  }
}

/** Resolve a gas/supplier pair the same way batch creation does. */
async function resolvePair(
  tx: Prisma.TransactionClient,
  gasTypeId: string,
  supplierId: string,
): Promise<{ gasType: { id: string; name: string; prefix: string }; supplierName: string }> {
  const gasType = await tx.gasType.findUnique({ where: { id: gasTypeId } });
  if (!gasType || !gasType.active) {
    throw new ImmutableHistoryError('INVALID_GAS_TYPE', 'Unknown or inactive gas type');
  }
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, active: true, gasTypes: { some: { gasTypeId } } },
  });
  if (!supplier) {
    throw new ImmutableHistoryError(
      'INVALID_SUPPLIER',
      `Unknown supplier, or not a supplier of ${gasType.name}`,
    );
  }
  return { gasType, supplierName: supplier.name };
}

interface LineEditCtx {
  tx: Prisma.TransactionClient;
  batchId: string;
  userId: string;
  year: number;
  changes: Change[];
}

type LineEdit = {
  id?: string;
  gasTypeId?: string;
  supplierId?: string;
  quantity?: number;
  initialDeliveryPoint?: string;
};

/**
 * Book `count` fresh cylinders onto a line, with their INTAKE events.
 *
 * Adding a cylinder to a batch that was already initialized also **un-initializes the
 * batch**. `Batch.initializedAt` means "every cylinder in this batch has had its
 * printed label scanned back off it", and these new ones have not — nobody has even
 * printed their labels yet. Leaving the flag set would let a cylinder that was never
 * physically seen ride out of the yard on a scan somebody did of a different cylinder
 * last week, which is precisely the hole initialization exists to close. So the batch
 * drops back to needing a fresh first scan, and the amendment says so.
 */
async function createCylinders(
  ctx: LineEditCtx,
  args: { lineId: string; gasTypeId: string; prefix: string; count: number },
): Promise<string[]> {
  const { tx, batchId, userId, year, changes } = ctx;
  const serials = await allocateSerials(tx, args.prefix, year, args.count);
  const rows = serials.map((serialCode) => ({
    id: randomUUID(),
    serialCode,
    batchId,
    batchLineId: args.lineId,
    gasTypeId: args.gasTypeId,
    status: 'IN_STORES' as const,
  }));
  await tx.cylinder.createMany({ data: rows });
  await tx.movementEvent.createMany({
    data: rows.map((c) => ({
      cylinderId: c.id,
      type: 'INTAKE' as const,
      userId,
      deviceAt: new Date(),
    })),
  });

  const cleared = await tx.batch.updateMany({
    where: { id: batchId, initializedAt: { not: null } },
    data: { initializedAt: null },
  });
  if (cleared.count > 0) {
    changes.push({
      field: 'Initialization',
      from: 'Initialized',
      to: 'Must be re-initialized — cylinders were added',
    });
  }
  return serials;
}

async function editLine(ctx: LineEditCtx, edit: LineEdit): Promise<void> {
  const { tx, changes } = ctx;
  const line = await tx.batchLine.findUnique({
    where: { id: edit.id! },
    include: { gasType: true },
  });
  if (!line || line.batchId !== ctx.batchId) {
    throw new ImmutableHistoryError('UNKNOWN_LINE', 'That line is not on this batch');
  }

  const label = line.gasType.name;

  // Paperwork: correctable whatever has happened to the cylinders.
  if (edit.supplierId && edit.supplierId !== line.supplierId) {
    const { supplierName } = await resolvePair(
      tx,
      edit.gasTypeId ?? line.gasTypeId,
      edit.supplierId,
    );
    await tx.batchLine.update({
      where: { id: line.id },
      data: { supplierId: edit.supplierId, supplierName },
    });
    changes.push({ field: `${label} supplier`, from: line.supplierName, to: supplierName });
  }
  if (edit.initialDeliveryPoint && edit.initialDeliveryPoint !== line.initialDeliveryPoint) {
    await tx.batchLine.update({
      where: { id: line.id },
      data: { initialDeliveryPoint: edit.initialDeliveryPoint },
    });
    changes.push({
      field: `${label} delivery point`,
      from: line.initialDeliveryPoint,
      to: edit.initialDeliveryPoint,
    });
  }

  // Gas: rewrites every serial on the line, because the prefix encodes the gas. Only
  // while nothing has moved — and the labels already printed become wrong, so the
  // caller is expected to re-send the QR sheet afterwards.
  if (edit.gasTypeId && edit.gasTypeId !== line.gasTypeId) {
    await assertLineUntouched(tx, line.id, `change the gas on the ${label} line`);
    const supplierId = edit.supplierId ?? line.supplierId;
    if (!supplierId) {
      throw new ImmutableHistoryError('INVALID_SUPPLIER', 'Choose a supplier for the new gas type');
    }
    const { gasType, supplierName } = await resolvePair(tx, edit.gasTypeId, supplierId);

    const existing = await tx.cylinder.findMany({
      where: { batchLineId: line.id },
      select: { id: true },
      orderBy: { serialCode: 'asc' },
    });
    const serials = await allocateSerials(tx, gasType.prefix, ctx.year, existing.length);
    for (const [i, cyl] of existing.entries()) {
      await tx.cylinder.update({
        where: { id: cyl.id },
        data: { serialCode: serials[i]!, gasTypeId: gasType.id },
      });
    }
    await tx.batchLine.update({
      where: { id: line.id },
      data: { gasTypeId: gasType.id, supplierId, supplierName },
    });
    changes.push({ field: 'Gas type', from: label, to: gasType.name });
    changes.push({
      field: 'Serials re-issued',
      from: `${existing.length} × ${label}`,
      to: serials.length > 0 ? `${serials[0]}–${serials[serials.length - 1]}` : '—',
    });
  }

  // Quantity: up allocates; down deletes, and only what has never moved.
  if (edit.quantity !== undefined && edit.quantity !== line.quantity) {
    const current = await tx.cylinder.count({ where: { batchLineId: line.id } });
    const gasTypeId = edit.gasTypeId ?? line.gasTypeId;
    const gasType = await tx.gasType.findUniqueOrThrow({ where: { id: gasTypeId } });

    if (edit.quantity > current) {
      await createCylinders(ctx, {
        lineId: line.id,
        gasTypeId,
        prefix: gasType.prefix,
        count: edit.quantity - current,
      });
    } else {
      // Drop from the end, and only cylinders with no history at all.
      const wanted = current - edit.quantity;
      const droppable = await tx.cylinder.findMany({
        where: {
          batchLineId: line.id,
          status: 'IN_STORES',
          currentSiteId: null,
          movementEvents: { every: { type: { in: NO_HISTORY_TYPES } } },
        },
        select: { id: true },
        orderBy: { serialCode: 'desc' },
        take: wanted,
      });
      if (droppable.length < wanted) {
        throw new ImmutableHistoryError(
          'CYLINDERS_ALREADY_MOVED',
          `Cannot reduce the ${label} line to ${edit.quantity}: only ${droppable.length} of its ` +
            `cylinders have never moved. The rest have a movement history.`,
        );
      }
      const ids = droppable.map((c) => c.id);
      await tx.movementEvent.deleteMany({ where: { cylinderId: { in: ids } } });
      await tx.cylinder.deleteMany({ where: { id: { in: ids } } });
    }

    await tx.batchLine.update({ where: { id: line.id }, data: { quantity: edit.quantity } });
    changes.push({
      field: `${label} quantity`,
      from: String(line.quantity),
      to: String(edit.quantity),
    });
  }
}

async function addLine(ctx: LineEditCtx, edit: LineEdit): Promise<void> {
  const { tx, changes } = ctx;
  if (!edit.gasTypeId || !edit.supplierId || !edit.quantity || !edit.initialDeliveryPoint) {
    throw new ImmutableHistoryError(
      'INCOMPLETE_LINE',
      'A new line needs a gas, a supplier, a quantity and a delivery point',
    );
  }
  const { gasType, supplierName } = await resolvePair(tx, edit.gasTypeId, edit.supplierId);

  const line = await tx.batchLine.create({
    data: {
      batchId: ctx.batchId,
      gasTypeId: gasType.id,
      supplierId: edit.supplierId,
      supplierName,
      quantity: edit.quantity,
      initialDeliveryPoint: edit.initialDeliveryPoint,
    },
  });
  await createCylinders(ctx, {
    lineId: line.id,
    gasTypeId: gasType.id,
    prefix: gasType.prefix,
    count: edit.quantity,
  });
  changes.push({
    field: 'Line added',
    from: '—',
    to: `${edit.quantity} × ${gasType.name} (${supplierName})`,
  });
}
