import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const ACCESS = 'gct.accessToken';
const REFRESH = 'gct.refreshToken';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * expo-secure-store is native-only — on web its methods are undefined and calling
 * them throws ("getValueWithKeyAsync is not a function"). Fall back to localStorage
 * there.
 *
 * This is a deliberate downgrade, not an oversight: the browser has no keychain
 * equivalent, so web tokens are readable by any script on the origin. The field app
 * ships as an Android build where SecureStore (Keystore-backed) is used; web is for
 * demos and a future admin view, and access tokens are short-lived (15 min) with
 * refresh tokens revocable server-side.
 */
const web = {
  getItem: async (k: string): Promise<string | null> => {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null; // private mode / storage disabled
    }
  },
  setItem: async (k: string, v: string): Promise<void> => {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* non-fatal: the session just won't survive a reload */
    }
  },
  removeItem: async (k: string): Promise<void> => {
    try {
      globalThis.localStorage?.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const store =
  Platform.OS === 'web'
    ? web
    : {
        getItem: (k: string) => SecureStore.getItemAsync(k),
        setItem: (k: string, v: string) => SecureStore.setItemAsync(k, v),
        removeItem: (k: string) => SecureStore.deleteItemAsync(k),
      };

export async function saveTokens(t: StoredTokens): Promise<void> {
  await Promise.all([store.setItem(ACCESS, t.accessToken), store.setItem(REFRESH, t.refreshToken)]);
}

export async function loadTokens(): Promise<StoredTokens | null> {
  const [accessToken, refreshToken] = await Promise.all([
    store.getItem(ACCESS),
    store.getItem(REFRESH),
  ]);
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

export async function clearTokens(): Promise<void> {
  await Promise.all([store.removeItem(ACCESS), store.removeItem(REFRESH)]);
}
