import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  createClientRequestSchema,
  createGasTypeRequestSchema,
  createProjectManagerRequestSchema,
  createSupplierRequestSchema,
  createUserRequestSchema,
  gasSupplierPairingRequestSchema,
  serialYear,
  systemClock,
  updateBatchRequestSchema,
  updateClientRequestSchema,
  updateGasTypeRequestSchema,
  updateProjectManagerRequestSchema,
  updateSupplierRequestSchema,
  updateUserRequestSchema,
  type AdminClientDto,
  type AdminClientResponse,
  type AdminClientsResponse,
  type AdminGasTypeDto,
  type AdminGasTypeResponse,
  type AdminGasTypesResponse,
  type AdminProjectManagerDto,
  type AdminProjectsResponse,
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
  clientImpact,
  deleteAllSitesOfClient,
  deleteClient,
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

  /**
   * Delete a project manager.
   *
   * Same two outcomes as a user account, decided by the data rather than a setting. A
   * manager nobody has used is deleted outright. One with projects or batches is
   * tombstoned: the email is released for reuse and they disappear from every picker
   * and list, but their NAME stays, because `Batch.projectManagerId` is required and
   * every delivery note ever addressed to them answers "who was this delivered for?"
   * through it. Cascading would destroy that paperwork across every client they
   * handled — removing one person must not be a way to erase four customers' records.
   */
  app.delete('/admin/project-managers/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };

    const target = await prisma.projectManager.findUnique({
      where: { id },
      include: { _count: { select: { projects: true, batches: true, transfers: true } } },
    });
    if (!target || target.deletedAt) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Project manager not found' } });
    }

    const referenced = Object.values(target._count).reduce((n, c) => n + c, 0);

    if (referenced === 0) {
      await prisma.projectManager.delete({ where: { id } });
    } else {
      await prisma.projectManager.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          active: false,
          // Released so the address can be given to a new manager. The name is
          // deliberately untouched — it is what the paperwork is addressed to.
          email: `deleted+${id}@deleted.invalid`,
        },
      });
    }

    request.log.warn(
      { projectManagerId: id, name: target.name, referenced, purged: referenced === 0 },
      'admin deleted a project manager',
    );
    return { deleted: true, recordsKept: referenced };
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
      // A deleted manager survives only to give old paperwork a name; listing them
      // would invite someone to "reactivate" a record whose email is already gone.
      where: { deletedAt: null },
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
            const site = await tx.site.findUnique({
              where: { id: input.siteId },
              include: { client: { select: { name: true } } },
            });
            if (!site || site.clientId !== batch.site.clientId) {
              throw new ImmutableHistoryError(
                'INVALID_SITE',
                'Site does not belong to this batch’s client',
              );
            }
            await tx.batch.update({ where: { id }, data: { siteId: site.id } });
            // The place, not the client: a correction here moves the batch between one
            // customer's sites, so naming the customer twice would say nothing.
            changes.push({ field: 'Site', from: batch.site.location, to: site.location });
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
        // Both name and prefix are unique, and which one clashed is the useful half of
        // the message — the prefix especially, since two gases sharing it would issue
        // serials that collide on a physical label. `err.meta.target` does not survive
        // every driver, so the answer is read back from the table instead of guessed.
        const clash = await prisma.gasType.findUnique({ where: { prefix: input.prefix } });
        const field = clash ? 'prefix' : 'name';
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

  // ----------------------------------------------- the client directory

  /**
   * Clients and the places they take delivery at.
   *
   * This is reference data, and it is what the batch form's Site and Location boxes
   * read. It replaced a screen that listed PROJECTS and called them clients, which was
   * the honest reflection of a schema where a site belonged to a project: "Delmas"
   * under 4521 and "Delmas" under 4522 were unrelated rows, nothing could group them,
   * and a misspelling was invisible forever.
   *
   * Deleting from here is genuinely destructive — a client's projects and their whole
   * delivery history go with it — so every route has its `/impact` twin, as everywhere
   * else in this console.
   */
  const directoryInclude = {
    sites: {
      orderBy: { location: 'asc' as const },
      include: { _count: { select: { batches: true } } },
    },
    _count: { select: { projects: true } },
  } as const;

  type DirectoryRow = {
    id: string;
    name: string;
    active: boolean;
    createdAt: Date;
    sites: { id: string; location: string; _count: { batches: number } }[];
    _count: { projects: number };
  };

  const toClientDto = (c: DirectoryRow, batchCount: number): AdminClientDto => ({
    id: c.id,
    name: c.name,
    active: c.active,
    createdAt: c.createdAt.toISOString(),
    locations: c.sites.map((s) => ({
      id: s.id,
      location: s.location,
      batchCount: s._count.batches,
    })),
    projectCount: c._count.projects,
    batchCount,
  });

  /** Batches per client, in one grouped query rather than one per row. */
  const batchCountsByClient = async (clientIds: string[]): Promise<Map<string, number>> => {
    if (clientIds.length === 0) return new Map();
    const rows = await prisma.$queryRaw<{ clientId: string; count: bigint }[]>`
      SELECT p."clientId" AS "clientId", COUNT(b.*)::bigint AS count
      FROM "Project" p
      JOIN "Batch" b ON b."projectId" = p."id"
      WHERE p."clientId" = ANY(${clientIds})
      GROUP BY p."clientId"
    `;
    return new Map(rows.map((r) => [r.clientId, Number(r.count)]));
  };

  app.get('/admin/clients', adminOnly, async () => {
    const rows = await prisma.client.findMany({
      include: directoryInclude,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    const counts = await batchCountsByClient(rows.map((r) => r.id));
    const body: AdminClientsResponse = {
      clients: rows.map((c) => toClientDto(c, counts.get(c.id) ?? 0)),
    };
    return body;
  });

  /**
   * Add a client, optionally with its first location.
   *
   * A name that already exists is NOT an error — it is the common case. The screen
   * asks "add this location to the existing McCains?" and the caller comes back with
   * `attachToExisting`, which is what turns two people typing McCains into one client
   * with two sites instead of a duplicate. Refusing outright would leave them stuck;
   * silently merging would hide that they had matched someone else's customer.
   */
  app.post('/admin/clients', adminOnly, async (request, reply) => {
    const input = createClientRequestSchema.parse(request.body);

    const existing = await prisma.client.findFirst({
      where: { name: { equals: input.name, mode: 'insensitive' } },
      include: directoryInclude,
    });

    if (existing && !input.attachToExisting) {
      return reply.code(409).send({
        error: {
          code: 'CLIENT_EXISTS',
          message: `${existing.name} is already in the directory.`,
          // The screen needs these to phrase its question — which client, and what
          // they already have — without a second round trip.
          details: {
            clientId: existing.id,
            name: existing.name,
            locations: existing.sites.map((s) => s.location),
          },
        },
      });
    }

    const client = existing ?? (await prisma.client.create({ data: { name: input.name } }));
    if (input.location) {
      // Idempotent on the place: adding Durban twice is the same end state.
      const site = await prisma.site.findFirst({
        where: { clientId: client.id, location: { equals: input.location, mode: 'insensitive' } },
      });
      if (!site) {
        await prisma.site.create({ data: { clientId: client.id, location: input.location } });
      }
    }

    const fresh = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
      include: directoryInclude,
    });
    const counts = await batchCountsByClient([client.id]);
    const body: AdminClientResponse = { client: toClientDto(fresh, counts.get(client.id) ?? 0) };
    return reply.code(existing ? 200 : 201).send(body);
  });

  /** Rename, or retire from the pickers without touching a single delivery. */
  app.patch('/admin/clients/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateClientRequestSchema.parse(request.body);
    if (!(await prisma.client.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }
    try {
      await prisma.client.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({
          error: { code: 'CLIENT_EXISTS', message: 'Another client already has that name.' },
        });
      }
      throw err;
    }
    const fresh = await prisma.client.findUniqueOrThrow({
      where: { id },
      include: directoryInclude,
    });
    const counts = await batchCountsByClient([id]);
    const body: AdminClientResponse = { client: toClientDto(fresh, counts.get(id) ?? 0) };
    return body;
  });

  app.get('/admin/clients/:id/impact', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.client.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }
    const body: DeletionImpactResponse = { impact: await clientImpact(id) };
    return body;
  });

  /** The client, every job for them, and every place they take delivery at. */
  app.delete('/admin/clients/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.client.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }
    const body: DeletionResponse = { deleted: true, impact: await deleteClient(id, request.log) };
    return body;
  });

  app.get('/admin/clients/:id/locations/:siteId/impact', adminOnly, async (request, reply) => {
    const { id, siteId } = request.params as { id: string; siteId: string };
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site || site.clientId !== id) {
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
    if (!site || site.clientId !== id) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Location not found' } });
    }
    const body: DeletionResponse = { deleted: true, impact: await deleteSite(siteId, request.log) };
    return body;
  });

  /** Every location of a client, keeping the client itself. */
  app.delete('/admin/clients/:id/locations', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.client.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }
    const body: DeletionResponse = {
      deleted: true,
      impact: await deleteAllSitesOfClient(id, request.log),
    };
    return body;
  });

  // ------------------------------------------------------------- projects

  /**
   * Jobs, and deleting one along with its deliveries.
   *
   * Separate from the directory on purpose. A client and its locations are reference
   * data an admin edits without consequence; a project carries batches, signed
   * delivery notes and the movement log, and deleting one destroys them. Putting the
   * two controls on one screen would sit the irreversible action next to the routine
   * one and rely on the label to keep them apart.
   */
  app.get('/admin/projects', adminOnly, async () => {
    const rows = await prisma.project.findMany({
      include: {
        client: { select: { id: true, name: true } },
        projectManager: { select: { name: true } },
        _count: { select: { batches: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const body: AdminProjectsResponse = {
      projects: rows.map((p) => ({
        id: p.id,
        projectNumber: p.projectNumber,
        status: p.status,
        clientId: p.client.id,
        clientName: p.client.name,
        projectManagerName: p.projectManager.name,
        batchCount: p._count.batches,
        createdAt: p.createdAt.toISOString(),
      })),
    };
    return body;
  });

  app.get('/admin/projects/:id/impact', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.project.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    }
    const body: DeletionImpactResponse = { impact: await projectImpact(id) };
    return body;
  });

  app.delete('/admin/projects/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await prisma.project.findUnique({ where: { id } }))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    }
    const body: DeletionResponse = { deleted: true, impact: await deleteProject(id, request.log) };
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
