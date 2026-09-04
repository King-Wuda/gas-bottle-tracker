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

/** Does this URL point at the machine the code is running on? */
const isLoopback = (url: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);

/**
 * Which API address to actually use.
 *
 * The configured value normally wins — it is the only way to point the APK at
 * anything, and the only way to run the web build against a different host.
 *
 * The exception is the one that keeps costing people an evening: a configured
 * `http://localhost:3000` is meaningless to a browser that is not on the server.
 * "localhost" there means the VIEWER's machine, so a phone, a laptop, or anything
 * opening a Codespace forwarded URL asks itself for the API and reports a bare
 * network error that reads exactly like "the server is down". When the page is being
 * served from a real remote origin and the configured API is loopback, the configured
 * value is provably wrong and the serving origin is provably right — the API is what
 * served the page. So the origin wins, and `configNote` says that it did.
 *
 * A configured value that is NOT loopback is always honoured: that is someone
 * deliberately splitting the web build from its API, and this has no business
 * second-guessing it.
 */
function resolveApiUrl(): { url: string; overrodeLoopback: boolean } {
  const configured =
    process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra?.apiUrl as string | undefined);
  const origin = servingOrigin();

  if (configured && origin && isLoopback(configured) && !isLoopback(origin)) {
    return { url: origin, overrodeLoopback: true };
  }
  return { url: configured ?? origin ?? FALLBACK_API_URL, overrodeLoopback: false };
}

const resolved = resolveApiUrl();

/**
 * API base URL, in order of precedence:
 *
 * 1. `EXPO_PUBLIC_API_URL` (or `extra.apiUrl`), inlined at bundle time — unless it is
 *    a loopback address and the page came from somewhere else. See `resolveApiUrl`.
 * 2. The origin the page was served from — the ordinary case for the web build,
 *    including the live site.
 * 3. `http://localhost:3000`, for a dev bundle with nothing else to go on.
 */
export const API_URL: string = resolved.url;

/**
 * Said out loud in the console, because it is the difference between "the app is
 * broken" and "the address it was built with does not apply here".
 */
export const configNote: string | null = resolved.overrodeLoopback
  ? `EXPO_PUBLIC_API_URL is ${process.env.EXPO_PUBLIC_API_URL ?? 'a loopback address'}, which cannot be reached from this browser. Using ${API_URL} instead — the origin this page was served from.`
  : null;

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
