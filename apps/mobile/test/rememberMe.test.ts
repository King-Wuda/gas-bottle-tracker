import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * "Keep me signed in" has to actually decide whether the session outlives the app.
 *
 * The failure this guards is silent and one-directional: a box that looks unticked
 * while the tokens are still on disk. Nothing in the UI would show it, and the person
 * who unticked it did so precisely because they were on a shared or borrowed device.
 */

const saveTokens = vi.fn(async () => {});
const clearTokens = vi.fn(async () => {});

vi.mock('../src/auth/tokenStore', () => ({
  saveTokens: (...args: unknown[]) => saveTokens(...(args as [])),
  clearTokens: () => clearTokens(),
  loadTokens: async () => null,
}));

// The client module pulls in the API base URL, which reaches for expo-constants.
vi.mock('../src/config', () => ({ API_URL: 'http://localhost:3000', configNote: null }));

const TOKENS = { accessToken: 'a', refreshToken: 'r' };

beforeEach(() => {
  saveTokens.mockClear();
  clearTokens.mockClear();
  vi.resetModules();
});

describe('setSession — "keep me signed in"', () => {
  it('writes the tokens to the durable store when remembering', async () => {
    const { setSession, getSession } = await import('../src/api/client');
    await setSession(TOKENS, { remember: true });
    expect(saveTokens).toHaveBeenCalledWith(TOKENS);
    expect(clearTokens).not.toHaveBeenCalled();
    // And the session is live either way — the flag is about persistence, not access.
    expect(await getSession()).toEqual(TOKENS);
  });

  it('defaults to remembering when nothing is passed', async () => {
    // The old call sites did not pass a flag and must keep behaving as they did.
    const { setSession } = await import('../src/api/client');
    await setSession(TOKENS);
    expect(saveTokens).toHaveBeenCalledWith(TOKENS);
  });

  it('writes nothing when not remembering, but still signs you in', async () => {
    const { setSession, getSession } = await import('../src/api/client');
    await setSession(TOKENS, { remember: false });
    expect(saveTokens).not.toHaveBeenCalled();
    expect(await getSession()).toEqual(TOKENS);
  });

  it('clears what a previous session left behind when not remembering', async () => {
    // The case that matters: this device remembered someone last time. Unticking the
    // box has to actually stop remembering them, or the tick does nothing on exactly
    // the machine where it matters most.
    const { setSession } = await import('../src/api/client');
    await setSession(TOKENS, { remember: false });
    expect(clearTokens).toHaveBeenCalled();
  });

  it('clears the store on sign-out', async () => {
    const { setSession, getSession } = await import('../src/api/client');
    await setSession(TOKENS, { remember: true });
    await setSession(null);
    expect(clearTokens).toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });
});
