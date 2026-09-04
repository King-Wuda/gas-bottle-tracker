import Constants from 'expo-constants';

const FALLBACK_API_URL = 'http://localhost:3000';

/**
 * The origin the page itself was served from, when there is one.
 *
 * The API serves the web export at `/app` on its own origin (see `SERVE_WEB_APP` in
 * `app.ts`), so in a browser the API is always exactly where the page came from. That
 * makes the deployed bundle portable: the same `dist-web` works on a Codespace
 * forwarded URL, on Render, and on any hostname later, with no rebuild and no
 * build-time secret to get wrong.
 *
 * Guarded by feature detection rather than `Platform.OS` on purpose — `window` exists
 * in React Native but `window.location` does not, so this is `null` on the device
 * without needing a platform branch to say so.
 */
function servingOrigin(): string | null {
  const origin = (globalThis as { location?: { origin?: string; protocol?: string } }).location
    ?.origin;
  // `file://` and `about:` origins stringify to "null"; neither is somewhere an API
  // lives, so fall through to the explicit value.
  return origin && origin.startsWith('http') ? origin : null;
}

/**
 * API base URL, in order of precedence:
 *
 * 1. `EXPO_PUBLIC_API_URL`, inlined at bundle time. Required for the APK, which has
 *    no serving origin of its own, and available to override the rest.
 * 2. `extra.apiUrl` from app.json.
 * 3. The origin the page was served from — the ordinary case for the web build,
 *    including the live site.
 * 4. `http://localhost:3000`, for a dev bundle loaded from the Metro server.
 */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  servingOrigin() ??
  FALLBACK_API_URL;

const isStandalone = Constants.executionEnvironment === 'standalone';

/**
 * M5: a shareable APK built without `EXPO_PUBLIC_API_URL` bakes in `localhost`, which
 * on a phone resolves to the phone itself. Every request then fails with a bare
 * network error that reads like "the server is down" — the single most expensive way
 * for a field build to be wrong. Say so on the sign-in screen instead of letting a
 * technician debug it in a yard.
 */
export const configWarning: string | null = isStandalone
  ? API_URL === FALLBACK_API_URL
    ? `This build has no API address (it defaults to ${FALLBACK_API_URL}, which on a phone means the phone itself). Rebuild with EXPO_PUBLIC_API_URL set in the eas.json build profile.`
    : !process.env.EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY
      ? 'This build has no QR verification key, so scanned labels cannot be checked offline. Rebuild with EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY set.'
      : null
  : null;
