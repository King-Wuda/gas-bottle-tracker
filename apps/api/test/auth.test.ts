import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { DEMO, DEMO_PASSWORD, resetDb } from './helpers.js';

const ADMIN = { email: DEMO.admin, password: DEMO_PASSWORD };

let app: FastifyInstance;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  // throwaway route to exercise the role guard
  app.get('/test/admin-only', { preHandler: app.requireRole('PROJECT_MANAGER') }, async () => ({
    ok: true,
  }));
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
    expect(json.user).toMatchObject({ email: ADMIN.email, role: 'PROJECT_MANAGER', active: true });
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

  it('ignores the case of the email address, and spaces around it', async () => {
    for (const typed of [
      ADMIN.email.toUpperCase(),
      ADMIN.email.charAt(0).toUpperCase() + ADMIN.email.slice(1),
      `  ${ADMIN.email}  `,
    ]) {
      const res = await login({ email: typed, password: ADMIN.password });
      expect(res.statusCode, typed).toBe(200);
      expect(res.json().user.email).toBe(ADMIN.email);
    }
  });

  it('still signs in an account whose address was stored with capitals', async () => {
    await prisma.user.create({
      data: {
        email: 'Mixed.Case@Demo.Local',
        name: 'Mixed Case',
        role: 'TECHNICIAN',
        passwordHash: await hashPassword('gea'),
      },
    });
    const res = await login({ email: 'mixed.case@demo.local', password: 'gea' });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.name).toBe('Mixed Case');
  });

  it('a different case does not get past a wrong password', async () => {
    const res = await login({ email: ADMIN.email.toUpperCase(), password: 'nope' });
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

/** Made-up passwords for the change-password tests — fixtures, not credentials. */
const PW = {
  OWN: 'my-own-password',
  CHANGED: 'changed-on-my-phone',
  WRONG: 'not-it',
  WHATEVER: 'whatever-new',
  MANAGERS: 'manager-picked-this',
  ANY_NEW: 'yyyy',
  TOO_SHORT: 'ab',
} as const;

describe('POST /me/password — changing your own password', () => {
  /** A login of its own: changing a shared demo account's password would break every
   *  suite after this one, since resetDb does not touch passwords. */
  async function freshAccount(role: 'TECHNICIAN' | 'PROJECT_MANAGER' = 'TECHNICIAN') {
    const email = `changer.${Date.now()}.${Math.floor(Math.random() * 1e6)}@demo.local`;
    await prisma.user.create({
      data: {
        email,
        name: 'Password Changer',
        role,
        passwordHash: await hashPassword(DEMO_PASSWORD),
      },
    });
    const res = await login({ email, password: DEMO_PASSWORD });
    return { email, ...(res.json() as { accessToken: string; refreshToken: string }) };
  }

  const change = (token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/me/password',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it('changes it: the new one signs in, the old one no longer does', async () => {
    const acct = await freshAccount();
    const res = await change(acct.accessToken, {
      currentPassword: DEMO_PASSWORD,
      newPassword: PW.OWN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accessToken: expect.any(String), expiresIn: 900 });

    expect((await login({ email: acct.email, password: DEMO_PASSWORD })).statusCode).toBe(401);
    expect((await login({ email: acct.email, password: PW.OWN })).statusCode).toBe(200);
  });

  it('ends the other sessions but hands this device a working new one', async () => {
    const acct = await freshAccount();
    const elsewhere = (await login({ email: acct.email, password: DEMO_PASSWORD })).json();

    const res = await change(acct.accessToken, {
      currentPassword: DEMO_PASSWORD,
      newPassword: PW.CHANGED,
    });

    // The phone that might be lost can no longer renew its session...
    for (const refreshToken of [elsewhere.refreshToken, acct.refreshToken]) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken },
      });
      expect(r.statusCode).toBe(401);
    }
    // ...while the one that made the change carries on.
    const mine = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: res.json().refreshToken },
    });
    expect(mine.statusCode).toBe(200);
  });

  it('refuses a wrong current password with a 400, and changes nothing', async () => {
    const acct = await freshAccount();
    const res = await change(acct.accessToken, {
      currentPassword: PW.WRONG,
      newPassword: PW.WHATEVER,
    });
    // 400, not 401: the session is fine, and a 401 would make the app refresh and retry.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('WRONG_PASSWORD');
    expect((await login({ email: acct.email, password: DEMO_PASSWORD })).statusCode).toBe(200);
  });

  it('is open to every role, project managers included', async () => {
    const acct = await freshAccount('PROJECT_MANAGER');
    const res = await change(acct.accessToken, {
      currentPassword: DEMO_PASSWORD,
      newPassword: PW.MANAGERS,
    });
    expect(res.statusCode).toBe(200);
  });

  it('requires a signed-in caller and a long-enough new password', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: '/me/password',
      payload: { currentPassword: PW.WRONG, newPassword: PW.ANY_NEW },
    });
    expect(anon.statusCode).toBe(401);

    const acct = await freshAccount();
    const short = await change(acct.accessToken, {
      currentPassword: DEMO_PASSWORD,
      newPassword: PW.TOO_SHORT,
    });
    expect(short.statusCode).toBe(400);
  });
});
