import { describe, it, expect } from 'vitest';
import { roleSchema } from '../src/schemas/common';
import { loginRequestSchema, userDtoSchema } from '../src/schemas/auth';

describe('shared schemas', () => {
  it('roleSchema matches the Prisma Role enum set (parity guard)', () => {
    // Mirror of `enum Role` in apps/api/prisma/schema.prisma. If the schema.prisma
    // enum changes, update both and this test keeps them honest.
    const prismaRoleValues = ['TECHNICIAN', 'STORES_MANAGER', 'ADMIN'].sort();
    expect([...roleSchema.options].sort()).toEqual(prismaRoleValues);
  });

  it('loginRequestSchema rejects a bad email', () => {
    expect(loginRequestSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  });

  it('userDtoSchema strips unknown keys like passwordHash', () => {
    const parsed = userDtoSchema.parse({
      id: '1',
      email: 'a@b.co',
      name: 'A',
      role: 'ADMIN',
      active: true,
      passwordHash: 'leak',
    });
    expect(parsed).not.toHaveProperty('passwordHash');
  });
});
