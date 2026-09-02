import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { DEMO, DEMO_PASSWORD, resetDb } from './helpers.js';

const ADMIN = { email: DEMO.admin, password: DEMO_PASSWORD };

let app: FastifyInstance;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  // throwaway route to exercise the role guard
  app.get('/test/admin-only', { preHandler: app.requireRole('ADMIN') }, async () => ({ ok: true }));
  app.get('/test/stores-only', { preHandler: app.requireRole('STORES_MANAGER') }, async () => ({
    ok: true,
  }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const login = (body: Record<string, unknown>): PromiseLike<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: '/auth/login', payload: body });

describe('POST /auth/login', () => {
  it('succeeds with seeded admin credentials', async () => {
    const res = await login(ADMIN);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.accessToken).toEqual(expect.any(String));
    expect(json.refreshToken).toEqual(expect.any(String));
    expect(json.expiresIn).toBe(900);
    expect(json.user).toMatchObject({ email: ADMIN.email, role: 'ADMIN', active: true });
    expect(json.user).not.toHaveProperty('passwordHash');
  });

  it('401s on wrong password', async () => {
    const res = await login({ email: ADMIN.email, password: 'nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('401s on unknown email (same generic code)', async () => {
    const res = await login({ email: 'ghost@demo.local', password: 'whatever' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('400s on a malformed body', async () => {
    const res = await login({ email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

describe('GET /me', () => {
  it('returns the caller with a valid access token', async () => {
    const token = (await login(ADMIN)).json().accessToken;
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(ADMIN.email);
  });

  it('401s with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('401s with a garbage token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/refresh — rotation', () => {
  it('issues a new pair and single-uses the old refresh token', async () => {
    const first = (await login(ADMIN)).json();

    const r1 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(r1.statusCode).toBe(200);
    const rotated = r1.json();
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.accessToken).toEqual(expect.any(String));

    // replaying the consumed token is rejected
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('INVALID_REFRESH_TOKEN');

    // the fresh token still works
    const r2 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(r2.statusCode).toBe(200);
  });

  it('401s on an unknown refresh token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'nonsense' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token', async () => {
    const { refreshToken } = (await login(ADMIN)).json();

    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken },
    });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('requireRole guard', () => {
  it('allows the matching role', async () => {
    const token = (await login(ADMIN)).json().accessToken;
    const res = await app.inject({
      method: 'GET',
      url: '/test/admin-only',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('403s a valid token with the wrong role', async () => {
    const token = (await login(ADMIN)).json().accessToken;
    const res = await app.inject({
      method: 'GET',
      url: '/test/stores-only',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('401s with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/admin-only' });
    expect(res.statusCode).toBe(401);
  });
});
