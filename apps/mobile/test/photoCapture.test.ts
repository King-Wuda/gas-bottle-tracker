import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The location half of a capture.
 *
 * `expo-location` is a native module, so it is mocked — what is under test is the
 * policy around it, which is the part that decides whether a driver at a gate can
 * finish their work. Every failure mode has to come back as a recorded REASON rather
 * than an exception or a silent zero, because the record has to be able to say "we do
 * not know where this was taken" as a positive fact.
 */

const mocks = vi.hoisted(() => ({
  requestForegroundPermissionsAsync: vi.fn(),
  hasServicesEnabledAsync: vi.fn(),
  getCurrentPositionAsync: vi.fn(),
}));

vi.mock('expo-location', () => ({
  ...mocks,
  Accuracy: { Balanced: 3 },
}));

// Not under test here, but importing it for real would drag react-native (and its
// Flow syntax) into a node test runner that cannot parse it.
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: vi.fn() },
  SaveFormat: { JPEG: 'jpeg' },
}));

// Imported after the mock is registered.
const { currentFix, describeFix } = await import('../src/photo/capture');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestForegroundPermissionsAsync.mockResolvedValue({
    status: 'granted',
    canAskAgain: true,
  });
  mocks.hasServicesEnabledAsync.mockResolvedValue(true);
});

describe('currentFix', () => {
  it('returns the position when the OS gives one', async () => {
    mocks.getCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: -26.2041, longitude: 28.0473, accuracy: 9.5 },
    });

    expect(await currentFix()).toEqual({
      latitude: -26.2041,
      longitude: 28.0473,
      accuracyM: 9.5,
      locationError: null,
    });
  });

  it('records WHY there is no position when permission is refused', async () => {
    mocks.requestForegroundPermissionsAsync.mockResolvedValue({
      status: 'denied',
      canAskAgain: false,
    });

    const fix = await currentFix();
    // Null, never 0 — a photo with no fix must not read as one taken at 0°N 0°E.
    expect(fix.latitude).toBeNull();
    expect(fix.longitude).toBeNull();
    expect(fix.locationError).toMatch(/denied/i);
    expect(mocks.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('records why when location services are switched off', async () => {
    mocks.hasServicesEnabledAsync.mockResolvedValue(false);

    const fix = await currentFix();
    expect(fix.latitude).toBeNull();
    expect(fix.locationError).toMatch(/switched off/i);
  });

  it('never throws — a misbehaving module becomes a recorded reason', async () => {
    mocks.getCurrentPositionAsync.mockRejectedValue(new Error('GPS chip on fire'));

    const fix = await currentFix();
    expect(fix.latitude).toBeNull();
    expect(fix.locationError).toBe('GPS chip on fire');
  });

  it('gives up rather than hanging when no fix arrives', async () => {
    vi.useFakeTimers();
    // A fix that never resolves — a phone inside a steel shed.
    mocks.getCurrentPositionAsync.mockReturnValue(new Promise(() => {}));

    const pending = currentFix();
    await vi.advanceTimersByTimeAsync(10_000);
    const fix = await pending;

    expect(fix.latitude).toBeNull();
    expect(fix.locationError).toMatch(/in time/i);
    vi.useRealTimers();
  });
});

describe('describeFix', () => {
  it('shows the coordinates and accuracy when there is a fix', () => {
    expect(
      describeFix({
        latitude: -26.2041,
        longitude: 28.0473,
        accuracyM: 12.4,
        locationError: null,
      }),
    ).toBe('-26.20410, 28.04730 · ±12 m');
  });

  it('shows the reason instead when there is not', () => {
    expect(
      describeFix({
        latitude: null,
        longitude: null,
        accuracyM: null,
        locationError: 'Location services are switched off on this device',
      }),
    ).toBe('Location services are switched off on this device');
  });
});
