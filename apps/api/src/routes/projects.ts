import type { FastifyInstance } from 'fastify';
import {
  createProjectRequestSchema,
  createSiteRequestSchema,
  supplierListQuerySchema,
  type CreateProjectResponse,
  type CreateSiteResponse,
  type GasTypesResponse,
  type ProjectDetailResponse,
  type ProjectDto,
  type ProjectManagersResponse,
  type ProjectSearchResponse,
  type SiteDto,
  type SiteOptionsResponse,
  type SuppliersResponse,
} from '@gct/shared';
import { prisma } from '../db.js';

type PmRow = { id: string; name: string; email: string; active: boolean };
type SiteRow = { id: string; projectId: string; name: string; location: string };
type ProjectRow = {
  id: string;
  projectNumber: string;
  status: 'ACTIVE' | 'CLOSED';
  projectManager: PmRow;
  sites: SiteRow[];
};

const toSiteDto = (s: SiteRow): SiteDto => ({
  id: s.id,
  projectId: s.projectId,
  name: s.name,
  location: s.location,
});

const toProjectDto = (p: ProjectRow, activeBatchCount: number): ProjectDto => ({
  id: p.id,
  projectNumber: p.projectNumber,
  status: p.status,
  projectManager: {
    id: p.projectManager.id,
    name: p.projectManager.name,
    email: p.projectManager.email,
    active: p.projectManager.active,
  },
  sites: p.sites.map(toSiteDto),
  activeBatchCount,
});

async function activeBatchCounts(projectIds: string[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const grouped = await prisma.batch.groupBy({
    by: ['projectId'],
    where: { projectId: { in: projectIds }, status: { not: 'RETURNED' } },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.projectId, g._count._all]));
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/gas-types', { preHandler: app.authenticate }, async () => {
    const gasTypes = await prisma.gasType.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    const body: GasTypesResponse = {
      gasTypes: gasTypes.map((g) => ({
        id: g.id,
        name: g.name,
        prefix: g.prefix,
        active: g.active,
      })),
    };
    return body;
  });

  /**
   * The project-manager dropdown's options. Data-driven on purpose: adding a manager
   * is an INSERT, never a code change, so this endpoint returns whatever the table
   * holds rather than a list the client knows about.
   */
  app.get('/project-managers', { preHandler: app.authenticate }, async () => {
    // Active only. This list is what every picker offers, and offering a deactivated
    // manager would be offering an assignment the server then refuses. The admin
    // console has its own endpoint that returns the inactive ones too.
    const rows = await prisma.projectManager.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    const body: ProjectManagersResponse = {
      projectManagers: rows.map((pm) => ({
        id: pm.id,
        name: pm.name,
        email: pm.email,
        active: pm.active,
      })),
    };
    return body;
  });

  /**
   * Suppliers, optionally narrowed to the ones paired with a gas. The pairing lives in
   * GasSupplier, so which supplier goes with which gas is answered here and never
   * hardcoded in the form — the dependent dropdown is a query, not a switch.
   */
  app.get('/suppliers', { preHandler: app.authenticate }, async (request) => {
    const { gasTypeId } = supplierListQuerySchema.parse(request.query);
    const rows = await prisma.supplier.findMany({
      where: {
        active: true,
        ...(gasTypeId ? { gasTypes: { some: { gasTypeId } } } : {}),
      },
      orderBy: { name: 'asc' },
    });
    const body: SuppliersResponse = {
      suppliers: rows.map((s) => ({ id: s.id, name: s.name, active: s.active })),
    };
    return body;
  });

  /**
   * Options for the site combobox: every distinct site name on record, each with the
   * location most recently entered under it so choosing a known site can prefill.
   *
   * Deliberately NOT project-scoped. The combobox is offered while creating a project
   * that does not exist yet, and the operator is naming a place rather than picking a
   * foreign key — `Site` rows stay project-scoped underneath (see @@unique
   * [projectId, name]).
   */
  app.get('/sites', { preHandler: app.authenticate }, async () => {
    const rows = await prisma.$queryRaw<{ name: string; location: string }[]>`
      SELECT DISTINCT ON ("name") "name", "location"
      FROM "Site"
      ORDER BY "name" ASC, "createdAt" DESC
    `;
    const body: SiteOptionsResponse = { sites: rows };
    return body;
  });

  // Search by projectNumber OR project-manager name (Workflow B1 / C1).
  app.get('/projects', { preHandler: app.authenticate }, async (request) => {
    const q = (request.query as { q?: string }).q?.trim();
    const where = q
      ? {
          OR: [
            { projectNumber: { contains: q, mode: 'insensitive' as const } },
            { projectManager: { is: { name: { contains: q, mode: 'insensitive' as const } } } },
          ],
        }
      : {};

    const rows = await prisma.project.findMany({
      where,
      include: { projectManager: true, _count: { select: { sites: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const counts = await activeBatchCounts(rows.map((r) => r.id));

    const body: ProjectSearchResponse = {
      projects: rows.map((r) => ({
        id: r.id,
        projectNumber: r.projectNumber,
        status: r.status,
        projectManager: {
          id: r.projectManager.id,
          name: r.projectManager.name,
          email: r.projectManager.email,
          active: r.projectManager.active,
        },
        siteCount: r._count.sites,
        activeBatchCount: counts.get(r.id) ?? 0,
      })),
    };
    return body;
  });

  app.get('/projects/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await prisma.project.findUnique({
      where: { id },
      include: { projectManager: true, sites: { orderBy: { name: 'asc' } } },
    });
    if (!project) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    }
    const counts = await activeBatchCounts([id]);
    const body: ProjectDetailResponse = { project: toProjectDto(project, counts.get(id) ?? 0) };
    return body;
  });

  // Workflow A — "Create New Site": project + PM + first site.
  app.post(
    '/projects',
    { preHandler: app.requireRole('TECHNICIAN', 'ADMIN') },
    async (request, reply) => {
      const input = createProjectRequestSchema.parse(request.body);

      // The manager is picked from the stored list, so an unknown id is a client bug
      // or a stale form — not a reason to invent a ProjectManager row, which is what
      // the previous upsert-by-typed-email did.
      const pm = await prisma.projectManager.findUnique({
        where: { id: input.projectManagerId },
      });
      if (!pm || !pm.active) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_PROJECT_MANAGER',
            message: 'Unknown or deactivated project manager',
          },
        });
      }

      const project = await prisma.project.create({
        data: {
          projectNumber: input.projectNumber,
          projectManagerId: pm.id,
          sites: { create: { name: input.site.name, location: input.site.location } },
        },
        include: { projectManager: true, sites: true },
      });

      const body: CreateProjectResponse = { project: toProjectDto(project, 0) };
      return reply.code(201).send(body);
    },
  );

  // Workflow A — "Edit Existing Site": attach a new site to an existing project.
  app.post(
    '/projects/:id/sites',
    { preHandler: app.requireRole('TECHNICIAN', 'ADMIN') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = createSiteRequestSchema.parse(request.body);

      const project = await prisma.project.findUnique({ where: { id } });
      if (!project) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }

      const site = await prisma.site.create({
        data: { projectId: id, name: input.name, location: input.location },
      });
      const body: CreateSiteResponse = { site: toSiteDto(site) };
      return reply.code(201).send(body);
    },
  );
}
