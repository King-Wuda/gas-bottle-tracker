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

The last two branch inside `expo-camera` / `expo-location` / `expo-image-manipulator` rather
than in our own `Platform.OS` check, which makes them easier to forget — there is no visible
`if` in our source. See [docs/WEB_PARITY.md](docs/WEB_PARITY.md) for what each does differently.

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
2. `npm run typecheck && npm run lint && npm test` — 286 tests baseline
   (39 shared, 212 API, 35 mobile).
3. If the change touched a `Platform.OS` file above, state in your summary what the native
   path does differently and why it is still correct.
