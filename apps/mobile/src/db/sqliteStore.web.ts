import type { Store } from './store';
import { createMemoryStore } from './memoryStore';

/**
 * Web resolution for `./sqliteStore`. `index.ts` branches to the memory store before
 * it ever reaches the dynamic import, but Metro still walks that import when it builds
 * the web graph, and following the real module drags `expo-sqlite` — and its wasm
 * asset, which the web export cannot serve — into the bundle. Resolving to this file
 * keeps the native module out of it. See memoryStore for why web is memory-backed.
 */
export async function createSqliteStore(): Promise<Store> {
  return createMemoryStore();
}
