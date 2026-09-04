# Building a shareable Android APK

Produces an installable `.apk` a colleague can sideload — no Play Store, no Expo Go.
Profiles live in [`apps/mobile/eas.json`](../apps/mobile/eas.json).

| Profile       | Output           | Use                                                        |
| ------------- | ---------------- | ---------------------------------------------------------- |
| `development` | APK (dev client) | Native debugging with the Metro dev server attached        |
| `preview`     | **APK**          | **The shareable build** — internal distribution, no server |
| `production`  | AAB              | Play Store submission (an AAB cannot be sideloaded)        |

`preview` is the one you want. `production` deliberately emits an app bundle, so do not
reach for it when someone asks for "the APK".

## The one thing that will bite you

`apps/mobile/.env` is **gitignored**, and EAS only uploads files git tracks. A build that
relies on it silently bakes in the defaults:

- `EXPO_PUBLIC_API_URL` falls back to `http://localhost:3000`, which **on a phone means the
  phone itself** — every request fails with a bare network error that reads like the server
  being down.
- `EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY` falls back to unset, so the scanner cannot reject a
  forged label offline.

Both values are public by definition (a base URL and an Ed25519 _public_ key), so put them
in the profile's `env` block in `eas.json` before building:

```jsonc
"preview": {
  "distribution": "internal",
  "android": { "buildType": "apk" },
  "env": {
    "EXPO_PUBLIC_API_URL": "https://api.example.com",     // must be reachable from the phone
    "EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY": "614daf…22e3"     // public half of the API's QR key
  }
}
```

The committed values are placeholders. `src/config.ts` detects this case at runtime and
prints the reason on the sign-in screen (`configWarning`) rather than letting a technician
debug it in a yard — but the build is still wrong, so fix the profile.

> Prefer `eas env:create --environment preview` if you would rather not commit the URL. Both
> paths reach the bundler the same way.

## Build it

```bash
npm i -g eas-cli                          # or use npx eas-cli
cd apps/mobile
eas login
eas build:configure                       # first time only — links the project, writes the EAS projectId
eas build --platform android --profile preview
```

EAS builds in the cloud and prints a download URL when it finishes (~10–20 min for a first
build). `appVersionSource: "remote"` means EAS owns `versionCode`, so consecutive builds
increment without touching `app.json`.

For a local build instead (needs Android SDK + JDK 17):

```bash
eas build --platform android --profile preview --local
```

## Install

Download the `.apk` on the device and open it; Android asks to allow installs from that
source. Or over ADB:

```bash
adb install -r ./gct-preview.apk
```

## Before you hand it out

The API must be reachable from the phone's network — a Codespaces forwarded port works only
while it is public and the Codespace is running. Check, in this order:

1. Sign-in screen shows **no** configuration warning.
2. Sign in as a seeded user (`stores@demo.local` / `password`).
3. Dashboard → History → look up a known serial. That single round trip proves the API URL,
   auth, and TLS all work.
4. Turn on airplane mode, complete a transfer, confirm it lands in the sync queue, then turn
   the network back on and confirm the queue drains.

## Related

- Version pinning rules (never `npm view` an Expo package): [BUILD_BLUEPRINT.md](BUILD_BLUEPRINT.md)
- Outbox / offline design: [OFFLINE.md](OFFLINE.md)
