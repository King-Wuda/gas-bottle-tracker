import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as Location from 'expo-location';
import type { CapturedPhoto } from '@gct/shared';

/**
 * Turning a camera shutter into the `CapturedPhoto` the API takes.
 *
 * Two things happen here that the screen deliberately does not do itself: the image is
 * shrunk to something a field connection can actually upload, and the position is
 * fetched in a way that cannot block the capture.
 */

/**
 * The long edge of the stored image.
 *
 * A modern phone camera produces 3–8 MB per shot. Base64 inflates that by a third, and
 * the result sits in the outbox — on device, in SQLite — until signal returns, then
 * goes up over whatever connection a yard has. 1280px is comfortably enough to see
 * that a batch of cylinders is standing where the record says, which is the entire
 * question this photo answers. It lands around 150–350 KB.
 */
const MAX_EDGE = 1280;

/** JPEG quality. 0.6 is where compression artefacts stop being visible on a photo of
 *  cylinders in daylight, and the file stops shrinking much below it. */
const QUALITY = 0.6;

/**
 * How long to wait for a GPS fix before giving up and recording that there was none.
 *
 * Location is best-effort by design (see `schemas/photo.ts`). A phone inside a steel
 * shed can spend minutes not getting a fix, and a driver at the gate cannot wait for
 * it — so the photo is taken either way and the absence is recorded honestly.
 */
const LOCATION_TIMEOUT_MS = 8_000;

export interface RawShot {
  /** File URI or data URL from `takePictureAsync`. */
  uri: string;
}

/** The position half of a capture, resolved or explained. */
export type FixResult = Pick<
  CapturedPhoto,
  'latitude' | 'longitude' | 'accuracyM' | 'locationError'
>;

const NO_FIX = (locationError: string): FixResult => ({
  latitude: null,
  longitude: null,
  accuracyM: null,
  locationError,
});

/**
 * Ask the OS where we are, and never throw.
 *
 * Every failure path returns a `locationError` instead: permission refused, services
 * switched off, no fix in time, or the module misbehaving. The caller stores whatever
 * comes back, so "we do not know where this was taken" is always a recorded answer
 * rather than a missing one.
 */
export async function currentFix(): Promise<FixResult> {
  try {
    const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return NO_FIX(
        canAskAgain
          ? 'Location permission not granted'
          : 'Location permission denied — enable it in settings',
      );
    }

    if (!(await Location.hasServicesEnabledAsync())) {
      return NO_FIX('Location services are switched off on this device');
    }

    // `Promise.race` rather than a library timeout: expo-location's own accuracy
    // settings govern how hard it tries, not how long we are willing to wait, and a
    // hung fix must not hold the shutter.
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCATION_TIMEOUT_MS)),
    ]);
    if (!fix) return NO_FIX('Could not get a location fix in time');

    return {
      latitude: fix.coords.latitude,
      longitude: fix.coords.longitude,
      accuracyM: fix.coords.accuracy ?? null,
      locationError: null,
    };
  } catch (err) {
    return NO_FIX(err instanceof Error ? err.message : 'Location unavailable');
  }
}

/**
 * Shrink a shot and base64-encode it.
 *
 * Runs on both targets: `ImageManipulator` uses the native codec on Android and a
 * canvas on web, and both accept the URI `takePictureAsync` returns.
 */
export async function compressForUpload(shot: RawShot): Promise<string> {
  const context = ImageManipulator.manipulate(shot.uri);
  // Only the width is given, so the height follows the aspect ratio. A portrait shot
  // is therefore capped on its SHORT edge — deliberate: it keeps a tall photo of a
  // cylinder stack from being upscaled to 1280 wide and back to a bigger file.
  const rendered = await context.resize({ width: MAX_EDGE }).renderAsync();
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: QUALITY,
    base64: true,
  });
  if (!saved.base64) throw new Error('The camera returned an image that could not be encoded.');
  return `data:image/jpeg;base64,${saved.base64}`;
}

/**
 * One shutter press → the whole `CapturedPhoto`.
 *
 * The image is compressed and the fix requested CONCURRENTLY, because they are
 * independent and the fix is the slow one; doing them in series would add its timeout
 * to every capture. `capturedAt` is stamped at the start, which is the moment the
 * shutter actually fired rather than whenever the encoding finished.
 */
export async function buildCapturedPhoto(shot: RawShot): Promise<CapturedPhoto> {
  const capturedAt = new Date().toISOString();
  const [imageBase64, fix] = await Promise.all([compressForUpload(shot), currentFix()]);
  return { imageBase64, capturedAt, ...fix };
}

/** "−26.20410, 28.04730 · ±12 m", or the reason there is nothing to show. */
export function describeFix(fix: FixResult): string {
  if (fix.latitude === null || fix.longitude === null) {
    return fix.locationError ?? 'No location recorded';
  }
  const accuracy = fix.accuracyM === null ? '' : ` · ±${Math.round(fix.accuracyM)} m`;
  return `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}${accuracy}`;
}
