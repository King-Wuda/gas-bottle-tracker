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
| `apps/mobile/app/admin/users.tsx`             | `confirm()`                          | `Alert.alert`              |
| `apps/mobile/app/admin/project-managers.tsx`  | `confirm()`                          | `Alert.alert`              |
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

- **`Alert` is a no-op on react-native-web.** Any new `Alert.alert` needs the same
  `Platform.OS === 'web'` fallback that `app/queue.tsx` already uses, or it does nothing on
  web with no error.
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
3. `npm run typecheck && npm run lint && npm test` — 359 tests baseline
   (63 shared, 242 API, 54 mobile). **Stop the dev API server first**: it shares the database
   with the test run, and its email worker polling across `resetDb()` fails tests at random.

   **`npm test` also empties the database you were demonstrating.** The suite shares it,
   truncates `ProjectManager` (so the two real ones vanish until re-seeded), and leaves
   its own `@demo.local` accounts and throwaway suppliers behind. Put it back with:

   ```bash
   npm run -w @gct/api reset:data -- --yes && npm run -w @gct/api db:seed
   ```

4. If the change touched a `Platform.OS` file above, state in your summary what the native
   path does differently and why it is still correct.
