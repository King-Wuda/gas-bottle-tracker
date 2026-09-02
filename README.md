# Gas Cylinder Tracking System

Android field app (Expo) + Fastify/Prisma/PostgreSQL API for tracking rented gas cylinders across project lifecycles. See [docs/BUILD_BLUEPRINT.md](docs/BUILD_BLUEPRINT.md).

## Documentation

| Doc                                           | What it covers                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| [BUILD_BLUEPRINT.md](docs/BUILD_BLUEPRINT.md) | Reconciliation of record — stack, version pins, milestone log, audit table |
| [narrative.md](docs/narrative.md)             | The extracted spec the build implements                                    |
| [OFFLINE.md](docs/OFFLINE.md)                 | Outbox / sync design — why the id is the idempotency key                   |
| [BUILD_APK.md](docs/BUILD_APK.md)             | Producing a sideloadable Android APK with EAS                              |
| [WEB_PARITY.md](docs/WEB_PARITY.md)           | Why we test on the web, and the web/native parity rule                     |

## Quick start

```bash
npm install
npm run setup                            # .env files + Postgres/MailHog + migrate + seed
npm run dev                              # API on :3000, Expo on :8081
```

`npm run setup` is the first command on a fresh clone. Both `.env` files are gitignored, so
`DATABASE_URL` does not exist until it writes one — the migrate step cannot run before it.
It also generates a fresh Ed25519 QR signing keypair, keeping the private half in
`apps/api/.env` and copying only the public half to `apps/mobile/.env`. It never overwrites
an existing `.env`, and migrate and seed are both idempotent, so re-running is safe.

Seeded logins (password `Passw0rd!`): `admin@demo.local`, `stores@demo.local`,
`technician@demo.local`. MailHog inbox: <http://localhost:8025>.

Doing it by hand instead — `docker compose up -d`, then `npm run -w @gct/api db:migrate:deploy`
and `db:seed` — works only once both `.env` files already exist.

`npm test` runs all 286 tests; `npm run lint` and `npm run typecheck` gate the same tree.

## The batch lifecycle

A batch passes through four kinds of event, and the order is enforced rather than assumed:

| Step           | What it records                                                                          |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Create**     | Serials allocated, QR sheet emailed to the project manager. Nothing physical yet.        |
| **Initialize** | The labels, scanned back off the cylinders they were stuck to, plus a photo of the batch |
| **Transfer**   | Cylinders moved to another site or back to stores, plus a photo                          |
| **Return**     | Cylinders collected by a named driver who signs on screen, plus a photo                  |

**Initialization is a gate, not a formality.** Until every label on a batch has been scanned
back off its own cylinder, `POST /transfers` and `POST /returns` refuse it with
`409 BATCH_NOT_INITIALIZED`, and the batch does not appear in the Transfer or Returns pickers.
A cylinder with no sticker on it cannot honestly be scanned onto a truck, so a move at that
point could only ever have been someone's assertion.

Initialization lives under **New → Initialize a batch**, because it belongs to a batch's
creation rather than to its working life. Whoever sticks the labels on — the project manager
or a technician — comes back there to scan the batch in.

### Photos, and what they are for

The three scan-backed steps each end at a camera. A scan proves _which_ cylinders; the photo
is the separate claim that they were together, in the place the paperwork names. It is stored
with the device's clock, the server's clock, and a position where the phone could get one.

Location is **best-effort**. A fix fails indoors, in a steel yard, or with location switched
off, and the app records _why_ instead of blocking — the alternative is a driver stuck at a
gate over a satellite. A missing position is shown as missing; it is never rendered as 0°N 0°E.

Both the scan and the photo have an **admin override**, and both are recorded as overrides. An
admin can select cylinders without scanning them, or continue without a photo when the camera
is what has failed. Every other role is refused outright rather than having the override
silently ignored. The audit trail says which evidence it holds, because an override that
looked like a scan or a photo would quietly devalue every real one in the system.

## History

History is read-only, and it lists **events, not batches**. Every change — a creation, a first
scan, a transfer, a return, an admin correction — is its own row, newest first, and opening one
shows the serials it touched and the photo that was taken with it.

Nothing there can be edited, and not by convention: `GET /history` and
`GET /history/events/:kind/:id` are the whole surface behind the screen. Corrections happen in
the admin console, and each one writes a `BatchAmendment` that appears in History as its own
`AMENDED` row — so the section that exists to say what happened is not also the place a change
could hide.

The rows are derived on read from the records that already describe them (`Batch`,
`BatchInitialization`, `Transfer`, `ReturnRecord`, `BatchAmendment`) rather than written to a
log table. A log table would be a second source of truth, and the first time a route wrote the
record and not the log entry, History would start confidently describing things that never
happened.

## Reference data

The seed populates the tables the batch form reads from. All of it is data, not code —
adding a project manager, a supplier, or a gas/supplier pairing is an `INSERT`, never a
deploy.

| Table            | Seeded with                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `ProjectManager` | Jacques Viljoen, Tumelo Mashaba — the addresses batch mail goes to |
| `Supplier`       | `Supplier 1`, `Supplier 2` — placeholders for the real names       |
| `GasType`        | Argon and Nitrogen active; Oxygen, CO2, Helium, Acetylene inactive |
| `GasSupplier`    | Both suppliers paired with both active gases                       |

Gas types are **deactivated rather than deleted** — `Cylinder.gasTypeId` is a `Restrict`
foreign key, so any cylinder ever booked under Oxygen still needs its gas to resolve.
Re-offering one is `UPDATE "GasType" SET active = true WHERE name = 'Oxygen'`.

### Project number format

Project numbers are `######-###-#-##` (e.g. `123456-789-1-23`), enforced in three
places that cannot drift because they share one regex
([`packages/shared/src/projectNumber.ts`](packages/shared/src/projectNumber.ts)):

1. the on-device input mask, which inserts the dashes and rejects non-digits;
2. the API's zod schema, because the API is reachable without the app;
3. a `Project_projectNumber_format` CHECK constraint, because a script or a `psql`
   session is reachable without the API.

The constraint is added `NOT VALID`: it enforces the format on every insert and update
from now on, without rejecting numbers already recorded under the old free-text rule.
Once any legacy numbers have been migrated by hand, adopt it fully with:

```sql
ALTER TABLE "Project" VALIDATE CONSTRAINT "Project_projectNumber_format";
```

## Sending real email

The API queues mail into an `OutboundEmail` table and an in-process worker drains it
with retries, so a send failure never rolls back the batch that triggered it. Which
transport the worker uses is the `MAILER` env var.

| `MAILER`   | Transport                   | Use                                           |
| ---------- | --------------------------- | --------------------------------------------- |
| `mailhog`  | Local SMTP → localhost:1025 | Development. Inspect at http://localhost:8025 |
| `resend`   | Resend API                  | **Production**                                |
| `sendgrid` | SendGrid over SMTP          | Alternative                                   |

`mailhog` is a real SMTP sink, not a stub — messages are genuinely delivered and
readable in its web UI. It is a development tool, not a production transport.

### Setting up Resend

1. Create an account at [resend.com](https://resend.com) and add your sending domain.
2. Verify it by adding the **SPF, DKIM and DMARC** DNS records Resend shows you to your
   domain's DNS. Skipping this is not optional in practice — unverified mail lands in
   spam or is rejected outright.
3. Create an API key.
4. Set these in `apps/api/.env` (and in the VPS environment). **Never commit them** —
   `.env` is gitignored, and `.env.example` is the file that gets committed:

   ```
   MAILER=resend
   RESEND_API_KEY=re_xxxxxxxxxxxx
   EMAIL_FROM="Batch System <noreply@yourdomain.com>"
   ```

5. `resend` is already a dependency (`npm install` covers it).
6. Restart the API and create a real batch; the QR sheet should arrive at the selected
   project manager's address.

Mail is sent **only from server code** — the email worker, in the API process. The
mobile bundle never sees the key: only `EXPO_PUBLIC_*` variables are inlined into the
app, and they are readable by anyone who downloads it.

If `MAILER=resend` and `RESEND_API_KEY` is missing, the API **refuses to start** with a
message naming the variable. That is deliberate: a mailer that fails silently keeps
saving batches while the project manager quietly stops receiving anything.

`EMAIL_FROM` and `MAIL_FROM` name the same thing — `EMAIL_FROM` wins when both are set.

**No domain yet?** Gmail SMTP with an App Password (requires 2FA on the account) works
through the existing `nodemailer` path — set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`
and the account credentials. It is rate-limited and unsuitable for production: treat it
as a stopgap, not a configuration to ship.
