import type {
  AdminProjectManagerResponse,
  AdminProjectManagersResponse,
  AdminUserResponse,
  AdminUsersResponse,
  BatchAmendmentsResponse,
  BatchDetailResponse,
  BatchEventDetailResponse,
  BatchHistoryResponse,
  BatchPhotoImageResponse,
  BatchListQuery,
  BatchListResponse,
  CylinderHistoryResponse,
  CreateBatchRequest,
  CreateBatchResponse,
  CreateInitializationRequest,
  CreateInitializationResponse,
  CreateProjectManagerRequest,
  CreateReturnRequest,
  CreateReturnResponse,
  CreateTransferRequest,
  CreateTransferResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateSiteRequest,
  CreateSiteResponse,
  CreateUserRequest,
  GasTypesResponse,
  HistoryFeedQuery,
  HistoryFeedResponse,
  LoginResponse,
  MeResponse,
  ProjectDetailResponse,
  ProjectManagersResponse,
  ProjectSearchResponse,
  ReadDriverIdRequest,
  ReadDriverIdResponse,
  RefreshResponse,
  ResendBatchEmailResponse,
  SiteOptionsResponse,
  SuppliersResponse,
  UpdateBatchRequest,
  UpdateProjectManagerRequest,
  UpdateUserRequest,
} from '@gct/shared';
import { API_URL, configNote } from '../config';
import { loadTokens, saveTokens, clearTokens, type StoredTokens } from '../auth/tokenStore';

// Printed once, at module load. A build carrying an address that cannot work from
// this browser is worth saying plainly — see `resolveApiUrl` in config.ts.
if (configNote) console.info(`[gct] ${configNote}`);

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let tokens: StoredTokens | null = null;
let hydrated = false;
let refreshInFlight: Promise<StoredTokens | null> | null = null;
const authLostListeners = new Set<() => void>();

export function onAuthLost(cb: () => void): () => void {
  authLostListeners.add(cb);
  return () => authLostListeners.delete(cb);
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  tokens = await loadTokens();
  hydrated = true;
}

export async function setSession(next: StoredTokens | null): Promise<void> {
  tokens = next;
  hydrated = true;
  if (next) await saveTokens(next);
  else await clearTokens();
}

export async function getSession(): Promise<StoredTokens | null> {
  await hydrate();
  return tokens;
}

async function doRefresh(): Promise<StoredTokens | null> {
  if (!tokens?.refreshToken) return null;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as RefreshResponse;
    const next: StoredTokens = { accessToken: body.accessToken, refreshToken: body.refreshToken };
    await setSession(next);
    return next;
  } catch {
    // Network failure mid-refresh: report "could not refresh" rather than rejecting,
    // so the caller still surfaces a typed ApiError instead of a raw TypeError.
    return null;
  }
}

/** Single-flight refresh — concurrent 401s share one refresh call. */
function refreshOnce(): Promise<StoredTokens | null> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skip the Authorization header (login/refresh). */
  anonymous?: boolean;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  await hydrate();

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    // ONLY when there is actually a body. Declaring `application/json` on a request
    // that carries nothing is what Fastify rejects with "Body cannot be empty when
    // content-type is set to 'application/json'" — which is how the Resend email
    // button failed, and how every future body-less POST would have failed too. A
    // request with no body has no content type to declare.
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (!opts.anonymous && tokens?.accessToken) {
      headers.authorization = `Bearer ${tokens.accessToken}`;
    }
    return fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };

  let res = await send();

  if (res.status === 401 && !opts.anonymous && tokens?.refreshToken) {
    const refreshed = await refreshOnce();
    if (refreshed) {
      res = await send();
    } else {
      await setSession(null);
      authLostListeners.forEach((cb) => cb());
    }
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  // Never let a non-JSON body (an HTML sign-in page from a forwarded port, a proxy
  // 502) throw a raw SyntaxError past the !res.ok branch below.
  let json: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const err = json?.error ?? {};
    if (res.status === 401) {
      await setSession(null);
      authLostListeners.forEach((cb) => cb());
    }
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? res.statusText, err.details);
  }

  return json as T;
}

// ---- typed endpoints ----

export function apiLogin(email: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
    anonymous: true,
  });
}

export function apiMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>('/me');
}

export async function apiLogout(): Promise<void> {
  const session = await getSession();
  if (session?.refreshToken) {
    try {
      await apiRequest<void>('/auth/logout', {
        method: 'POST',
        body: { refreshToken: session.refreshToken },
        anonymous: true,
      });
    } catch {
      // best effort — clear locally regardless
    }
  }
  await setSession(null);
}

// ---- Workflow A (New) ----

export function apiGasTypes(): Promise<GasTypesResponse> {
  return apiRequest<GasTypesResponse>('/gas-types');
}

/** Options for the project-manager dropdown. */
export function apiProjectManagers(): Promise<ProjectManagersResponse> {
  return apiRequest<ProjectManagersResponse>('/project-managers');
}

/** Suppliers for one gas — the dependent half of the gas/supplier pair. */
export function apiSuppliers(gasTypeId?: string): Promise<SuppliersResponse> {
  const qs = gasTypeId ? `?gasTypeId=${encodeURIComponent(gasTypeId)}` : '';
  return apiRequest<SuppliersResponse>(`/suppliers${qs}`);
}

/** Every distinct site name on record — the combobox's list. */
export function apiSiteOptions(): Promise<SiteOptionsResponse> {
  return apiRequest<SiteOptionsResponse>('/sites');
}

export function apiSearchProjects(q: string): Promise<ProjectSearchResponse> {
  return apiRequest<ProjectSearchResponse>(`/projects?q=${encodeURIComponent(q)}`);
}

export function apiGetProject(id: string): Promise<ProjectDetailResponse> {
  return apiRequest<ProjectDetailResponse>(`/projects/${id}`);
}

export function apiCreateProject(body: CreateProjectRequest): Promise<CreateProjectResponse> {
  return apiRequest<CreateProjectResponse>('/projects', { method: 'POST', body });
}

export function apiCreateSite(
  projectId: string,
  body: CreateSiteRequest,
): Promise<CreateSiteResponse> {
  return apiRequest<CreateSiteResponse>(`/projects/${projectId}/sites`, { method: 'POST', body });
}

export function apiCreateBatch(body: CreateBatchRequest): Promise<CreateBatchResponse> {
  return apiRequest<CreateBatchResponse>('/batches', { method: 'POST', body });
}

// ---- Workflow B (Transfer) ----

/**
 * The batch list behind Transfer, Returns and History. One endpoint, one client
 * function: the tabs differ only by the `scope` and toggles they pass in.
 */
export function apiListBatches(query: Partial<BatchListQuery> = {}): Promise<BatchListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // An empty filter is an absent filter, not `?supplierId=`, which the server would
    // reject as a zero-length id.
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return apiRequest<BatchListResponse>(`/batches${qs ? `?${qs}` : ''}`);
}

/** Full batch incl. every cylinder — the payload cached for offline scanning. */
export function apiGetBatch(id: string): Promise<BatchDetailResponse> {
  return apiRequest<BatchDetailResponse>(`/batches/${id}`);
}

export function apiCreateTransfer(body: CreateTransferRequest): Promise<CreateTransferResponse> {
  return apiRequest<CreateTransferResponse>('/transfers', { method: 'POST', body });
}

/**
 * Re-queue a batch's QR sheet. A 429 carries the server's own remaining lockout in
 * `details.retryAfterSeconds`, which the confirmation screen uses to correct its
 * countdown rather than trusting the device clock.
 */
export function apiResendBatchEmail(batchId: string): Promise<ResendBatchEmailResponse> {
  return apiRequest<ResendBatchEmailResponse>(
    `/batches/${encodeURIComponent(batchId)}/resend-email`,
    { method: 'POST' },
  );
}

export function apiCreateReturn(body: CreateReturnRequest): Promise<CreateReturnResponse> {
  return apiRequest<CreateReturnResponse>('/returns', { method: 'POST', body });
}

/**
 * Ask the server to read the driver's ID number off the document they photographed.
 *
 * Deliberately NOT routed through the outbox, unlike everything else on this screen.
 * The outbox exists so that WORK survives a dead spot; this is a suggestion, and a
 * suggestion that arrives tomorrow is worth nothing. Offline it simply is not offered
 * and the number is typed, exactly as it was before this existed.
 */
export function apiReadDriverId(body: ReadDriverIdRequest): Promise<ReadDriverIdResponse> {
  return apiRequest<ReadDriverIdResponse>('/driver-id/read', { method: 'POST', body });
}

// ---- Workflow A2 (Initialize) ----

/**
 * The first scan. Goes through the outbox like transfers and returns, so this direct
 * function exists for symmetry and for the sync worker's typing — the screen enqueues
 * rather than calling it.
 */
export function apiCreateInitialization(
  body: CreateInitializationRequest,
): Promise<CreateInitializationResponse> {
  return apiRequest<CreateInitializationResponse>('/initializations', { method: 'POST', body });
}

// ---- Admin console ----

export function apiAdminUsers(): Promise<AdminUsersResponse> {
  return apiRequest<AdminUsersResponse>('/admin/users');
}

export function apiAdminCreateUser(body: CreateUserRequest): Promise<AdminUserResponse> {
  return apiRequest<AdminUserResponse>('/admin/users', { method: 'POST', body });
}

export function apiAdminUpdateUser(
  id: string,
  body: UpdateUserRequest,
): Promise<AdminUserResponse> {
  return apiRequest<AdminUserResponse>(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export function apiAdminProjectManagers(): Promise<AdminProjectManagersResponse> {
  return apiRequest<AdminProjectManagersResponse>('/admin/project-managers');
}

export function apiAdminCreateProjectManager(
  body: CreateProjectManagerRequest,
): Promise<AdminProjectManagerResponse> {
  return apiRequest<AdminProjectManagerResponse>('/admin/project-managers', {
    method: 'POST',
    body,
  });
}

export function apiAdminUpdateProjectManager(
  id: string,
  body: UpdateProjectManagerRequest,
): Promise<AdminProjectManagerResponse> {
  return apiRequest<AdminProjectManagerResponse>(
    `/admin/project-managers/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

/** Correct a batch entered wrong. The server refuses anything the movement log
 *  contradicts, so a 400 here is information, not a bug. */
export function apiAdminUpdateBatch(
  id: string,
  body: UpdateBatchRequest,
): Promise<BatchDetailResponse> {
  return apiRequest<BatchDetailResponse>(`/admin/batches/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export function apiAdminBatchAmendments(id: string): Promise<BatchAmendmentsResponse> {
  return apiRequest<BatchAmendmentsResponse>(`/admin/batches/${encodeURIComponent(id)}/amendments`);
}

// ---- M5 audit trail ----

/** One cylinder's movement chain, looked up by the serial printed on its label. */
export function apiCylinderHistory(serialCode: string): Promise<CylinderHistoryResponse> {
  return apiRequest<CylinderHistoryResponse>(
    `/cylinders/${encodeURIComponent(serialCode)}/history`,
  );
}

/** Every hop any cylinder in one batch made, newest first. */
export function apiBatchHistory(batchId: string): Promise<BatchHistoryResponse> {
  return apiRequest<BatchHistoryResponse>(`/batches/${encodeURIComponent(batchId)}/history`);
}

/** The History feed: every change to any batch, newest first. */
export function apiHistoryFeed(
  query: Partial<HistoryFeedQuery> = {},
): Promise<HistoryFeedResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return apiRequest<HistoryFeedResponse>(`/history${qs ? `?${qs}` : ''}`);
}

/** One change, in full — its serials and its photo's stamp. */
export function apiHistoryEvent(kind: string, recordId: string): Promise<BatchEventDetailResponse> {
  return apiRequest<BatchEventDetailResponse>(
    `/history/events/${encodeURIComponent(kind)}/${encodeURIComponent(recordId)}`,
  );
}

/**
 * One photo's bytes, fetched only when an event is opened.
 *
 * Base64 through the ordinary authenticated fetch rather than an `<Image>` pointing at
 * a URL: every call to this API needs an `Authorization` header, and an `<Image>` on
 * react-native-web is a plain `<img src>` that cannot send one. See the route.
 */
export function apiBatchPhoto(photoId: string): Promise<BatchPhotoImageResponse> {
  return apiRequest<BatchPhotoImageResponse>(`/batch-photos/${encodeURIComponent(photoId)}`);
}
