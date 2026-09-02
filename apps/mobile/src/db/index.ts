import { Platform } from 'react-native';
import type { Store } from './store';
import { createMemoryStore } from './memoryStore';

let storePromise: Promise<Store> | null = null;

/** Lazily opens the local store. SQLite on device, memory on web (see memoryStore). */
export function getStore(): Promise<Store> {
  storePromise ??= open().catch((err) => {
    storePromise = null; // never cache a failed open
    throw err;
  });
  return storePromise;
}

async function open(): Promise<Store> {
  if (Platform.OS === 'web') return createMemoryStore();
  // Imported dynamically so Metro never pulls the native module into the web bundle.
  const { createSqliteStore } = await import('./sqliteStore');
  return createSqliteStore();
}

export * from './store';
