// Loaded before any test file (see vitest.config.ts `setupFiles`).
// Populates process.env from apps/api/.env so src/db.ts and src/env.ts work.
import 'dotenv/config';

/**
 * Force the local SMTP sink, whatever `.env` says.
 *
 * The suite drains the real email worker and asserts against MailHog. With a
 * production transport configured locally — `MAILER=resend`, which is a perfectly
 * reasonable thing to have in a developer's `.env` — those tests would post real
 * messages to real people every time anyone ran `npm test`, burn the sending quota,
 * and then fail anyway because MailHog never saw them.
 *
 * Set here rather than in each test: it must hold before `env()` caches its first
 * read, and no suite should have to remember it.
 */
process.env.MAILER = 'mailhog';
