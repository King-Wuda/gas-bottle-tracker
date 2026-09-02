/**
 * One-command first-time setup:  npm run setup
 *
 * Creates the two .env files (generating a fresh QR signing keypair), starts
 * Postgres + MailHog, applies migrations, and seeds the demo data. Safe to re-run —
 * it never overwrites an existing .env, and both migrate and seed are idempotent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repoRoot = path.resolve(apiDir, '../..');

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

const say = (msg: string): void => console.log(`${green('✓')} ${msg}`);
const skip = (msg: string): void => console.log(`${dim('·')} ${dim(msg)}`);

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

// ---- 1. env files ----

const apiEnv = path.join(apiDir, '.env');
const mobileEnv = path.join(repoRoot, 'apps/mobile/.env');
const example = path.join(repoRoot, '.env.example');

if (existsSync(apiEnv) && existsSync(mobileEnv)) {
  skip('.env files already exist — leaving them alone.');
} else {
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  const privateHex = bytesToHex(sk);
  const publicHex = bytesToHex(pk);

  if (!existsSync(apiEnv)) {
    // The example file carries both apps' sections; take everything above the
    // mobile divider and fill in the freshly generated signing key.
    const template = readFileSync(example, 'utf8');
    const apiSection = template.split('# ============ apps/mobile')[0]!;
    writeFileSync(
      apiEnv,
      apiSection
        .replace('QR_SIGN_PRIVATE_KEY_HEX=', `QR_SIGN_PRIVATE_KEY_HEX=${privateHex}`)
        .replace('QR_SIGN_PUBLIC_KEY_HEX=', `QR_SIGN_PUBLIC_KEY_HEX=${publicHex}`),
    );
    say('Wrote apps/api/.env with a fresh Ed25519 QR signing key.');
  }

  if (!existsSync(mobileEnv)) {
    // The device gets ONLY the public half — it must be able to verify a label but
    // never to mint one.
    writeFileSync(
      mobileEnv,
      [
        '# Only EXPO_PUBLIC_* vars are inlined into the bundle. No secrets here.',
        '# For a physical phone via `expo start --tunnel`, point this at a URL the',
        '# phone can actually reach (not localhost).',
        'EXPO_PUBLIC_API_URL=http://localhost:3000',
        `EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY=${publicHex}`,
        '',
      ].join('\n'),
    );
    say('Wrote apps/mobile/.env with the public verify key.');
  }
}

// ---- 2. containers ----

console.log(dim('\nStarting Postgres + MailHog…'));
run('docker', ['compose', 'up', '-d', 'db', 'mailhog'], repoRoot);

process.stdout.write(dim('Waiting for Postgres to accept connections'));
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    execFileSync('docker', ['exec', 'gct-db', 'pg_isready', '-U', 'gct', '-d', 'gct'], {
      stdio: 'ignore',
    });
    ready = true;
    break;
  } catch {
    process.stdout.write('.');
    execFileSync('sleep', ['1']);
  }
}
console.log('');
if (!ready) {
  console.error('\nPostgres did not become ready. Check `docker compose logs db`.\n');
  process.exit(1);
}
say('Postgres and MailHog are up.');

// ---- 3. schema + seed ----

console.log(dim('\nApplying migrations…'));
// `migrate deploy`, not `migrate dev`: dev's post-apply step can hang in some
// containerised shells, and deploy is the correct verb for applying existing
// migrations anyway.
run('npx', ['prisma', 'migrate', 'deploy'], apiDir);

console.log(dim('\nSeeding demo data…'));
run('npx', ['prisma', 'db', 'seed'], apiDir);

console.log(`\n${bold('Setup complete.')}\n`);
console.log('  Start the API:   npm run dev:api');
console.log('  Then, elsewhere: npm run demo');
console.log(`  MailHog inbox:   ${bold('http://localhost:8025')}\n`);
console.log(dim('  Logins (password Passw0rd!): admin@demo.local, stores@demo.local,'));
console.log(dim('  technician@demo.local\n'));
