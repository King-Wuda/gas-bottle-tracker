/**
 * The single PrismaClient for the whole API. Prisma 7's client is Rust-engine-free
 * and REQUIRES a driver adapter — `new PrismaClient()` with no adapter throws.
 *
 * Every module imports { prisma, Prisma } from here, never from the generated path
 * directly, so the generator's output location is an implementation detail.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { Prisma } from './generated/prisma/client.js';
export type { PrismaClient } from './generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

export const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
