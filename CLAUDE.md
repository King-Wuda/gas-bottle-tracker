# CLAUDE.md

Guidance for Claude Code sessions working in this repo.

## The web build and the native app are ONE app — keep them in parity

The user tests this project through the **web build** (the Expo web export, served by the API
at `/app`), not through the native app. This is not a preference — it is forced. Expo Go on
iOS is frozen at SDK 54 (App Store 54.0.2, last updated 2025-09-23) while this project is on
SDK 57, so an iPhone cannot load the native app at all. Full background and the verification
that established it: [docs/WEB_PARITY.md](docs/WEB_PARITY.md).

**THE RULE — any change made or tested against the web version must ALSO be applied to the
native app version, in the same change.** The web build is a _testing surface_, never a
separate product. Do not fix something on web and move on; the Android APK is the actual
deliverable and it must not silently drift.

Most code already satisfies this for free: everything under `apps/mobile/app/` and
`apps/mobile/src/` compiles to both targets from the same source. The risk is confined to the
files that deliberately branch on `Platform.OS`. After any mobile change, check whether it
touches one of these:

| File                                          | Web                                  | Native                     |
| --------------------------------------------- | ------------------------------------ | -------------------------- |
| `apps/mobile/src/db/index.ts`                 | in-memory store (does not persist)   | expo-sqlite                |
| `apps/mobile/src/auth/tokenStore.ts`          | `localStorage`                       | expo-secure-store          |
| `apps/mobile/app/queue.tsx`                   | `confirm()`                          | `Alert.alert`              |
| `apps/mobile/src/ui/confirm.ts`               | `confirm()` / `prompt()`             | `Alert.alert` / `.prompt`  |
| `apps/mobile/src/components/Scanner.tsx`      | getUserMedia + BarcodeDetector       | native camera scanner      |
| `apps/mobile/src/components/PhotoCapture.tsx` | canvas frame from getUserMedia       | device camera file         |
| `apps/mobile/src/photo/capture.ts`            | `navigator.geolocation` (HTTPS only) | Play Services / GPS        |
| `apps/mobile/app/login.tsx`                   | (no-op)                              | iOS `KeyboardAvoidingView` |
| `apps/mobile/app/new/create-site.tsx`         | (no-op)                              | iOS `KeyboardAvoidingView` |
| `apps/mobile/src/components/IdCapture.tsx`    | getUserMedia frame                   | device camera file         |
| `apps/mobile/src/components/SignaturePad.tsx` | needs `touchAction: 'none'`          | style key ignored          |
| `apps/mobile/src/sound/index.ts`              | blocked until a user gesture         | plays whenever asked       |

None of the last five branch on `Platform.OS` in our own source — they differ inside
`expo-camera` / `expo-location` / `expo-image-manipulator` / `expo-audio`, or in what the
browser will allow — which makes them the easiest of all to forget, because there is no
visible `if` to notice. See [docs/WEB_PARITY.md](docs/WEB_PARITY.md) for what each does
differently.

Two things deliberately have NO platform path at all, and should be kept that way:

- **The signature raster.** `src/signature/png.ts` and `raster.ts` encode the PNG in plain
  TypeScript rather than using a canvas on web and a screenshot library on device, so the
  driver's signature is byte-identical on both targets. A canvas would have been three lines;
  it would also have meant the signature under test was never the signature that ships.
- **The sound cues.** `expo-audio` has a real web implementation, so both targets play the
  same two WAV files through the same code.

Two traps that cause silent divergence:

- **`Alert` is a no-op on react-native-web.** It does not throw and does not warn — the
  promise simply never settles, so the action is silently swallowed on the surface this
  project is tested on. **Use `src/ui/confirm.ts`** (`confirmAction`, and `confirmByTyping`
  for anything destructive) rather than writing the branch again; three screens had grown
  their own copy before it was extracted. `Alert.prompt` is worse — it is iOS-only, so
  `confirmByTyping` degrades to a plain confirm on Android.
- **The offline outbox does not persist on web.** A sync-queue behaviour that looks correct in
  the browser may still be wrong on device, where the queue survives a restart. Reason
  through the SQLite path explicitly; do not infer it from web behaviour. This now matters
  more: every transfer, return and initialization carries a base64 JPEG in its outbox row, so
  a page reload on web loses the photo along with the submission.
- **A browser photo is much smaller than a phone photo.** The web capture comes out of the
  `getUserMedia` stream (typically ≤1280px), so it is already at or under the cap
  `src/photo/capture.ts` applies; a device shot is several megapixels being shrunk to it.
  Payload sizes seen in the browser are not evidence about the APK.
- **The device SQLite cache tables need a migration; the web one never does.**
  `apps/mobile/src/db/sqliteStore.ts` builds its tables with `CREATE TABLE IF NOT EXISTS`,
  which is a silent no-op on a device that already holds the previous shape. Change a
  column on `cached_batch` / `cached_cylinder` / `cached_site` and you MUST bump
  `CACHE_SCHEMA_VERSION`, which drops and rebuilds them (they are a server mirror, so
  dropping is safe — `outbox` is deliberately never dropped). The web build backs the same
  interface with memory and is therefore always "migrated", so this class of bug is
  invisible on the surface the app is tested on and breaks only on the APK.

## A client owns its sites; a project is a job for a client

`Site` used to belong to `Project`, so the same customer's Durban existed once per job:
"Delmas" under 4521 and "Delmas" under 4522 were unrelated rows that happened to share a
spelling. Nothing could answer "which sites does McCains have?", every new project
re-typed them, and a misspelling was invisible forever.

Now `Client` owns `Site`, and `Project` points at the client. Three consequences worth
knowing before touching this area:

- **The batch form's two boxes are the client and the place.** "Site" is McCains and
  "Location" is Durban — the second box is scoped to whatever client the first names.
  Both read `GET /clients`, which IS the directory, not a `SELECT DISTINCT` over past
  batches.
- **The DTOs still say `siteName` and `siteLocation`**, sourced from `client.name` and
  `site.location`. That was deliberate: the delivery note, QR sheet, email worker and
  every history screen render unchanged. Do not "fix" the naming without accounting for
  those.
- **Ownership checks are by CLIENT.** A batch's site must belong to its project's
  client, and a transfer destination must be one of that client's sites. Both are the
  old rules stated in the new model's terms, and both are stronger than before.

Adding a place is idempotent and case-insensitive, so "durban" joins Durban instead of
founding a second one. `POST /projects/:id/sites` survives as a convenience that
resolves to the client.

## Project managers ARE the admins — there is no separate admin account

There used to be an ADMIN role on `User` (runs the console) and an unrelated
`ProjectManager` table (an email address paperwork went to), so the same person existed
twice and a project manager could not sign in. Now the role is `PROJECT_MANAGER`, and a
project manager is one person held in two rows:

- **`ProjectManager.userId` is required and unique.** Every manager record has a login
  behind it, and the database enforces it. Batches, projects and transfers still point
  at `ProjectManager` — the table was kept, not folded into `User`, because its rows
  outlive the account differently (a deleted manager keeps a row so delivery notes still
  name them).
- **Only `/admin/project-managers` creates, edits, deactivates or deletes one**, writing
  name, email and active to both rows in a transaction. `/admin/users` lists and manages
  staff only (`staffRoleSchema`): it refuses `PROJECT_MANAGER` as a role and answers
  `IS_PROJECT_MANAGER` for one, because either route through it would leave a login and
  a manager record out of step.
- **The lockout guards live on the manager routes**: you cannot deactivate or delete
  yourself, and the last active project manager cannot be removed.

## Transfers repeat; a return is final

- **A transfer** moves cylinders between stores and a site, as often as needed. Both
  directions take full driver sign-off (name, phone, ID number, ID photo, signature)
  and a batch photo, and every transfer emails the batch's project manager a
  `TRANSFER_NOTICE` with the batch photo and the driver's ID attached.
- **A return** sends cylinders back to the SUPPLIER. It is terminal (`RETURNED`): the
  cylinder leaves rotation, leaves its cage, and stops counting anywhere. It is labelled
  "Return to supplier" in the app because "Returns" alone reads as "back to stores",
  which is a transfer. Don't merge the two.

**Cages and full/empty live on the cylinder, and only in stores.** `Cylinder.cage` is
1-3 and the `Cylinder_cage_only_in_stores` CHECK refuses one on anything not
`IN_STORES`, so every path that moves a cylinder out of stores must clear it (the
transfer and return claims set `"cage" = NULL`). Cages are chosen **per gas, per
drop-off** — every argon cylinder in one drop-off goes into the same cage — at
initialization (only for lines delivered to STORES; every cylinder is recorded
`IN_STORES` at intake, but a SITE line's cylinders are physically on site) and on every
transfer back to stores. Everything is booked in `FULL`; a transfer back to stores is
the one moment contents change (`emptySerials`, everything else is set FULL).
`MovementEvent.cage`/`contents` snapshot it for History and the email.

A transfer's cages are checked against what actually MOVED, after the claim
(`checkCages(..., { allowExtra: true })`): a cage for a gas whose cylinders were all
rejected is not an error. An initialization's are checked up front and extras refused.

`cached_cylinder` carries `gas_type_id` and `delivery_point` for this, offline —
`CACHE_SCHEMA_VERSION` 4.

## QR labels: eight to an A4 sheet, 5 mm apart

The QR sheet (`renderQrSheet` in `apps/api/src/services/pdf.ts`) prints 8 labels per A4
page, 2 across × 4 down, with 5 mm between every label and between the labels and each
edge of the paper — no header. The label size is DERIVED from that (97.5 × 68 mm): the
sheet is the single `LABEL_SHEET` constant (`cols`, `rows`, `margin`, `gap`, in mm), and
`labelSize()` / `labelSlots()` compute the rest, so changing the spacing or the count
resizes the labels without touching the drawing code. `test/qrLabels.test.ts` pins the
8 labels and the 5 mm. Labels must be printed at 100% ("Actual size").

## Passwords: everyone starts on `gea`, and changes their own

`DEFAULT_PASSWORD` (`gea`, in `packages/shared/src/schemas/auth.ts`) is what the seed,
both console add-forms, and the console's "Reset password to gea" actions use, and
migration `20261118130000_reset_all_passwords_to_gea` set every live account to it once.
From there each person changes their own from the dashboard's "Change password"
(`POST /me/password`), which:

- **asks for the current password** even though the caller is signed in, and answers a
  wrong one with **400 `WRONG_PASSWORD`, not 401** — a 401 makes the app's client
  refresh its token and retry the same wrong password;
- **ends every session the account holds and returns a fresh pair** for the device that
  made the change. `apiChangePassword` installs that pair itself; without it the next
  request would hit a revoked refresh token and sign the person out.

Resetting goes back to `gea` rather than to a password the admin chooses, on purpose:
it is the one everybody already knows to try. Don't make that migration re-run — it is
a one-off, and a password someone set afterwards must survive later deploys.

## Deleting is the one place evidence may be destroyed — treat it as such

Every foreign key into the movement log is `onDelete: Restrict`, deliberately, so that
nothing can quietly erase the trail. `apps/api/src/services/adminDelete.ts` is the single
sanctioned exception, and three things about it are load-bearing:

- **The order is not stylistic.** Photos point at the transfer/return/initialization they
  evidence; movement events point at all three plus the cylinder; cylinders point at the
  line they were allocated from. Reorder these and the database refuses partway through.
- **The CHECK constraints decide what "detach" means.** `Cylinder_deployed_has_site` and
  `Transfer_site_destination_has_site` mean a record that outlives a deleted site cannot
  simply have its site nulled — a DEPLOYED cylinder must also be stood down to
  `IN_STORES`, and a SITE-bound transfer cannot survive its destination at all. Both were
  found by tests, not by reading the schema.
- **Nothing deletes without a preview.** Every entry point has a matching `*Impact()` and
  an `/impact` route so the screen can say what will go before it goes. A new delete that
  skips this is not finished.

**Users and project managers are the deliberate exceptions to the cascade.**
`Batch.createdByUserId` and `Batch.projectManagerId` are REQUIRED, so cascading either
would delete batches belonging to other clients — every job that person booked in, or
every delivery note addressed to them. Both are destroyed as records and kept as names.
Don't "fix" that asymmetry.

**Clients and projects delete along different seams**, and have separate screens for it.
A client and its locations are reference data; deleting a CLIENT takes their projects
and every delivery too. Deleting a PROJECT takes one job and leaves the customer alone.

## The look is a system, not a set of screens

`apps/mobile/src/ui/theme.ts` holds every colour, gap, radius, shadow and text style
the app uses, and `ui/components.tsx` builds the shared kit from them. Two rules keep
it coherent:

- **No screen invents a colour or a spacing.** If a value is not in `theme.ts`, either
  reuse one that is or add it there. A hex code in a screen is how twenty screens end
  up twenty slightly different shades of blue.
- **Colour means one thing.** Blue is _action_, green is _physically scanned_, amber is
  _an admin's assertion in place of evidence_, red is _failed_. The scan step, the
  overrides and the delivery note all lean on that distinction; a green tick next to a
  set of overrides would say "proved" about the one case that is not.

The app is pinned to `userInterfaceStyle: light` in `app.json`. It is read outdoors at
arm's length, and a half-themed dark mode reads as a broken app rather than a missing
feature. Adding dark mode means doing every screen, not most of them.

Icons are SVG paths in `ui/icons.tsx`, drawn on a 24x24 grid with a 1.8 stroke —
`react-native-svg` is already a dependency for the signature pad, so they cost nothing
and render identically on both targets.

## Rebuild the web export after every mobile change

The browser serves a **static export**, so source edits are invisible until you re-export:

```bash
npm run -w @gct/mobile export:web
```

This bakes `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY` from
`apps/mobile/.env` into the bundle at build time. If those are missing the app builds fine and
then fails at runtime with bare network errors — verify they are present in the output bundle
when the export looks right but the app cannot reach the API.

## Before calling a mobile change done

1. `npm run -w @gct/mobile export:web` — reflect it on the surface the user actually tests.
2. **Restart the API.** `@fastify/static` is registered with `wildcard: false`, which walks
   `dist-web` and registers one route per file _at boot_. After an export the bundle has a
   new content-hashed name, no route matches it, and the SPA fallback serves `index.html` in
   its place — so the browser gets HTML where it asked for JavaScript and the app is a blank
   white page with `Unexpected token '<'` in the console. Nothing about the export looks
   wrong; only the restart fixes it.
3. `npm run typecheck && npm run lint && npm test` — 469 tests baseline
   (75 shared, 329 API, 65 mobile). **Stop the dev API server first**: it shares the database
   with the test run, and its email worker polling across `resetDb()` fails tests at random.

   **`npm test` also empties the database you were demonstrating.** The suite shares it,
   truncates `ProjectManager` (`resetDb` recreates rows for the project-manager logins it
   keeps), and leaves its own `@demo.local` accounts and throwaway suppliers behind. Put it back with:

   ```bash
   npm run -w @gct/api reset:data -- --yes && npm run -w @gct/api db:seed
   ```

4. If the change touched a `Platform.OS` file above, state in your summary what the native
   path does differently and why it is still correct.
