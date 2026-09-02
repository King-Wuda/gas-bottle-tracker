# The web build, and keeping it in parity with the app

## Why we test on the web

This project is an **Android field app**. It is tested through the browser anyway, because the
user's phone is an iPhone and Expo Go cannot run this project on iOS:

|                          |                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------- |
| Expo Go on the App Store | **54.0.2**, last updated **2025-09-23** (identical in the US, GB and ZA stores) |
| This project             | **SDK 57** — the dev server advertises `runtimeVersion: "exposdk:57.0.0"`       |

Expo Go for iOS has not been updated in roughly a year. Expo does publish an SDK 57 iOS client
(`57.0.9`), but only as a simulator `.tar.gz` on GitHub, which needs a Mac and Xcode — it never
reaches the App Store. Re-installing Expo Go cannot fix this; 54.0.2 is the newest that exists.

The alternatives, for the record:

- **Android device** — Expo Go 57.0.9 ships as a directly sideloadable APK and gives full
  fidelity. This is the best option whenever an Android device is available.
- **EAS development build for iOS** — the real fix for iPhone testing. Needs an Apple Developer
  Program membership ($99/yr), plus an `ios.bundleIdentifier` and camera usage string in
  `app.json` and an iOS profile in `eas.json`. None of that exists yet; the project is
  configured Android-only.
- **Downgrading to SDK 54** — would restore Expo Go, but rolls back three SDK versions
  (React Native 0.86.3 to ~0.81) across every pinned dependency. Not recommended.

## Running the web version

```bash
npm run dev:api                          # API on :3000, also serves the web export at /app
npm run -w @gct/mobile export:web        # rebuild the static bundle
```

Then open the app at **`/app`**. In a Codespace that means the _forwarded_ URL, not localhost:

    https://<codespace-name>-3000.app.github.dev/app

`http://localhost:3000/app` only works from inside the Codespace. A browser on your own machine
has nothing listening on port 3000 and fails with `ERR_CONNECTION_REFUSED` — this is the single
easiest way to waste ten minutes here. Get the URL from the **Ports** panel in VS Code, or with
`gh codespace ports`.

From your own browser the forwarded port can stay **private** — you are signed in to GitHub.
To reach it from a phone or another device, port 3000 must be **public**, or the device gets a
302 to a GitHub login page:

```bash
gh codespace ports visibility 3000:public -c <codespace-name>
```

`SERVE_WEB_APP=../mobile/dist-web` in `apps/api/.env` is what mounts the export at `/app`.
Serving it from the API's own origin is deliberate: the web bundle then calls the API
same-origin, so CORS never enters into it.

## The rule

**Any change made or tested against the web version must also be applied to the native app
version, in the same change.** The web build is a testing surface. The Android APK is the
deliverable, and it must not drift.

This is mostly automatic — `apps/mobile/app/` and `apps/mobile/src/` compile to both targets
from one source. Divergence is confined to files that branch on `Platform.OS`:

| File                                       | Web                              | Native                     |
| ------------------------------------------ | -------------------------------- | -------------------------- |
| `src/db/index.ts`                          | in-memory store                  | expo-sqlite                |
| `src/auth/tokenStore.ts`                   | `localStorage`                   | expo-secure-store          |
| `app/queue.tsx`                            | `confirm()`                      | `Alert.alert`              |
| `src/components/Scanner.tsx`               | getUserMedia + `BarcodeDetector` | native camera scanner      |
| `app/login.tsx`, `app/new/create-site.tsx` | no-op                            | iOS `KeyboardAvoidingView` |

Three of these branch inside a dependency rather than in our own `Platform.OS` check —
`expo-camera`, `expo-location` and `expo-image-manipulator` each ship a `.web` implementation.
That is _more_ dangerous, not less, because there is no visible `if` in our source to remind
anyone the two paths differ. What they differ in is set out below.

## What the web build cannot tell you

Passing on web does **not** mean passing on device. Seven things genuinely differ:

1. **Offline persistence.** `src/db/index.ts` falls back to `createMemoryStore()` on web, so
   the outbox is wiped by a page reload. On device it is SQLite and survives a restart. Any
   sync-queue or offline-durability behaviour must be reasoned through on the SQLite path —
   the browser cannot demonstrate it.
2. **QR scanning.** Native uses the platform scanner. Web uses `getUserMedia` plus the
   `BarcodeDetector` API, falling back to the `barcode-detector` polyfill (a transitive
   dependency of `expo-camera`) in browsers without it — Safari among them. That fallback path
   is unverified in a real browser; if scanning fails on Safari, check whether the polyfill
   chunk actually loads before suspecting the app.
3. **Token storage.** `localStorage` on web is readable by any script on the origin;
   expo-secure-store on device is Keychain/Keystore-backed. Never conclude anything about token
   security from web behaviour.
4. **`Alert` is a no-op on react-native-web.** A confirmation that appears to work on device
   silently does nothing in the browser unless it has an explicit web branch.
5. **Photo capture resolution.** `CameraView.takePictureAsync` returns a `file://` URI from the
   device camera on Android and a canvas-drawn data URL on web. The web frame comes out of the
   `getUserMedia` stream — typically 640×480 or 1280×720 — so a browser photo is _at or below_
   the 1280px cap `compressForUpload` applies, while a phone shot is a several-megapixel image
   being shrunk to it. A payload size that looks fine in the browser can be several times larger
   on device; the cap and the JPEG quality in `src/photo/capture.ts` are what actually bound it.
6. **Geolocation needs a secure context on web.** `expo-location` on web is
   `navigator.geolocation`, which browsers refuse outside HTTPS or `localhost`. A Codespace
   forwarded URL is HTTPS, so it works — but a plain-HTTP host would silently produce photos
   with `locationError` set on every capture, while the same build on device is unaffected.
   `hasServicesEnabledAsync` on web only answers "does this browser have the API", never "is
   location switched on", so that branch is effectively untestable in a browser.
7. **A queued photo does not survive a reload on web.** This is (1) again, but it matters more
   now: the outbox row for a transfer carries its JPEG as base64, and on web that lives in
   memory. Reloading the page loses the photo along with the submission. On device both are in
   SQLite and survive a restart, which is the behaviour the field depends on.

## Checklist before calling a mobile change done

1. `npm run -w @gct/mobile export:web` — the browser serves a static export, so an un-exported
   change is invisible and you will be testing stale code.
2. `npm run typecheck && npm run lint && npm test`.
3. If the change touched a `Platform.OS` file above — or anything going through the camera,
   the location, or the image manipulator — say in the summary what the native path does
   differently and why it remains correct.
