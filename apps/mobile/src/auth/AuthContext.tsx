import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { UserDto } from '@gct/shared';
import {
  apiLogin,
  apiLogout,
  apiMe,
  getSession,
  onAuthLost,
  setSession,
  ApiError,
} from '../api/client';

type Status = 'loading' | 'signedIn' | 'signedOut';

interface AuthValue {
  status: Status;
  user: UserDto | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<UserDto | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Hydrate on mount: a stored session is only "signed in" if /me confirms it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await getSession();
      if (!session) {
        if (!cancelled) setStatus('signedOut');
        return;
      }
      try {
        const { user: me } = await apiMe();
        if (!cancelled) {
          setUser(me);
          setStatus('signedIn');
        }
      } catch {
        await setSession(null);
        if (!cancelled) {
          setUser(null);
          setStatus('signedOut');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The API client tells us when a refresh has permanently failed.
  useEffect(
    () =>
      onAuthLost(() => {
        if (!mounted.current) return;
        setUser(null);
        setStatus('signedOut');
      }),
    [],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await apiLogin(email, password);
    await setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    setUser(res.user);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus('signedOut');
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, user, signIn, signOut }),
    [status, user, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export { ApiError };
