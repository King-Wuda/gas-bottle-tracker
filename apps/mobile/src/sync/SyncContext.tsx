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
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { getStore, type OutboxRecord } from '../db';
import { flushOutbox } from './worker';

interface SyncValue {
  /** Queued work not yet accepted by the server. */
  pending: OutboxRecord[];
  /** Refused by the server — retrying will not help; a person must look. */
  rejected: OutboxRecord[];
  online: boolean;
  syncing: boolean;
  /** Drain now and refresh the queue view. Safe to call when offline. */
  sync: () => Promise<void>;
  /** Re-read the queue without attempting a send. */
  refresh: () => Promise<void>;
  /** Requeue one rejected row under its original key, then drain (M5 queue screen). */
  retry: (id: string) => Promise<void>;
  /** Permanently drop one rejected row. */
  discard: (id: string) => Promise<void>;
}

const SyncContext = createContext<SyncValue | null>(null);

/** Background drain cadence while the app is foregrounded. */
const POLL_MS = 20_000;

export function SyncProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OutboxRecord[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const store = await getStore();
      const rows = await store.openOutbox();
      if (mounted.current) setOpen(rows);
    } catch {
      // A store that will not open must not take the app down; the queue view just
      // stays empty and the next attempt re-tries the open.
    }
  }, []);

  const sync = useCallback(async () => {
    if (!mounted.current) return;
    setSyncing(true);
    try {
      await flushOutbox();
    } catch {
      // flushOutbox already records per-row failures; nothing to surface here.
    } finally {
      if (mounted.current) setSyncing(false);
      await refresh();
    }
  }, [refresh]);

  const retry = useCallback(
    async (id: string) => {
      const store = await getStore();
      await store.retryOutbox(id);
      // Drain immediately: the operator tapped Retry and is watching for an answer.
      // If they are offline the row simply stays pending and the poller gets it later.
      await sync();
    },
    [sync],
  );

  const discard = useCallback(
    async (id: string) => {
      const store = await getStore();
      await store.discardOutbox(id);
      await refresh();
    },
    [refresh],
  );

  // Connectivity: poll rather than subscribe, so one code path covers every platform.
  // A transition offline -> online is the moment worth draining on.
  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      let reachable: boolean;
      try {
        const state = await Network.getNetworkStateAsync();
        reachable = Boolean(state.isInternetReachable ?? state.isConnected);
      } catch {
        reachable = true; // unknown: assume online and let the request itself fail
      }
      if (cancelled) return;
      setOnline(reachable);
      // Drain on every tick while online, which also covers the moment signal returns.
      if (reachable) void sync();
    };

    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void check();
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      sub.remove();
    };
  }, [sync]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SyncValue>(
    () => ({
      pending: open.filter((r) => r.status === 'pending'),
      rejected: open.filter((r) => r.status === 'rejected'),
      online,
      syncing,
      sync,
      refresh,
      retry,
      discard,
    }),
    [open, online, syncing, sync, refresh, retry, discard],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within <SyncProvider>');
  return ctx;
}
