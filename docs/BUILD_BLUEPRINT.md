# Build Blueprint — Gas Cylinder Tracking System

Reconciliation of record for the greenfield build. Derived from the approved plan
(`~/.claude/plans/cryptic-honking-allen.md`), the spec (`docs/narrative.md`), and a
blueprint pass (3 of 7 module blueprints landed before a session limit; the rest
are designed inline per-milestone).

**Status (2026-08-28): M0–M5 complete.** All three workflows run end to end, the audit
trail is reachable from the app, and the offline queue is manageable per row.
174 tests green (shared 25 · api 121 · mobile 28) · lint + typecheck clean ·
`expo-doctor` 21/21 · Android export builds. Shareable APK: [BUILD_APK.md](BUILD_APK.md).

---

## Stack (locked)

| Layer                          | Choice                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Monorepo                       | npm workspaces — `packages/shared` + `apps/api` + `apps/mobile`, ESM everywhere                                       |
| Shared contract                | `@gct/shared` ships **raw .ts**; consumed directly by tsx (API), Metro (mobile), vitest. No build step.               |
| API                            | Fastify 5 + zod + Prisma 7 (`prisma-client` generator) + PostgreSQL 16                                                |
| DB access                      | `@prisma/adapter-pg` driver adapter (Prisma 7 requires one) via a single `apps/api/src/db.ts`                         |
| Mobile                         | Expo SDK 57 / React Native 0.86.3 / expo-router, TypeScript                                                           |
| Scanning / offline / signature | expo-camera · expo-sqlite · react-native-signature-canvas (M3/M4)                                                     |
| QR crypto                      | isomorphic `@noble/*` (never `node:crypto`). Two schemes, versioned in the payload prefix; **default GCT2 / Ed25519** |
| PDF / mail                     | pdfkit + qrcode; pluggable `Mailer` (MailHog dev / SendGrid prod); DB-backed `OutboundEmail` queue (M4)               |
| Auth                           | local accounts, admin-seeded; JWT access + refresh; roles TECHNICIAN / STORES_MANAGER / ADMIN (M1)                    |
| Idempotency                    | device-minted `clientRequestId` UUID, `@unique` on Batch / Transfer / ReturnRecord                                    |

---

## Pinned versions (verified against live npm on 2026-08-27)

**Root tooling** — typescript `6.0.3` (typescript-eslint 8.68 peer-caps `<6.1`; `latest` is 7.0.2),
eslint `10.9.1`, typescript-eslint `8.68.0`, prettier `3.9.6`, @types/node `24.13.3` (match runtime + `ts6.0` tag),
concurrently `10.0.5`, rimraf `6.1.3`.

**`@gct/shared`** — zod `4.4.3`, @noble/hashes `2.4.0`, @noble/curves `2.4.0` (curves peer-pins hashes exactly), vitest `4.1.11`, vite `8.2.2` (vitest 4 peers vite, does not bundle it).

**`apps/api`** — fastify `5.12.1`, @fastify/sensible `6.0.5`, @prisma/client `7.10.0`, prisma `7.10.0`, @prisma/adapter-pg `7.10.0`, pg `8.23.0`, argon2 `0.45.1`, dotenv `17.4.2`, tsx `4.23.12`, @types/pg `8.23.1`.

> **Prisma pin is mandatory.** `npm view prisma` `latest` = `8.0.0-rc.12` (a pre-release); `prev` = `7.10.0`. `@prisma/client` `latest` is the stable `7.10.0`. A bare install pulls the RC and desyncs from the client.

**`apps/mobile`** — from Expo SDK 57 `node_modules/expo/bundledNativeModules.json`, **not** bare `npm view`:
expo `57.0.18`, react `19.2.3`, react-native `0.86.3`, expo-router `57.0.17`, @expo/metro-runtime `57.0.14`,
expo-constants `57.0.16`, expo-linking `57.0.8`, expo-status-bar `57.0.1`,
react-native-screens `4.26.0`, react-native-safe-area-context `5.7.0`, react-native-gesture-handler `2.32.0`,
react-native-reanimated `4.5.1`, react-native-worklets `0.10.1`, @types/react `19.2.18`.

> The blueprint agent's mobile pins were wrong — it read bare `npm view` latest (`react-native@0.87.1`, `react@19.2.8`). SDK 57 pins `0.86.3` / `19.2.3`, and reanimated 4.5.1 peers `react-native 0.83–0.86`. **For any RN/Expo package, take the version from `bundledNativeModules.json` or `npx expo install`, never `npm view`.**

**Root `overrides`** (single-copy guarantees): `typescript` `6.0.3`, `react` `19.2.3`, `react-dom` `19.2.3`, and `zod` `4.4.3` **scoped to `@gct/shared` + `@gct/api` only** (see the audit below — a global zod override dragged `@expo/cli` across a major version).

> `prisma` CLI transitively pulls `@prisma/studio-core` → a `react@19.2.8` + `@radix-ui/*` + `@visx/*` tree. Without the `react`/`react-dom` overrides, npm hoists `19.2.8` to root and keeps the mobile app's `19.2.3` nested → two Reacts → "Invalid hook call". The overrides collapse it to one `19.2.3`. Requires a clean install (`rm -rf node_modules package-lock.json && npm install`) to take effect.

---

## Resolved contradictions

| Point                      | Blueprints disagreed                                           | Decision                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Postgres image             | `postgres:16-alpine` vs `postgres:18`                          | **`postgres:16-alpine`** — conservative; nothing in the schema needs 17/18                                                                                                                                                     |
| `SerialSequence` PK        | surrogate `id` + `@@unique([prefix,year])` vs composite `@@id` | **composite `@@id([prefix, year])`**, no surrogate — it's the natural key and the `ON CONFLICT` arbiter                                                                                                                        |
| Prisma generator           | new `prisma-client` vs legacy `prisma-client-js`               | **new `prisma-client`** (legacy removed in Prisma 8). Output `apps/api/src/generated/prisma` (gitignored, `postinstall: prisma generate`). Blast radius contained: all code imports `{ prisma, Prisma }` from `src/db.ts` only |
| Prisma `.env`              | "CLI auto-loads it" vs "Prisma 7 dropped autoload"             | **dropped** — `import 'dotenv/config'` at the top of `prisma.config.ts` and `seed.ts`; the server uses `node --env-file-if-exists`                                                                                             |
| `datasource.url` in schema | present                                                        | **removed** — Prisma 7 forbids `url` in `schema.prisma`; the URL lives in `prisma.config.ts` (CLI/Migrate) and reaches the client via the pg adapter                                                                           |
| `@types/node`              | `24.13.3` vs `26.4.0`                                          | **`24.13.3`** — match runtime Node 24 and TS 6.0's `ts6.0` support tag                                                                                                                                                         |
| QR scheme                  | Ed25519 (GCT2) vs truncated-HMAC (GCT1)                        | **both implemented**, default **GCT2** (device carries only a public key → cannot forge stickers offline). Final call deferred to M2 — a real business decision (`docs/OPEN_DECISIONS.md` when written)                        |

---

## The `@gct/shared` ↔ Metro contract (the biggest landmine — verified working)

`packages/shared/package.json` `exports["."]` → `./src/index.ts` for both `types` and `default`; `main`/`types` also point there. No `dist` is consumed at runtime.

- **API (tsx)** transpiles `.ts` on import → `@gct/shared` just resolves.
- **vitest** (esbuild) transpiles `.ts` natively.
- **Metro (SDK 57)** — `apps/mobile/metro.config.js` sets `watchFolders = [monorepoRoot]` and `nodeModulesPaths = [app, root]`. Symlink-following and package-`exports` resolution are **already on by default in SDK 57** — do **not** set `unstable_enableSymlinks` / `unstable_enablePackageExports` explicitly (expo-doctor flags the override). `@noble/*` subpath imports require the `.js` suffix (`@noble/hashes/hmac.js`).

Smoke test (passing): `apps/mobile/app/index.tsx` imports `formatSerial` + `encodeQrPayloadHmac` + `verifyQrPayload` from `@gct/shared`; `npx expo export --platform android` bundles 1255 modules with no resolution error.

---

## Serial allocation — the invariant that must not break

`allocateSerials(tx, prefix, year, count)` in `apps/api/src/services/serial.ts` — **one atomic statement**:

```sql
INSERT INTO "SerialSequence" ("prefix","year","lastSeq") VALUES ($1,$2,$3)
ON CONFLICT ("prefix","year")
DO UPDATE SET "lastSeq" = "SerialSequence"."lastSeq" + EXCLUDED."lastSeq"
RETURNING "lastSeq"
```

`ON CONFLICT DO UPDATE` row-locks and re-reads the latest committed row even under READ COMMITTED, so N concurrent callers compose their increments with no lost update and no 40001 abort — beats `SELECT FOR UPDATE` (which needs a race-prone "insert if missing"). Reserved span `[end-count+1 .. end]`. Format zero-pads SEQ to 3, widens past 999 (`NIT26-1000`), never wraps. Year from an injectable `Clock` + `SERIAL_YEAR_TZ` (deterministic midnight rollover). `Cylinder.serialCode @unique` is the backstop, not the mechanism.

Proven by `apps/api/test/serial.concurrency.test.ts` — 20 parallel `$transaction` allocations, asserts unique + contiguous `1..N` + well-formed + `lastSeq === N`.

---

## Milestone status

- [x] **M0 — Foundation.** Workspaces, tooling, docker-compose (Postgres + MailHog), full Prisma schema + 2 migrations (init + trgm search indexes / CHECK constraints), idempotent seed, `@gct/shared` (serial + QR), `allocateSerials` + concurrency/rollover tests, Fastify `/health`, minimal Expo skeleton with a verified `@gct/shared` Metro bundle.
- [x] **M1 — Auth.** (done 2026-08-27) argon2 login, JWT access token + **opaque DB-stored refresh token with single-use rotation**, `POST /auth/login|refresh|logout` + `GET /me`, `authenticate` / `requireRole(...)` preHandlers (`apps/api/src/plugins/auth.ts`), stable error envelope + not-found handler (`apps/api/src/plugins/errorHandler.ts`), `RefreshToken` model + migration, `@gct/shared/schemas/{common,auth}`. Mobile: `expo-secure-store` token store, fetch client with single-flight 401→refresh→retry (`apps/mobile/src/api/client.ts`), `AuthContext` + `AuthGate` redirect, `login.tsx`, 3-button dashboard. 35 tests green; auth endpoints smoke-tested live.
  - **No `fastify-type-provider-zod`** — its v7 hard-peers `@fastify/swagger` + `openapi-types`. Handlers call `schema.parse(request.body)` directly; the `ZodError` → 400 `VALIDATION` mapping lives in the error handler. Revisit at M2 (bundle swagger + type provider together for OpenAPI docs).
  - Mobile imports from `@gct/shared` are currently **type-only** (`import type`), so they are erased and do not exercise the runtime Metro bundle of `@gct/shared`; M0's `expo export` already proved the runtime path and M3's scanner (`verifyQrPayload`) will re-exercise it.
- [x] **M2 — Workflow A (New).** (done 2026-08-27) `GET /gas-types`, `GET/POST /projects`, `GET /projects/:id`, `POST /projects/:id/sites`, `POST /batches` (validates → `allocateSerials` → cylinders → INTAKE events → queues the PM email, all in one tx, **idempotent on `clientRequestId`**), `GET /batches`, `GET /batches/:id`. Services: `storage.ts`, `qr.ts` (signs via Scheme B), `pdf.ts` (A4 3×4 QR grid), `mailer/` (nodemailer → MailHog/SendGrid), `emailWorker.ts` (`FOR UPDATE SKIP LOCKED` claim, renders the PDF at send time, retry w/ attempt cap). `OutboundEmail.payload` column added. Mobile: `app/new/` flow — site-mode prompt → create-site | select-project (+ add site) → line items (gas-type chips, multi-line) → confirm with allocated serials. 54 tests green.
  - **Verified live end-to-end:** login → create project → `POST /batches` qty 7 → serials `NIT26-001..007` → worker rendered a 54 KB PDF → MailHog received it at the PM address with an `application/pdf` attachment → row `SENT`.
  - ~~**One batch per line item.**~~ **Superseded (multi-gas change).** A batch is now a
    _delivery_: it has `BatchLine[]`, and one delivery may carry several gases from several
    suppliers. `Batch.gasTypeId`/`supplierId`/`supplierName`/`quantity`/`initialDeliveryPoint`
    moved wholesale to `BatchLine`; the screen collects lines and POSTs **one** batch holding
    all of them, written whole or not at all.
  - Tests share one Postgres, so each suite calls `resetDb()` (`apps/api/test/helpers.ts`) to truncate the mutable tables while keeping seeded Users/GasTypes.
- [x] **Audit + remediation.** (2026-08-28) Three Opus reviewers over all M0–M2 code; 8 API + 6 mobile + 3 config defects found, reproduced, fixed, and covered by 7 new regression tests. Full table above.
- [x] **M3 — Workflow B (Transfer).** (done 2026-08-28) `POST /transfers` — resolves scans, moves only what was physically scanned, appends one `TRANSFER` MovementEvent per cylinder, **idempotent on `clientRequestId`**. `@gct/shared/schemas/transfer.ts` (scan input, discriminated destination union, per-serial rejection codes). `src/services/scans.ts` (shared with M4's returns) re-verifies every QR signature server-side and returns a per-serial rejection list. `MovementEvent.transferId` + migration `20260828074950_movement_event_transfer_link`. Mobile: `app/transfer/` (find batch → scan → destination → result), `expo-camera` scanner with a live scanned/expected checklist, offline QR rejection via the Ed25519 public key, `expo-sqlite` outbox + batch mirror (`src/db/`), sync worker with exponential backoff (`src/sync/`), queue banner on the dashboard. 102 tests green (shared 21 · api 66 · **mobile 15 — the app's first test suite**).
  - **The claim is one SQL statement.** `POST /transfers` reads state to build friendly per-serial errors, but the decision to move is a single `WITH locked AS (SELECT … FOR UPDATE) UPDATE … RETURNING l."currentSiteId"`. Two properties depend on this: a cylinder returned or transferred between the read and the write is skipped (`CONFLICT`) rather than moved twice, and `fromSiteId` is read _through the row lock_, so the audit chain records where the cylinder actually was rather than where the request's snapshot thought it was.
  - **Mutation-verified** (per the M0–M2 audit's rule). The naive `UPDATE … FROM "Cylinder" old` self-join logs `fromSiteId = NULL` for a hop that departed from Yard A → the origin test fails. A read-then-write `updateMany` by id → both the origin test and the CONFLICT test fail. On mobile, removing the outbox's `INSERT OR IGNORE` and removing the 401 early-break each fail their test.
  - **Concurrent transfers to different sites both apply** — that is correct, not a race: the cylinder was scanned twice and sent two places, so both hops are recorded in lock order and the chain stays contiguous. Only same-destination races produce a `CONFLICT`.
  - **The idempotency key is claimed FIRST, before any scan is evaluated.** Found by a ~50% flaky test during M3, and it is a real defect, not a flake: with the `Transfer` insert placed after scan resolution, a concurrent duplicate that missed the pre-transaction lookup went on to read cylinder state its own original had _already committed_, saw every cylinder as `ALREADY_AT_DESTINATION`, and returned **422** — never reaching the `P2002` that routes a duplicate to the replay path. An outbox retry that gets a hard refusal is an outbox retry that never clears. Inserting first makes a duplicate block on the unique index until the original commits or aborts. Guarded by a 10-round race probe (one round caught it only ~50% of the time; ten catches it 4/4).
  - **Destination must be in the batch's own project.** Workflow B is "between project sites or back to stores"; a foreign site would move a cylinder off its contract and break rental accountability. `400 INVALID_DESTINATION`.
  - **Verified live end-to-end:** login → project + 2 sites → batch of 5 → scan 3 → transfer to Yard B (201, 3 moved) → replay same `clientRequestId` (200, same transfer id) → forged QR (422 `BAD_QR_SIGNATURE`, nothing moved) → transfer back to Stores (201). Audit table shows `INTAKE → TRANSFER(STORES→Yard B) → TRANSFER(Yard B→STORES)` for scanned cylinders and `INTAKE` only for the two never scanned.
  - **Web build keeps working.** `expo-sqlite` on web needs wasm + cross-origin isolation headers the `/app` static mount does not send, so `src/db/index.ts` picks a memory store on web and SQLite on device. `npx expo export --platform android` succeeds — the first build to exercise `@gct/shared` at _runtime_ (offline QR verification), closing the M1 note about type-only imports.
- [x] **M4 — Workflow C (Returns).** (done 2026-08-28) `POST /returns` (STORES_MANAGER / ADMIN) — verifies scans, marks only what was scanned `RETURNED`, appends one `RETURN` MovementEvent each, **rolls the batch status forward**, and queues the PM's delivery note. `@gct/shared/schemas/return.ts`. `services/signature.ts` (accepts a data URL or bare base64, **verifies PNG magic bytes** before storing — a note that renders "[signature image unavailable]" would be worthless exactly when it is needed). `renderDeliveryNote` in `services/pdf.ts` (project, PM, site, per-serial origin + device timestamps, embedded signature, partial-return warning). `DELIVERY_NOTE` branch in `emailWorker.ts`, which renders at send time from the return's own movement events and writes `deliveryNotePath` back. `MovementEvent.returnRecordId` + migration `20260828090312_movement_event_return_link`. Mobile: `app/returns/` (find batch → verify-scan → sign → result) with `react-native-signature-canvas@5.1.1` + `react-native-webview@13.16.1`, queued through the same outbox (`kind: 'return'`). 127 tests green (shared 25 · api 87 · mobile 15).
  - **Batch status is serialised on the batch row.** `ACTIVE`/`PARTIAL`/`RETURNED` is a function of _all_ a batch's cylinders, so two concurrent returns each counting within their own snapshot both conclude "PARTIAL" — and a batch whose every cylinder came back would accrue rental forever. A `SELECT … FOR NO KEY UPDATE` on the batch makes the loser's later statements see the winner's committed rows. Mutation-verified: dropping the lock fails the split-batch test 2/2.
  - **That lock must be taken BEFORE the ReturnRecord insert.** `ReturnRecord.batchId` is a foreign key, so the insert already holds `FOR KEY SHARE` on that same batch row; locking afterwards means both transactions ask to upgrade and **deadlock (40P01)** — which it did, on the first concurrent test run. Mutation-verified: the original ordering (`FOR UPDATE` after the insert) deadlocks 3/3; the reordering alone fixes it, and `FOR NO KEY UPDATE` additionally stops a return from blocking a concurrent _transfer_'s FK insert against the same batch.
  - **Shared scan machinery.** `resolveScans` was reused verbatim from M3. On mobile, `TransferFlowContext` became `src/scanning/ScanFlowContext` and the find-batch and scan screens became `FindBatch` / `ScanStep` components, so `app/transfer/index.tsx` and `app/returns/index.tsx` are four lines each. Each flow's `_layout` mounts its own provider, so a half-finished transfer and a half-finished return never see each other's scans.
  - **The delivery-note test reads the actual PDF.** Three layers to get through — Flate-compressed content streams, hex-encoded show-text operands (`<50524a2d31>` = "PRJ-1"), and kerning splitting one string across several operands. Asserting on inflated, decoded, reassembled text means it checks the serials the PM will really see; mutation-verified by making the note list every cylinder in the batch (the "cylinders that stayed out must NOT appear" assertion fires).
  - **Verified live end-to-end:** batch of 5 → all deployed to Yard B → return 3 (201, `PARTIAL`, 2 outstanding) → replay same key (200, same record) → technician attempt (403) → return last 2 (201, `RETURNED`) → batch leaves the active list → MailHog holds 1 QR sheet + 2 delivery-note PDFs. The rendered note lists each serial with `Yard B` as its true origin. Audit table shows the full `INTAKE → TRANSFER → RETURN` chain, each event linked to its parent operation.
- [x] **M5 — Hardening.** (done 2026-08-28) Audit-log view, an actionable sync queue, empty/error states, EAS APK config, and tests for the branches M0–M4 shipped but never executed. **174 tests green** (shared 25 · api 121 · mobile 28), `expo-doctor` 21/21, Android export builds.
  - **Audit trail is now reachable from the app.** `GET /cylinders/:serialCode/history` (one cylinder's chain, oldest hop first) and `GET /batches/:id/history` (batch activity feed, newest first), both readable by every role — a technician who scanned a cylinder yesterday needs to see where it went as much as a stores manager does. `@gct/shared/schemas/history.ts`; `apps/api/src/routes/history.ts`. Mobile `app/history/` renders the chain as a timeline with the scanning user and the offline sync lag per hop.
    - The test that matters asserts **contiguity**: every hop's `fromName` must equal the previous hop's `toName`. A fabricated origin — the M3 read-through-the-lock bug — breaks exactly this and nothing else in the suite would notice.
    - A `RETURNED` cylinder and one sitting in stores both have `currentSiteId = null`; only `currentLocation` tells them apart ("Returned to supplier" vs "Stores"). Covered.
    - `serverAt` alone is ambiguous — every event one transaction wrote shares it — so the batch feed orders by `[serverAt desc, serialCode asc]` and a test asserts the order is stable across repeated requests.
  - **`GET /batches` validated its query string.** `status` was read raw off `request.query`, and anything unrecognised fell through to the `active` branch: `?status=RETRUNED` silently answered the opposite of what was asked. Now `batchListQuerySchema` → 400 `VALIDATION`.
  - **The email worker's failure path is executed at last.** `apps/api/test/hardening.test.ts` drives a failing send through all five attempts (PENDING ×4, then FAILED, then not re-claimed), the recovery case (a successful retry must clear `lastError`, or the row reads as a failure forever), and a permanently unbuildable payload.
    - **`FOR UPDATE SKIP LOCKED` is mutation-verified.** Six concurrent drains over three rows claim each exactly once. Removing `SKIP LOCKED` yields **12 claims for 3 emails** — the PM gets four copies of every QR sheet. Also covered: a row stranded in `SENDING` by a crashed worker is re-claimed after its 5-minute lease, and a freshly-claimed one is not.
  - **`/health` and `env.ts` are tested.** Including the 503 degraded branch (the DB going away) and the env cases that would otherwise fail deep inside a request: a bad `SERIAL_YEAR_TZ` silently shifts the `[YY]` serial segment, a weak `JWT_ACCESS_SECRET`, a malformed QR key.
  - **The sync queue is a screen you can act on** (`app/queue.tsx`). A refused submission used to be visible only on the result screen of the flow that created it — navigate away and it was unreachable, sitting in SQLite with nothing to surface it. Per row: the refusal code, the per-serial rejections, **Retry**, and **Discard**.
    - **Retry does not mint a new id.** `retryOutbox` moves a `rejected` row back to `pending` under its original id — which IS its `clientRequestId` — so if the server did accept the original after all, the replay returns that same record instead of creating a second transfer. Attempts reset so the operator gets a prompt first try rather than inheriting a five-minute backoff.
    - **`discardOutbox` refuses to bin unsent work.** Both verbs carry their state guard in the SQL `WHERE`, so a concurrent drain cannot slip between a read and an update. `pending` is field work that never reached the server; `done` must never be resurrected. 13 new mobile tests cover the full refuse → retry → accept cycle through the real drain.
  - **Empty / loading / error states** (`LoadingState`, `EmptyState`, `ErrorState` in `src/ui/components.tsx`). Screens previously rendered nothing while loading and nothing when a list came back empty — indistinguishable from a hung app on a slow link. `FindBatch` now distinguishes "you have not searched yet" from "nothing matched", and a failed search offers the way out instead of a dead end.
  - **EAS build config** — `apps/mobile/eas.json` with a `preview` profile emitting a sideloadable APK (`production` deliberately emits an AAB, which cannot be sideloaded). See [BUILD_APK.md](BUILD_APK.md).
    - **`.env` is gitignored and EAS only uploads tracked files**, so a naive build bakes in `EXPO_PUBLIC_API_URL=http://localhost:3000` — which on a phone means the phone itself — and every request fails as an unexplained network error. Values belong in the profile's `env` block. `src/config.ts` now detects this in a standalone build and states the reason on the sign-in screen rather than letting a technician debug it in a yard.
  - **eslint was linting the web bundle.** The ignore list had `**/dist/**`, which does not match `apps/mobile/dist-web/` — so once a web export existed, `npm run lint` reported ~6,200 errors from bundled output. Ignored explicitly.
  - **Expo patch drift.** `expo` 57.0.17 → `57.0.18` and `expo-constants` 57.0.15 → `57.0.16` (SDK 57 patches published since M4; `expo-doctor` flagged the mismatch). Taken via `npx expo install --fix`, then re-pinned exactly — `--fix` writes `~` ranges, which this repo does not use.

## Audit (2026-08-28) — findings and fixes

Three Opus reviewers audited all M0–M2 code (written by a weaker model). Everything below
was **empirically reproduced**, then fixed, then locked down by a test in
`apps/api/test/regressions.test.ts` (7 tests) that fails against the pre-fix code.

| #   | Severity                     | Defect                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                              |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | **High (security)**          | Refresh-token rotation was read-then-write, so it was **not single-use**. Measured: 9/10 rounds had all 6 concurrent rotations of one token succeed, forking 6 live token families from one stolen token.                                  | Single conditional `UPDATE … WHERE revokedAt IS NULL … RETURNING` — Postgres re-evaluates the predicate, so exactly one caller wins.                                                             |
| C2  | **High (contract)**          | Concurrent identical `clientRequestId` returned **409**, not the original batch — defeating idempotency exactly when it matters (offline outbox retry).                                                                                    | Catch `P2002` on the unique index and fall through to the replay path (200).                                                                                                                     |
| C3  | High (availability)          | `POST /batches` **500'd under load**: the `SerialSequence` row lock was held across 4 more round trips, blowing Prisma's _default 5 s_ transaction budget. 13/24 concurrent `quantity:500` batches failed.                                 | Explicit `{ timeout: 20_000, maxWait: 10_000 }`, and cylinder ids generated in-process to drop a `findMany` from inside the lock window.                                                         |
| C4  | **High (silent regression)** | Migration `20260827194253_refresh_tokens` **silently `DROP INDEX`'d both trigram indexes** — `migrate dev` treats a hand-written index it can't see in the schema as drift. The project search had been doing sequential scans ever since. | Declared them in `schema.prisma` via `@@index([...(ops: raw("gin_trgm_ops"))], type: Gin, map: …)` and restored them. `migrate diff` now reports **zero drift**, so they can't be dropped again. |
| C5  | Medium (security)            | `POST /auth/login` was a **user-enumeration timing oracle**: unknown email 2 ms vs wrong password 131 ms, because `user && verify(...)` short-circuited argon2.                                                                            | Always burn one argon2 verify against a `dummyHash()`. Now ~94 ms either way.                                                                                                                    |
| C6  | Medium (reliability)         | `OutboundEmail` rows stranded in `SENDING` **forever** if the process died mid-send — the claim only selected `PENDING`, so the PM never got their QR sheet.                                                                               | 5-minute lease: the claim also re-takes `SENDING` rows whose `updatedAt` is stale.                                                                                                               |
| C7  | Low (latent)                 | `Cylinder.currentSiteId` FK was `ON DELETE SET NULL`, which would instantly violate the `Cylinder_deployed_has_site` CHECK → unmapped 500.                                                                                                 | `onDelete: Restrict`, matching every other FK.                                                                                                                                                   |
| C8  | Low (M3 prep)                | `Transfer` had no CHECK coupling `destinationType` to `destinationSiteId`, though the structurally identical `Cylinder` invariant had three.                                                                                               | Added both CHECK constraints before M3 writes to the table.                                                                                                                                      |

**Mobile**

| Severity | Defect                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **High** | `submitAll` minted a **fresh `clientRequestId` per attempt**, so retrying after a partial failure re-created already-created batches — duplicate serials burned and duplicate QR sheets emailed to the PM. The server's idempotency was unreachable. | `clientRequestId` is minted **once per draft, when its first line is added**, and stored on the draft. (Originally per-line; the multi-gas change made the whole draft one batch, so there is one key for it.) |
| **High** | Batches that _did_ succeed before a partial failure were dropped from client state — the technician never saw their serials.                                                                                                                         | Keep successes, drop the succeeded lines from the draft, and report "N of M created — tap Create to submit the rest".                                                                                          |
| Medium   | A non-JSON error body (a forwarded-port HTML sign-in page, a proxy 502) threw a raw `SyntaxError` past the `!res.ok` branch, so every screen's `instanceof ApiError` check failed.                                                                   | `JSON.parse` wrapped in try/catch.                                                                                                                                                                             |
| Medium   | `doRefresh` **rejected** on a mid-refresh network drop, escaping as an untyped `TypeError`.                                                                                                                                                          | Returns `null` instead.                                                                                                                                                                                        |
| Low      | `reset()` ran before `router.replace('/')`, so the confirm screen's empty-results guard could bounce the user back into `/new`.                                                                                                                      | Navigate first, then reset.                                                                                                                                                                                    |
| Low      | Signed-out users saw one frame of the dashboard (redirect lived in an effect).                                                                                                                                                                       | Redirect during render via `<Redirect>`.                                                                                                                                                                       |

**Config**

- The global `zod` override forced `@expo/cli` (declares `^3.25.76`) across a **major version**, and `npm ls` exited non-zero. Now **scoped** to `@gct/shared` / `@gct/api`; `npm ls` exits 0.
- `metro.config.js` was **overriding Expo SDK 57's own better defaults** — three of its four lines were no-ops, and replacing `watchFolders` with the repo root made Metro crawl `.git/` and `apps/api/var/storage/` (where the worker writes PDFs at runtime). The file now just returns `getDefaultConfig(__dirname)`.
- `packages/shared/test/**` was **never type-checked** by anything (vitest strips types without checking). Added `tsconfig.test.json` and wired it into the workspace `typecheck` script.

**Test quality — the mutation experiment.** The concurrency test was challenged as possibly vacuous. Verified by running its exact assertions against a deliberately broken `SELECT`-then-`UPDATE` allocator: it produced 98 serials but only **27 distinct**, and all three assertions (uniqueness, contiguity, `lastSeq === total`) failed. **The test genuinely detects a lost-update allocator.**

**Known gaps not yet closed** (carried into M5): no test drives an email send _failure_ (the retry/attempt-cap branch is unexecuted); no concurrent test of the `SKIP LOCKED` claim; no test that a post-allocation rollback leaves the sequence consistent; `env.ts` and `/health` have no tests; `apps/mobile` has no test suite at all. ~~`GET /batches` reads `status` off the query string unvalidated~~ — closed: the whole query string is parsed by `batchListQuerySchema`, and an unknown `scope` or `status` is now a 400.

---

## Batch-form change spec (2026-08-31)

A change spec written against an assumed **Next.js + Supabase** stack was implemented
against this one instead, per its own instruction to follow the codebase and flag the
conflict. The mapping, and the four places the codebase's model won:

| Spec asked for                                     | Built as                                                                 | Why                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_managers` table                           | The `ProjectManager` table that already existed                          | Same concept, already modelled                                                                                                                                             |
| `project_manager_id` FK **on the batch**           | FK stays on `Project`; batch snapshots `projectManagerEmail`             | A second FK could disagree with `project.projectManagerId`. The snapshot is what the spec actually needed it for — historical batches keeping the address that was emailed |
| Free-entered sites stored as **text on the batch** | A project-scoped `Site` row                                              | `Batch.siteId` is a non-null FK that transfer destinations, movement events and delivery notes all read. See the caveat below                                              |
| `created_at` as `timestamptz`                      | `Batch.createdAt` converted; the rest of the schema still `timestamp(3)` | A repo-wide conversion touches every model and was outside this change                                                                                                     |

**Caveat on free-entered sites.** The spec wanted them kept out of the sites list so
typos cannot pollute future dropdowns. Here a free entry necessarily becomes a `Site`
row, and `GET /sites` derives its options from that table — so a typo _is_ visible to
later comboboxes. Closing that gap properly means a `curated` flag on `Site` that
`GET /sites` filters on, which is a deliberate follow-up rather than something to
smuggle in.

**Three-layer validation.** The project-number format lives in one regex
(`packages/shared/src/projectNumber.ts`) consumed by the input mask, the API's zod
schema, and a `Project_projectNumber_format` CHECK constraint. The constraint is
`NOT VALID`: it binds every future write without rejecting numbers already recorded
under the old free-text rule — rewriting those would be inventing data.
`Batch_initialDeliveryPoint_enum` is a plain (validating) CHECK, because the migration
maps the old free text onto `STORES`/`SITE` first.

**One list, three tabs.** Transfer, Returns and History are `BatchBrowser` with a
different `scope`. The scope only ever _removes_ rows, each removal has its own toggle,
and filtering runs in the database — the list is capped at 200, so client-side filtering
would silently search only the newest page.

**The resend lock is claimed, not checked.** `POST /batches/:id/resend-email` puts the
60-second condition in the `UPDATE`'s `WHERE` and returns `RETURNING`, so two concurrent
taps produce one mail. Verified by mutation: replacing it with read-then-write makes both
requests return 202 and queue two emails, and `batchSpec.test.ts` catches it. Same lesson
as refresh-token rotation and the batch idempotency guard above.

**Mail.** `MAILER=resend` joins the existing pluggable transport rather than replacing
the `OutboundEmail` queue — the queue is what keeps a send failure from rolling back the
batch. `loadEnv` refuses to boot when a production mailer has no credentials.

---

## Initialization, batch photos, and History-as-events (2026-09-01)

Three connected changes. They are one entry because they share a spine: the system now
distinguishes **what somebody claims** from **what was evidenced**, at every step.

### 1. Batch initialization — the first scan

Creating a batch allocated serials and mailed a QR sheet. It never established that
anyone stuck a label on a cylinder, so every later scan rested on an assumption. A new
step closes that: `POST /initializations` records every printed label read back off its
own cylinder, where the batch stands, with a photo.

- **All-or-nothing, unlike a transfer.** A transfer of 3 of 7 cylinders is a real event
  — the other 4 genuinely did not move. A _partial_ initialization would instead leave
  the system unable to say whether cylinder 4 is unlabelled or merely unscanned, which
  is the precise ambiguity the step exists to remove. A submission that does not name
  every cylinder is refused `422 INCOMPLETE_INITIALIZATION`, listing what it missed, and
  `Batch.initializedAt` is one flag rather than a per-cylinder column.
- **It moves nothing.** One `INITIALIZE` MovementEvent per cylinder, whose `fromSiteId`
  and `toSiteId` are both the cylinder's current position. The movement log becomes a
  record of every time a cylinder was _seen_, not only of the times it went somewhere.
- **It gates everything downstream.** `POST /transfers` and `POST /returns` answer
  `409 BATCH_NOT_INITIALIZED`; `resolveScans` re-checks per serial as defence in depth
  (`NOT_INITIALIZED`); `GET /batches?scope=transfer|returns` drops uninitialized batches
  and `scope=initialize` shows only them. A cylinder with no sticker cannot honestly be
  scanned onto a truck, so those moves could only ever have been overrides — refusing
  says so instead of letting a batch run its whole life on assertions.
- **The idempotency key is claimed first**, before a single scan is evaluated. Same
  ordering, for the same reason, as M3's transfer route.

### 2. The batch photo

Every initialization, transfer and return now carries a photo of the batch, stamped with
position and both clocks. A scan proves _which cylinders_; it cannot prove they were
together, at the place the paperwork names — a phone can read forty labels off a desk.

- **One `BatchPhoto` table, three nullable owner FKs**, each `@unique`, plus a
  `BatchPhoto_exactly_one_owner` CHECK. Prisma cannot express "exactly one of these is
  non-null", and a photo attached to nothing (or to two events) is evidence pointing at
  no particular claim.
- **Both clocks are kept.** `capturedAt` is the device's, stored exactly as given even
  when implausible; `serverAt` is a database default. The gap between them is the only
  signal that a submission sat in an outbox overnight, so neither is allowed to correct
  the other.
- **Location is best-effort, and its absence is a recorded fact.** A fix can fail
  indoors, in a steel yard, or with location switched off. `latitude`/`longitude` are
  nullable and `locationError` says why — a missing fix is visibly missing, never
  silently rendered as 0°N 0°E. On device the fetch races an 8-second timeout so a
  hung GPS cannot hold the shutter; refusing the capture would strand a driver at a gate
  over a satellite.
- **The camera override mirrors the scan override.** An ADMIN may submit without a
  photo (`photoOverride`); every other role gets `403 PHOTO_OVERRIDE_FORBIDDEN` rather
  than a silent drop. `photoOverridden` is recorded on the event, so the trail says an
  admin waived it rather than showing something that looks photographed. A request
  carrying both a photo and an override keeps the photo — real evidence outranks an
  assertion, the same rule scanned serials already followed.
- **`bodyLimit` raised to 12 MB.** Fastify's 1 MiB default was already smaller than a
  valid return (a 2.8 MB-capped signature plus 500 scans) and would have rejected the
  heaviest, least reproducible field submissions with a bare 413 no schema message
  explains.
- **The image is shrunk on device**, to 1280px / JPEG 0.6 (~150–350 KB), because the
  base64 lives in the SQLite outbox until signal returns.

### 3. History became a feed of events

History was `BatchBrowser` with nothing hidden — a fourth copy of the Transfer/Returns
picker. A batch created, initialized, transferred twice and half-returned appeared as
**one row saying where it currently is**, which is the one question the other three tabs
already answer. It is now a chronology: every change is its own row (`CREATED`,
`INITIALIZED`, `TRANSFER`, `RETURN`, `AMENDED`), newest first, each opening to what that
change consisted of — its serials, and its photo's stamp.

- **Derived on read, not written to a log table.** The rows come from `Batch`,
  `BatchInitialization`, `Transfer`, `ReturnRecord` and `BatchAmendment`, merged and
  sorted in `services/historyFeed.ts`. A log table would be one query instead of five,
  but it would be a second source of truth — and the first time a route wrote the record
  and not the log entry, History would confidently describe things that did not happen.
  Deriving means it cannot disagree with the records it describes, and cannot be doctored
  without doctoring them (which itself writes a `BatchAmendment`, and so appears here as
  another row).
- **Read-only, structurally.** `GET /history` and `GET /history/events/:kind/:id` are
  the entire surface; a test asserts POST/PATCH/PUT/DELETE all 404 even for an admin.
  Corrections stay in the admin console. The admin's _shortcut_ into that console
  remains on the batch-detail screen — the screen is a link, not an editor.
- **The detail screen re-runs the feed narrowed to one record** rather than
  hand-writing a second summariser. That is what guarantees the detail header says
  exactly what the row the user tapped said.
- **The photo comes back base64 through the authenticated fetch** (`GET
/batch-photos/:id`), not as an image URL. Every call to this API needs an
  `Authorization` header and, on react-native-web, `<Image>` is a plain `<img src>` that
  cannot send one. The alternatives were a token in the query string — which lands in
  access logs and browser history — or a second cookie-based auth path.

### Consequences elsewhere

- **`INITIALIZE` is not history, for admin corrections.** `assertLineUntouched` and the
  droppable-cylinder filter previously treated any non-`INTAKE` movement event as
  evidence. Since initialization is now mandatory before anything can move, that would
  have made _every batch in a usable state_ uncorrectable. Both predicates now accept
  `INTAKE` and `INITIALIZE`: a correction is refused because a cylinder went somewhere,
  not because somebody looked at it.
- **Adding cylinders un-initializes the batch.** `Batch.initializedAt` means "every
  cylinder here has had its label scanned back off it". An admin growing a line adds
  cylinders whose labels have not even been printed, so the flag is cleared and the
  amendment records it — otherwise a cylinder nobody ever saw could leave the yard on a
  scan somebody did of a different cylinder last week.

### A latent migration bug, fixed on the way through

`prisma migrate dev` could not build a shadow database at all, which blocked authoring
any new migration. `20260901093921_multi_gas_batches_and_admin` drops the
`Transfer_projectManagerId_fkey` constraint that `20260901120000_…` — hand-written, and
named with a **later** timestamp — is what creates. Migrations replay in filename order,
not in the order they were first applied, so on any fresh database the drop ran first and
died with `42704`. Every `migrate deploy` onto an empty database was already broken; it
was invisible because the only database anyone had applied them to had them in the other
order.

Its net effect was also nil, since `20260901130000_transfer_pm_fk_restrict` replaces the
same constraint again. Deleting the file would invalidate the history of any database
that already recorded it, so it is **guarded** instead — wrapped in an
`IF EXISTS (SELECT 1 FROM pg_constraint …)` block that is a no-op on a fresh database and
byte-identical in outcome on an old one. The local `_prisma_migrations.checksum` was
updated to match the rewritten file (Prisma stores the plain SHA-256 of `migration.sql`).

### Tests

**286 green** (shared 39 · api 212 · mobile 35), up from 218.
`apps/api/test/initializations.test.ts` (22) covers the happy path, the photo's stamp and
both clocks, a fix that failed, the image round-trip, idempotent replay, the partial and
already-initialized refusals, both overrides for both roles, the gate on transfers and
returns and the pickers, and the two admin-correction interactions.
`apps/api/test/history.test.ts` gained the feed, its filters, the detail endpoint and the
read-only assertion. `apps/mobile/test/photoCapture.test.ts` (7) pins the location policy:
every failure mode — permission refused, services off, module throwing, no fix in time —
comes back as a recorded reason rather than an exception or a silent zero.

---

## Verification commands

```bash
docker compose up -d                     # Postgres + MailHog
npm install                              # clean: rm -rf node_modules package-lock.json first
npm run -w @gct/api db:migrate:deploy    # apply migrations (migrate dev can hang on its post-step here; deploy is reliable)
npm run -w @gct/api db:seed
npm test                                 # 218 tests: @gct/shared (37) + @gct/api (153) + @gct/mobile (28)
npm run -w @gct/api start & curl -s localhost:3000/health   # -> {"status":"ok","db":"up"}
# auth smoke: POST /auth/login {"email":"admin@demo.local","password":"Passw0rd!"} -> tokens
# QR sheets land in MailHog at http://localhost:8025 a few seconds after POST /batches
cd apps/mobile && npx expo-doctor        # 21/21
cd apps/mobile && npx expo start --tunnel # scan with Expo Go on an Android phone
cd apps/mobile && eas build -p android --profile preview   # shareable APK — see docs/BUILD_APK.md
```

**QR signing keys:** `apps/api/.env` holds a dev Ed25519 pair (`QR_SIGN_PRIVATE_KEY_HEX` /
`QR_SIGN_PUBLIC_KEY_HEX`); `apps/mobile/.env`'s `EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY` carries the
public half so the M3 scanner can reject forged codes offline. Regenerate with
`npx tsx apps/api/scripts/gen-qr-keys.ts` — rotating invalidates already-printed labels.

**Device testing note:** `EXPO_PUBLIC_API_URL` defaults to `http://localhost:3000`, which a
physical phone cannot reach. For `expo start --tunnel`, set `apps/mobile/.env`'s
`EXPO_PUBLIC_API_URL` to the machine's reachable URL — in this Codespace, the forwarded-port
public URL for `:3000` (make the port **public** in the Ports panel).

Demo logins (all password `Passw0rd!`): `admin@demo.local` (ADMIN),
`stores@demo.local` (STORES_MANAGER), `technician@demo.local` (TECHNICIAN).
