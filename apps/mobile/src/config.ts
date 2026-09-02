import Constants from 'expo-constants';

const FALLBACK_API_URL = 'http://localhost:3000';

/**
 * API base URL. `EXPO_PUBLIC_API_URL` is inlined at bundle time.
 * - Simulator / web: http://localhost:3000
 * - Physical device via `expo start --tunnel`: set this to the machine's
 *   reachable URL (e.g. the Codespaces forwarded-port URL for :3000).
 * - Standalone APK: set it in the eas.json build profile's `env` (or via
 *   `eas env:create`). `.env` is gitignored, so EAS does NOT upload it.
 */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
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
