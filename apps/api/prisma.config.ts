import 'dotenv/config'; // Prisma 7 no longer auto-loads .env — do it before anything reads process.env
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts', // `prisma db seed` runs this
  },
  datasource: {
    url: process.env.DATABASE_URL,
    // Optional locally (docker 'gct' role is a superuser). Required where the
    // migration role lacks CREATEDB (managed PG / CI).
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
