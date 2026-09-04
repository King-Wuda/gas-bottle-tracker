import { z } from 'zod';

/**
 * Single source of truth for process.env. The long-running server loads the file
 * via `node --env-file-if-exists=.env`; tests and the Prisma CLI load it via
 * `dotenv/config`. This module only *validates and types* what is already there.
 */

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // serial allocator (M2) — the clock's timezone for the [YY] segment
    SERIAL_YEAR_TZ: z
      .string()
      .default('Africa/Johannesburg')
      .refine(isValidTimeZone, { message: 'SERIAL_YEAR_TZ must be a valid IANA time zone' }),

    // auth (M1)
    JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
    JWT_REFRESH_SECRET: z.string().min(16).optional(), // reserved; refresh tokens are opaque + DB-stored
    JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),

    // QR signing (M2) — Scheme B (recommended) private/public key hex
    QR_SIGN_PRIVATE_KEY_HEX: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    QR_SIGN_PUBLIC_KEY_HEX: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    QR_HMAC_SECRET: z.string().min(32).optional(),

    // mail (M4)
    //
    // 'resend' is the only transport that sends mail, and the default: a mail setup
    // that silently delivers nothing is the worst state this can be in, so it is not
    // reachable by forgetting to configure something.
    //
    // 'capture' keeps messages in memory and sends nothing. It is the integration
    // suite's transport (see services/mailer), not a deployment option.
    MAILER: z.enum(['resend', 'sendgrid', 'capture']).default('resend'),
    MAIL_FROM: z.string().default('Gas Cylinder Tracker <no-reply@gct.local>'),
    /** The change spec's name for MAIL_FROM. Set either; this one wins. */
    EMAIL_FROM: z.string().optional(),
    SENDGRID_API_KEY: z.string().optional(),
    /** Server-only secret. Never an EXPO_PUBLIC_* var — those ship inside the bundle. */
    RESEND_API_KEY: z.string().optional(),

    // storage (M2/M4)
    STORAGE_DIR: z.string().default('./var/storage'),
    /**
     * Where generated PDFs, signatures, photos and ID documents actually live.
     *
     * 'fs' is right everywhere with a durable disk. 'db' puts the bytes in Postgres
     * instead, for hosts that have none — see services/storage.ts for why that is
     * worth a column rather than a lost photograph.
     */
    STORAGE_DRIVER: z.enum(['fs', 'db']).default('fs'),
  })
  .superRefine((cfg, ctx) => {
    // Caught at boot rather than at the first send. A server that starts happily and
    // only reveals a missing key when a technician's batch fails to reach its project
    // manager has moved the error somewhere nobody is watching.
    if (cfg.MAILER === 'resend' && !cfg.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message:
          'required when MAILER=resend — create one at resend.com and verify your ' +
          'sending domain first (see "Sending real email" in README.md)',
      });
    }
    if (cfg.MAILER === 'sendgrid' && !cfg.SENDGRID_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SENDGRID_API_KEY'],
        message: 'required when MAILER=sendgrid',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

/** Lazily validated, cached view of process.env. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/**
 * Drop the cache, so the next `env()` re-reads `process.env`.
 *
 * For tests that need to exercise a configuration switch — the two storage drivers
 * are the case that needed it. The cache is deliberate everywhere else: the process's
 * environment does not change under a running server, and re-validating on every call
 * would only hide a boot-time mistake behind a request-time one.
 */
export function resetEnvCache(): void {
  cached = undefined;
}
