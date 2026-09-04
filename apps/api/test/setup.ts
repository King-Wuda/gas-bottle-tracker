// Loaded before any test file (see vitest.config.ts `setupFiles`).
// Populates process.env from apps/api/.env so src/db.ts and src/env.ts work.
import 'dotenv/config';

/**
 * Force the in-process capture transport, whatever `.env` says.
 *
 * The suite drains the real email worker and asserts on what it composed. `.env` is a
 * developer's own file and will normally say `MAILER=resend`, which is correct for
 * them and catastrophic here: every `npm test` would post real messages to real
 * people and burn the sending quota.
 *
 * Set here rather than in each test: it must hold before `env()` caches its first
 * read, and no suite should have to remember it.
 */
process.env.MAILER = 'capture';
