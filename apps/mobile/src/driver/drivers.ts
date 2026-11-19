import { useEffect, useState } from 'react';
import { apiDrivers } from '../api/client';
import { getStore, type CachedDriver } from '../db';

/**
 * The driver profiles for the sign-off picker.
 *
 * Read from the device cache first, so the list is there with no signal — a transfer
 * is often signed for at a gate in a dead spot — then refreshed from the server when
 * online, and the cache replaced with what came back. A failed refresh keeps whatever
 * was cached; with no cache at all the operator ticks "Driver not registered" and
 * types the details, which is always possible.
 */
export function useDriverProfiles({ online }: { online: boolean }): {
  drivers: CachedDriver[];
  loaded: boolean;
} {
  const [drivers, setDrivers] = useState<CachedDriver[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = await getStore();
      const cached = await store.getCachedDrivers();
      if (!cancelled) setDrivers(cached);
      if (online) {
        try {
          const { drivers: fresh } = await apiDrivers();
          const rows = fresh.map((d) => ({
            id: d.id,
            fullName: d.fullName,
            email: d.email,
            phone: d.phone,
          }));
          await store.cacheDrivers(rows);
          if (!cancelled) setDrivers(rows);
        } catch {
          // Keep the cached list — a stale picker beats an empty one.
        }
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [online]);

  return { drivers, loaded };
}
