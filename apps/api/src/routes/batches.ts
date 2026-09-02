import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  batchListQuerySchema,
  createBatchRequestSchema,
  serialYear,
  summariseLines,
  systemClock,
  RESEND_LOCKOUT_SECONDS,
  type BatchDetailResponse,
  type BatchDto,
  type BatchListResponse,
  type CreateBatchResponse,
  type ResendBatchEmailResponse,
} from '@gct/shared';
import { prisma, Prisma } from '../db.js';
import { env } from '../env.js';
import { allocateSerials } from '../services/serial.js';
import {
  batchInclude,
  batchRelations,
  distributionFor,
  iso,
  loadBatchDto,
  toBatchBase,
  toBatchDto,
  type BatchCoreRow,
  type CylinderRow,
} from '../services/batchView.js';

type BatchRow = BatchCoreRow & { cylinders: CylinderRow[] };

/** A field list is scrolled, not paged; this caps the payload without paginating. */
const LIST_LIMIT = 200;

/** Seconds still to run on the resend lock, floored at 0. */
export function resendRetryAfter(lastSentAt: Date | null, now: Date = new Date()): number {
  if (!lastSentAt) return 0;
  const elapsedMs = now.getTime() - lastSentAt.getTime();
  return Math.max(0, Math.ceil((RESEND_LOCKOUT_SECONDS * 1000 - elapsedMs) / 1000));
}

/**
 * The QR-sheet mail for one batch, shared by the create path and the resend path.
 *
 * One sheet covers the whole delivery, however many gases it holds — the labels are
 * printed and stuck on in one pass at the depot, so splitting the mail per gas would
 * hand the same person three attachments for one truck.
 */
export function qrSheetEmail(args: {
  to: string;
  batchId: string;
  projectNumber: string;
  siteName: string;
  lines: { quantity: number; gasTypeName: string }[];
  serials: string[];
  resend: boolean;
}) {
  const { serials } = args;
  const range = serials.length > 0 ? `Serials ${serials[0]}–${serials[serials.length - 1]}.\n` : '';
  const contents = summariseLines(args.lines);
  const total = args.lines.reduce((n, l) => n + l.quantity, 0);
  return {
    to: args.to,
    type: 'QR_SHEET' as const,
    subject:
      `${args.resend ? '[Resent] ' : ''}QR codes for batch ${args.batchId} — ` +
      `project ${args.projectNumber}`,
    bodyText:
      `${total} cylinder(s) logged for site "${args.siteName}": ${contents}.\n` +
      range +
      `The attached sheet has one label per cylinder, each printed with the batch's ` +
      `details for physical tagging.`,
    payload: { batchId: args.batchId },
  };
}

export async function batchRoutes(app: FastifyInstance): Promise<void> {
  /** The response for an already-created batch — used by both replay paths. */
  const replayBody = async (batch: BatchRow): Promise<CreateBatchResponse> => {
    const dist = await distributionFor([batch.id]);
    const dto = toBatchDto(batch, dist.get(batch.id) ?? []);
    return { batch: dto, serials: dto.cylinders.map((c) => c.serialCode) };
  };

  const findByRequestId = (clientRequestId: string) =>
    prisma.batch.findUnique({ where: { clientRequestId }, include: batchInclude });

  // Workflow A steps 3–5 (server side): allocate serials for every line, create the
  // cylinders, queue the PM QR email. ONE batch, however many gases it carries.
  app.post(
    '/batches',
    { preHandler: app.requireRole('TECHNICIAN', 'ADMIN') },
    async (request, reply) => {
      const input = createBatchRequestSchema.parse(request.body);

      // Idempotent replay — return the original batch unchanged.
      const existing = await findByRequestId(input.clientRequestId);
      if (existing) return reply.code(200).send(await replayBody(existing));

      // --- validation (all of it before a single serial is allocated) ---
      const project = await prisma.project.findUnique({
        where: { id: input.projectId },
        include: { projectManager: true },
      });
      if (!project) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }
      const site = await prisma.site.findUnique({ where: { id: input.siteId } });
      if (!site || site.projectId !== project.id) {
        return reply.code(400).send({
          error: { code: 'INVALID_SITE', message: 'Site does not belong to this project' },
        });
      }

      // The addressee: whoever was picked, else the project's own manager. An
      // explicitly chosen manager must still be one that can take new work.
      let manager = project.projectManager;
      if (input.projectManagerId && input.projectManagerId !== manager.id) {
        const picked = await prisma.projectManager.findUnique({
          where: { id: input.projectManagerId },
        });
        if (!picked || !picked.active) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_PROJECT_MANAGER',
              message: 'Unknown or deactivated project manager',
            },
          });
        }
        manager = picked;
      } else if (!manager.active) {
        return reply.code(400).send({
          error: {
            code: 'INACTIVE_PROJECT_MANAGER',
            message:
              'This project’s manager has been deactivated. Choose another manager for this batch.',
          },
        });
      }

      // Resolve every line up front. A batch is written whole or not at all, so a bad
      // supplier on line 3 must not leave lines 1 and 2 created with serials burned.
      const gasTypeIds = [...new Set(input.lines.map((l) => l.gasTypeId))];
      const gasTypes = await prisma.gasType.findMany({ where: { id: { in: gasTypeIds } } });
      const gasById = new Map(gasTypes.map((g) => [g.id, g]));

      const suppliers = await prisma.supplier.findMany({
        where: {
          id: { in: [...new Set(input.lines.map((l) => l.supplierId))] },
          active: true,
        },
        include: { gasTypes: { select: { gasTypeId: true } } },
      });
      const supplierById = new Map(suppliers.map((s) => [s.id, s]));

      const resolved: {
        gasTypeId: string;
        prefix: string;
        gasTypeName: string;
        supplierId: string;
        supplierName: string;
        quantity: number;
        initialDeliveryPoint: string;
      }[] = [];

      for (const line of input.lines) {
        const gasType = gasById.get(line.gasTypeId);
        if (!gasType || !gasType.active) {
          return reply
            .code(400)
            .send({ error: { code: 'INVALID_GAS_TYPE', message: 'Unknown or inactive gas type' } });
        }
        // The supplier must be one actually paired with this gas. The dependent
        // dropdown enforces it on screen; a stale form or a direct API call would not,
        // and a supplier who does not stock the gas is a real-world ordering error.
        const supplier = supplierById.get(line.supplierId);
        if (!supplier || !supplier.gasTypes.some((g) => g.gasTypeId === gasType.id)) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_SUPPLIER',
              message: `Unknown supplier, or not a supplier of ${gasType.name}`,
            },
          });
        }
        resolved.push({
          gasTypeId: gasType.id,
          prefix: gasType.prefix,
          gasTypeName: gasType.name,
          supplierId: supplier.id,
          supplierName: supplier.name,
          quantity: line.quantity,
          initialDeliveryPoint: line.initialDeliveryPoint,
        });
      }

      const userId = request.user.sub;
      const year = serialYear(systemClock, env().SERIAL_YEAR_TZ);
      const deviceAt = new Date();

      let created: { batchId: string; serials: string[] };
      try {
        created = await prisma.$transaction(
          async (tx) => {
            const batch = await tx.batch.create({
              data: {
                projectId: project.id,
                siteId: site.id,
                projectManagerId: manager.id,
                // Snapshot, not a live read: this is the address the sheet went to.
                projectManagerEmail: manager.email,
                createdByUserId: userId,
                clientRequestId: input.clientRequestId,
                status: 'ACTIVE',
                // The confirmation screen opens with the resend control already
                // locked, so the first send starts the 60s window like any other.
                emailSentAt: new Date(),
                lastEmailSentAt: new Date(),
              },
            });

            // Everything above is batch-local. From here to COMMIT we hold a
            // SerialSequence row lock per gas, so keep it to the writes that need it:
            // cylinder ids are generated here rather than read back, which removes a
            // findMany round trip from inside the lock window.
            //
            // Lines are processed in a stable order (as submitted, after resolving),
            // so two concurrent multi-gas batches take the per-gas locks in the same
            // sequence and cannot deadlock by grabbing nitrogen and argon in
            // opposite orders.
            const ordered = [...resolved].sort((a, b) => a.prefix.localeCompare(b.prefix));
            const allSerials: string[] = [];
            const allCylinders: {
              id: string;
              serialCode: string;
              batchId: string;
              batchLineId: string;
              gasTypeId: string;
              status: 'IN_STORES';
            }[] = [];

            for (const line of ordered) {
              const batchLine = await tx.batchLine.create({
                data: {
                  batchId: batch.id,
                  gasTypeId: line.gasTypeId,
                  supplierId: line.supplierId,
                  supplierName: line.supplierName,
                  quantity: line.quantity,
                  initialDeliveryPoint: line.initialDeliveryPoint,
                },
              });
              const serials = await allocateSerials(tx, line.prefix, year, line.quantity);
              allSerials.push(...serials);
              for (const serialCode of serials) {
                allCylinders.push({
                  id: randomUUID(),
                  serialCode,
                  batchId: batch.id,
                  batchLineId: batchLine.id,
                  gasTypeId: line.gasTypeId,
                  status: 'IN_STORES',
                });
              }
            }

            await tx.cylinder.createMany({ data: allCylinders });
            await tx.movementEvent.createMany({
              data: allCylinders.map((c) => ({
                cylinderId: c.id,
                type: 'INTAKE' as const,
                userId,
                deviceAt,
              })),
            });
            await tx.outboundEmail.create({
              data: qrSheetEmail({
                to: manager.email,
                batchId: batch.id,
                projectNumber: project.projectNumber,
                siteName: site.name,
                lines: resolved,
                serials: allSerials,
                resend: false,
              }),
            });

            return { batchId: batch.id, serials: allSerials };
          },
          // The default 5s interactive-transaction budget is not enough for the
          // largest permitted batch (500 cylinders) under concurrency, because every
          // batch for the same gas type serialises on that gas's SerialSequence row.
          { timeout: 30_000, maxWait: 15_000 },
        );
      } catch (err) {
        // Two identical clientRequestIds racing: both passed the findUnique above,
        // one lost the unique index. It is a replay, not a conflict — return the
        // batch the winner created. (No serials are burned: batch.create fails
        // before allocateSerials runs.)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const winner = await findByRequestId(input.clientRequestId);
          if (winner) return reply.code(200).send(await replayBody(winner));
        }
        throw err;
      }

      const dto = await loadBatchDto(created.batchId);
      const body: CreateBatchResponse = {
        batch: dto as BatchDto,
        serials: dto?.cylinders.map((c) => c.serialCode) ?? created.serials,
      };
      return reply.code(201).send(body);
    },
  );

  /**
   * The one list behind the Transfer, Returns and History tabs.
   *
   * `scope` used to hide rows by movement history — Transfer dropped anything already
   * transferred, Returns anything already returned, each behind an opt-in toggle. That
   * model assumed a batch moves once, all at once. It does not: 3 of 7 nitrogen can go
   * to site while 4 stay at stores, and the 4 still have to be transferable. So the
   * toggles are gone and scope no longer excludes by `transferredAt` / `returnedAt` —
   * only `status` narrows, and only to drop batches with nothing left to act on.
   */
  app.get('/batches', { preHandler: app.authenticate }, async (request) => {
    // Parsed, not read raw: a typo'd `status` used to fall through to the `active`
    // branch and silently answer a different question than the one asked.
    const query = batchListQuerySchema.parse(request.query);
    const { projectId, status, q, scope } = query;

    const base: Prisma.BatchWhereInput = {};
    if (projectId) base.projectId = projectId;
    if (status === 'active') base.status = { not: 'RETURNED' };
    // status === 'all' -> no status filter

    // Scope filters by INITIALIZATION, and by nothing else.
    //
    // It deliberately does not hide anything for having moved: 3 of 7 nitrogen going
    // to site leaves 4 that still have to be transferable, so a batch that has moved
    // stays listed as many times as it takes. Initialization is a different kind of
    // fact — an uninitialized batch has no labels on its cylinders yet, so Transfer
    // and Returns would be offering an action the server will refuse (409), and
    // Initialize exists to show exactly those batches and nothing else.
    if (scope === 'transfer' || scope === 'returns') base.initializedAt = { not: null };
    if (scope === 'initialize') base.initializedAt = null;

    const search = q?.trim();
    const filters: Prisma.BatchWhereInput = {};
    if (search) {
      // Project number OR project manager name, substring, case-insensitive — the two
      // things printed on the paperwork someone is holding.
      filters.OR = [
        { project: { is: { projectNumber: { contains: search, mode: 'insensitive' } } } },
        { projectManager: { is: { name: { contains: search, mode: 'insensitive' } } } },
      ];
    }
    // Gas and supplier now live on the lines, so these ask "does any line match?".
    if (query.projectManagerId) filters.projectManagerId = query.projectManagerId;
    if (query.supplierId) filters.lines = { some: { supplierId: query.supplierId } };
    if (query.gasTypeId) {
      filters.lines = filters.lines
        ? { some: { supplierId: query.supplierId, gasTypeId: query.gasTypeId } }
        : { some: { gasTypeId: query.gasTypeId } };
    }

    const where: Prisma.BatchWhereInput = { AND: [base, filters] };

    const [rows, matched, total] = await Promise.all([
      prisma.batch.findMany({
        where,
        include: { ...batchRelations, _count: { select: { cylinders: true } } },
        // Newest first, in the database — so the ordering survives filtering and the
        // cap below drops the oldest rows rather than an arbitrary slice.
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      prisma.batch.count({ where }),
      // "12 of 48": the denominator is everything this tab could show unfiltered.
      prisma.batch.count({ where: base }),
    ]);

    const ids = rows.map((r) => r.id);
    const [returnedCounts, distributions] = await Promise.all([
      prisma.cylinder.groupBy({
        by: ['batchId'],
        where: { batchId: { in: ids }, status: 'RETURNED' },
        _count: { _all: true },
      }),
      distributionFor(ids),
    ]);
    const returnedByBatch = new Map(returnedCounts.map((g) => [g.batchId, g._count._all]));

    const body: BatchListResponse = {
      batches: rows.map((r) => ({
        ...toBatchBase(r, distributions.get(r.id) ?? []),
        cylinderCount: r._count.cylinders,
        returnedCount: returnedByBatch.get(r.id) ?? 0,
      })),
      matched,
      total,
    };
    return body;
  });

  app.get('/batches/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const batch = await loadBatchDto(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
    }
    const body: BatchDetailResponse = { batch };
    return body;
  });

  /**
   * Re-queue the batch's QR sheet, at most once every RESEND_LOCKOUT_SECONDS.
   *
   * The lock is enforced here, in the UPDATE's WHERE clause, not by the countdown on
   * screen: the screen's timer is derived from `lastEmailSentAt` so a refresh cannot
   * shorten it, but a second device — or curl — never ran that timer at all. Claiming
   * the window with `WHERE lastEmailSentAt <= now() - 60s` means two simultaneous taps
   * produce one mail, because the loser matches zero rows instead of re-reading a
   * value the winner has already moved.
   */
  app.post(
    '/batches/:id/resend-email',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const batch = await prisma.batch.findUnique({
        where: { id },
        include: { ...batchRelations, cylinders: { select: { serialCode: true } } },
      });
      if (!batch) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
      }

      const serials = batch.cylinders
        .map((c) => c.serialCode)
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

      const claimed = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          { resendCount: number; emailSentAt: Date | null; lastEmailSentAt: Date }[]
        >`
        UPDATE "Batch"
        SET "lastEmailSentAt" = now(),
            "emailSentAt"     = COALESCE("emailSentAt", now()),
            "resendCount"     = "resendCount" + 1,
            "updatedAt"       = now()
        WHERE "id" = ${id}
          AND (
            "lastEmailSentAt" IS NULL
            OR "lastEmailSentAt" <= now() - (${RESEND_LOCKOUT_SECONDS} * interval '1 second')
          )
        RETURNING "resendCount", "emailSentAt", "lastEmailSentAt"
      `;
        if (rows.length === 0) return null;

        await tx.outboundEmail.create({
          data: qrSheetEmail({
            // The snapshot, not the manager's current address: a resend must reproduce
            // the original delivery, not silently redirect it somewhere new.
            to: batch.projectManagerEmail,
            batchId: batch.id,
            projectNumber: batch.project.projectNumber,
            siteName: batch.site.name,
            lines: batch.lines.map((l) => ({
              quantity: l.quantity,
              gasTypeName: l.gasType.name,
            })),
            serials,
            resend: true,
          }),
        });
        return rows[0]!;
      });

      if (!claimed) {
        // Lost the window. Re-read so the client's countdown is corrected to the
        // server's clock rather than to whatever its own was drifting towards.
        const fresh = await prisma.batch.findUniqueOrThrow({
          where: { id },
          select: { emailSentAt: true, lastEmailSentAt: true, resendCount: true },
        });
        const retryAfterSeconds = resendRetryAfter(fresh.lastEmailSentAt);
        return reply
          .code(429)
          .header('retry-after', String(retryAfterSeconds))
          .send({
            error: {
              code: 'RESEND_TOO_SOON',
              message: `Resend is available again in ${retryAfterSeconds}s.`,
              details: {
                batchId: id,
                emailSentAt: iso(fresh.emailSentAt),
                lastEmailSentAt: iso(fresh.lastEmailSentAt),
                resendCount: fresh.resendCount,
                retryAfterSeconds,
              },
            },
          });
      }

      const body: ResendBatchEmailResponse = {
        batchId: id,
        emailSentAt: iso(claimed.emailSentAt),
        lastEmailSentAt: iso(claimed.lastEmailSentAt),
        resendCount: claimed.resendCount,
        retryAfterSeconds: resendRetryAfter(claimed.lastEmailSentAt),
      };
      return reply.code(202).send(body);
    },
  );
}
