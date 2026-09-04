# Gas Cylinder Tracking System

Android field app (Expo) + Fastify/Prisma/PostgreSQL API for tracking **rented** gas
cylinders across project lifecycles — intake with server-allocated serials and emailed
QR sheets, scan-enforced transfers between sites, and returns with driver sign-off and
an emailed delivery note.

## Run it

Needs Node 24 and Docker.

```bash
npm install
npm run setup      # .env files + QR keys, starts Postgres, migrates, seeds
npm run dev:api    # http://localhost:3000  — leave this running
```

Then, in a second terminal:

```bash
npm run demo       # drives all three workflows end to end and prints what happened
```

Set `MAILER=resend` with a `RESEND_API_KEY` to receive the PDFs the project manager
receives: the printable QR sheet and the signed delivery notes.

`npm run setup` is safe to re-run — it never overwrites an existing `.env`, and both
the migration and the seed are idempotent.

## Try the app itself

```bash
npm run dev:mobile        # then press "w" for the browser
npm run dev               # or run the API and the app together
```

The browser build is fine for signing in and the **New** workflow. **Transfer** and
**Returns** require the camera, so they need a real device:

```bash
# point apps/mobile/.env's EXPO_PUBLIC_API_URL at a URL your phone can reach first
npm run -w @gct/mobile start:tunnel     # scan the QR with Expo Go on Android
```

Print the QR sheet from the email to have labels to scan.

Demo logins — password `password`:

| Email                   | Role           | Can do            |
| ----------------------- | -------------- | ----------------- |
| `technician@demo.local` | TECHNICIAN     | New, Transfer     |
| `stores@demo.local`     | STORES_MANAGER | Transfer, Returns |
| `admin@demo.local`      | ADMIN          | everything        |

## Checks

```bash
npm test        # 127 tests: shared (25) + api (87) + mobile (15)
npm run lint
npm run typecheck
```

The API tests need Postgres up (`npm run setup` covers that); mail is captured in process.

## Docs

- [docs/BUILD_BLUEPRINT.md](docs/BUILD_BLUEPRINT.md) — what is built, per milestone, with the defects found and fixed
- [docs/OFFLINE.md](docs/OFFLINE.md) — what works offline and why, the outbox, and the idempotency rule
- [docs/narrative.md](docs/narrative.md) — the extracted spec
