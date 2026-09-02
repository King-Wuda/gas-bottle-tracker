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

export const siteDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  location: z.string(),
});
export type SiteDto = z.infer<typeof siteDtoSchema>;

/**
 * One entry in the site combobox. Distinct site *names* already in the Site table,
 * each carrying the location most recently recorded under that name so picking a
 * known site can prefill it. Not project-scoped: the combobox is offered before a
 * project exists, and the operator is naming a place, not choosing a foreign key.
 */
export const siteOptionSchema = z.object({
  name: z.string(),
  location: z.string(),
});
export type SiteOption = z.infer<typeof siteOptionSchema>;

export const siteOptionsResponseSchema = z.object({ sites: z.array(siteOptionSchema) });
export type SiteOptionsResponse = z.infer<typeof siteOptionsResponseSchema>;

/** Full project view — sites + a live active-batch count. */
export const projectDtoSchema = z.object({
  id: z.string(),
  projectNumber: z.string(),
  status: projectStatusSchema,
  projectManager: projectManagerDtoSchema,
  sites: z.array(siteDtoSchema),
  activeBatchCount: z.number().int().nonnegative(),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

/** Lightweight row for search results (Workflow B1 / C1). */
export const projectSummarySchema = z.object({
  id: z.string(),
  projectNumber: z.string(),
  status: projectStatusSchema,
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
  site: z.object({
    name: z.string().min(1).max(200),
    location: z.string().min(1).max(200),
  }),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const createProjectResponseSchema = z.object({ project: projectDtoSchema });
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

export const createSiteRequestSchema = z.object({
  name: z.string().min(1).max(200),
  location: z.string().min(1).max(200),
});
export type CreateSiteRequest = z.infer<typeof createSiteRequestSchema>;

export const createSiteResponseSchema = z.object({ site: siteDtoSchema });
export type CreateSiteResponse = z.infer<typeof createSiteResponseSchema>;
