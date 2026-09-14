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
  type ClientOptionsResponse,
  type SuppliersResponse,
} from '@gct/shared';
import { prisma } from '../db.js';

type PmRow = { id: string; name: string; email: string; active: boolean };
type SiteRow = { id: string; clientId: string; location: string };
type ClientRow = { id: string; name: string; sites: SiteRow[] };
type ProjectRow = {
  id: string;
  projectNumber: string;
  status: 'ACTIVE' | 'CLOSED';
  projectManager: PmRow;
  client: ClientRow;
};

const toSiteDto = (s: SiteRow, clientName: string): SiteDto => ({
  id: s.id,
  clientId: s.clientId,
  clientName,
  location: s.location,
});

const toProjectDto = (p: ProjectRow, activeBatchCount: number): ProjectDto => ({
  id: p.id,
  projectNumber: p.projectNumber,
  status: p.status,
  clientId: p.client.id,
  clientName: p.client.name,
  projectManager: {
    id: p.projectManager.id,
    name: p.projectManager.name,
    email: p.projectManager.email,
    active: p.projectManager.active,
  },
  // The CLIENT's sites: every place this project can deliver to, not a private copy.
  sites: p.client.sites.map((site) => toSiteDto(site, p.client.name)),
  activeBatchCount,
});

/** The client + sites shape every project view needs. */
const clientInclude = { include: { sites: { orderBy: { location: 'asc' as const } } } } as const;

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
  /**
   * The client directory, for the batch form's Site and Location boxes.
   *
   * This used to be `SELECT DISTINCT ON ("name")` over the Site table — the best a
   * project-owned Site could do. It surfaced each spelling once and had no idea which
   * of them were the same customer, so "McCains" and "McCain's" were two sites and
   * nothing could group Durban and Cape Town under either. Now the grouping is the
   * data model, and this just reads it.
   */
  app.get('/clients', { preHandler: app.authenticate }, async () => {
    const rows = await prisma.client.findMany({
      where: { active: true },
      include: { sites: { orderBy: { location: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    const body: ClientOptionsResponse = {
      clients: rows.map((c) => ({
        id: c.id,
        name: c.name,
        sites: c.sites.map((s) => ({ id: s.id, location: s.location })),
      })),
    };
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
      include: { projectManager: true, client: clientInclude },
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
        clientId: r.client.id,
        clientName: r.client.name,
        siteCount: r.client.sites.length,
        activeBatchCount: counts.get(r.id) ?? 0,
      })),
    };
    return body;
  });

  app.get('/projects/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await prisma.project.findUnique({
      where: { id },
      include: { projectManager: true, client: clientInclude },
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

      // The client and the place arrive as TEXT, because the form's two boxes are
      // comboboxes: picking McCains from the directory and typing it because it is new
      // both have to work. Matched case-insensitively so "mccains" joins the existing
      // McCains rather than founding a second one — which is the whole failure the
      // directory exists to prevent.
      const { client, site } = await prisma.$transaction(async (tx) => {
        const existing = await tx.client.findFirst({
          where: { name: { equals: input.clientName, mode: 'insensitive' } },
        });
        const client = existing ?? (await tx.client.create({ data: { name: input.clientName } }));
        const site =
          (await tx.site.findFirst({
            where: {
              clientId: client.id,
              location: { equals: input.location, mode: 'insensitive' },
            },
          })) ??
          (await tx.site.create({ data: { clientId: client.id, location: input.location } }));
        return { client, site };
      });

      const project = await prisma.project.create({
        data: {
          projectNumber: input.projectNumber,
          projectManagerId: pm.id,
          clientId: client.id,
        },
        include: { projectManager: true, client: clientInclude },
      });

      const body: CreateProjectResponse = {
        project: toProjectDto(project, 0),
        // Which of the client's sites this project was started for, so the flow can
        // carry straight on to the batch without guessing when the client has three.
        siteId: site.id,
      };
      return reply.code(201).send(body);
    },
  );

  /**
   * Add a place to the client THIS PROJECT belongs to.
   *
   * A convenience over the route below, kept because "add a site to this project" is
   * how the yard says it and the project is what the flow has in hand. It resolves to
   * the client, so the new place is immediately available to every other job for the
   * same customer — which is the behaviour the old per-project sites could not give.
   */
  app.post(
    '/projects/:id/sites',
    { preHandler: app.requireRole('TECHNICIAN', 'ADMIN') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = createSiteRequestSchema.parse(request.body);

      const project = await prisma.project.findUnique({
        where: { id },
        include: { client: { select: { id: true, name: true } } },
      });
      if (!project) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }

      const existing = await prisma.site.findFirst({
        where: {
          clientId: project.client.id,
          location: { equals: input.location, mode: 'insensitive' },
        },
      });
      const site =
        existing ??
        (await prisma.site.create({
          data: { clientId: project.client.id, location: input.location },
        }));

      const body: CreateSiteResponse = { site: toSiteDto(site, project.client.name) };
      return reply.code(existing ? 200 : 201).send(body);
    },
  );

  /**
   * Add a place to a CLIENT.
   *
   * Addressed by client rather than by project now: a site belongs to the customer, so
   * adding Midrand to McCains makes it available to every McCains project at once
   * instead of to the one that happened to type it.
   */
  app.post(
    '/clients/:id/sites',
    { preHandler: app.requireRole('TECHNICIAN', 'ADMIN') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = createSiteRequestSchema.parse(request.body);

      const client = await prisma.client.findUnique({ where: { id } });
      if (!client) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
      }

      // Idempotent on the place: asking for a site the client already has is the same
      // end state, and the operator should not have to care that someone beat them.
      const existing = await prisma.site.findFirst({
        where: { clientId: id, location: { equals: input.location, mode: 'insensitive' } },
      });
      const site =
        existing ??
        (await prisma.site.create({ data: { clientId: id, location: input.location } }));

      const body: CreateSiteResponse = { site: toSiteDto(site, client.name) };
      return reply.code(existing ? 200 : 201).send(body);
    },
  );
}
