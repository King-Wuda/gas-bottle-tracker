import { z } from 'zod';
import { PROJECT_NUMBER_ERROR, PROJECT_NUMBER_REGEX } from '../projectNumber';

export const projectStatusSchema = z.enum(['ACTIVE', 'CLOSED']);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/** `######-###-#-##`. Server-side twin of the on-device mask — see ../projectNumber. */
export const projectNumberSchema = z.string().regex(PROJECT_NUMBER_REGEX, PROJECT_NUMBER_ERROR);

export const gasTypeDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  active: z.boolean(),
});
export type GasTypeDto = z.infer<typeof gasTypeDtoSchema>;

export const gasTypesResponseSchema = z.object({ gasTypes: z.array(gasTypeDtoSchema) });
export type GasTypesResponse = z.infer<typeof gasTypesResponseSchema>;

/** A supplier the operator can pick. Which ones apply depends on the gas — the
 *  pairing lives in the GasSupplier join table, never in the client. */
export const supplierDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export type SupplierDto = z.infer<typeof supplierDtoSchema>;

export const suppliersResponseSchema = z.object({ suppliers: z.array(supplierDtoSchema) });
export type SuppliersResponse = z.infer<typeof suppliersResponseSchema>;

/** `GET /suppliers?gasTypeId=` — omitting the gas returns every active supplier. */
export const supplierListQuerySchema = z.object({ gasTypeId: z.string().min(1).optional() });
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;

export const projectManagerDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  /** Deactivated managers stay resolvable — a batch still names the one it was
   *  addressed to — but drop out of the pickers that assign new work. */
  active: z.boolean(),
});
export type ProjectManagerDto = z.infer<typeof projectManagerDtoSchema>;

export const projectManagersResponseSchema = z.object({
  projectManagers: z.array(projectManagerDtoSchema),
});
export type ProjectManagersResponse = z.infer<typeof projectManagersResponseSchema>;

/**
 * One place a client takes delivery at.
 *
 * A site belongs to the CLIENT, not to a project — McCains has Durban, Cape Town and
 * Midrand, and every project for McCains delivers to those same rows. `location` is
 * the place; the name of the client is carried by the client.
 */
export const siteDtoSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  location: z.string(),
});
export type SiteDto = z.infer<typeof siteDtoSchema>;

/**
 * The client directory, as the batch form's two boxes consume it.
 *
 * The form asks for a Site and a Location, and those are the client and the place:
 * "McCains" then "Durban". So one entry per CLIENT, carrying the places they take
 * delivery at — type into the first box to narrow the clients, and the second box
 * offers only that client's sites.
 *
 * This replaced a `SELECT DISTINCT ON (name)` over the Site table, which was the best
 * a project-owned Site could manage: it surfaced each spelling once and had no idea
 * which of them were the same customer.
 */
export const clientOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  sites: z.array(z.object({ id: z.string(), location: z.string() })),
});
export type ClientOption = z.infer<typeof clientOptionSchema>;

export const clientOptionsResponseSchema = z.object({ clients: z.array(clientOptionSchema) });
export type ClientOptionsResponse = z.infer<typeof clientOptionsResponseSchema>;

/** Full project view — sites + a live active-batch count. */
export const projectDtoSchema = z.object({
  id: z.string(),
  projectNumber: z.string(),
  status: projectStatusSchema,
  clientId: z.string(),
  clientName: z.string(),
  projectManager: projectManagerDtoSchema,
  /** The CLIENT's sites — every place this project can deliver to. */
  sites: z.array(siteDtoSchema),
  activeBatchCount: z.number().int().nonnegative(),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

/** Lightweight row for search results (Workflow B1 / C1). */
export const projectSummarySchema = z.object({
  id: z.string(),
  projectNumber: z.string(),
  status: projectStatusSchema,
  clientId: z.string(),
  clientName: z.string(),
  projectManager: projectManagerDtoSchema,
  siteCount: z.number().int().nonnegative(),
  activeBatchCount: z.number().int().nonnegative(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectSearchResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});
export type ProjectSearchResponse = z.infer<typeof projectSearchResponseSchema>;

export const projectDetailResponseSchema = z.object({ project: projectDtoSchema });
export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;

/**
 * The project manager is chosen by id from the stored list, not typed. A copied name
 * and email cannot be trusted to identify anyone — the id can, and it is what the
 * batch snapshots its notification address from.
 */
export const createProjectRequestSchema = z.object({
  projectNumber: projectNumberSchema,
  projectManagerId: z.string().min(1),
  /**
   * The client and the place, exactly as the form's two boxes collect them.
   *
   * Sent as TEXT rather than as ids, because the boxes are comboboxes: picking
   * "McCains" from the directory and typing it because it is new must both work, and
   * the operator standing in a yard should not be blocked by a client nobody has
   * registered yet. The server matches an existing client case-insensitively and
   * creates one only when there is no match, so the directory grows by being used
   * without ever growing a second McCains.
   */
  clientName: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(200),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const createProjectResponseSchema = z.object({
  project: projectDtoSchema,
  /** The client site this project was started for — the flow's next step needs it. */
  siteId: z.string(),
});
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

/** Add a place to a client. The client is named by the route, so only the place here. */
export const createSiteRequestSchema = z.object({
  location: z.string().trim().min(1).max(200),
});
export type CreateSiteRequest = z.infer<typeof createSiteRequestSchema>;

export const createSiteResponseSchema = z.object({ site: siteDtoSchema });
export type CreateSiteResponse = z.infer<typeof createSiteResponseSchema>;
