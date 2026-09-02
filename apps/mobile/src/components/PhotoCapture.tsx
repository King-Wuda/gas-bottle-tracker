import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { CapturedPhoto } from '@gct/shared';
import { buildCapturedPhoto, describeFix } from '../photo/capture';
import { PrimaryButton, SecondaryButton, styles as base } from '../ui/components';

/**
 * The batch photo step, shared by initialization, transfer and returns.
 *
 * ## Why this screen exists at all
 *
 * The scan step proves *which* cylinders. It cannot prove they were together, at the
 * place the paperwork names, at the time it names — a phone can read forty labels off
 * a desk. This screen is that second claim, and it is stamped with position and time
 * so it stands on its own rather than on the operator's word.
 *
 * ## What it does NOT do
 *
 * It never blocks on the GPS. The fix runs alongside the image compression and gives
 * up after a few seconds; a photo taken inside a steel shed is recorded with the
 * reason there is no position, and the submission goes through. Refusing the capture
 * would strand a driver at a gate over a satellite, which is not a trade this app is
 * entitled to make on their behalf.
 *
 * The admin override mirrors the scan override on `ScanStep`, and for the same reason:
 * the camera itself can be the thing that has failed. It is a separate, visibly
 * different affordance, and what it records is "an admin waived this", not "a photo
 * was taken" — an override that looked like evidence would quietly devalue every real
 * photo in the system.
 */
export function PhotoCapture({
  title,
  hint,
  ctaLabel,
  onDone,
  isAdmin = false,
  onOverride,
  busy = false,
  error = null,
}: {
  title: string;
  hint: string;
  /** e.g. `Continue`, `Submit initialization`. */
  ctaLabel: string;
  onDone: (photo: CapturedPhoto) => void;
  /** Shows the camera override — the caller checks the role. */
  isAdmin?: boolean;
  onOverride?: () => void;
  /** The caller is submitting; keeps the buttons from firing twice. */
  busy?: boolean;
  error?: string | null;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);

  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const take = useCallback(async () => {
    if (!camera.current) return;
    setCapturing(true);
    setCaptureError(null);
    try {
      const shot = await camera.current.takePictureAsync({ quality: 1, skipProcessing: true });
      if (!shot?.uri) throw new Error('The camera did not return an image.');
      setPhoto(await buildCapturedPhoto({ uri: shot.uri }));
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : 'Could not take the photo.');
    } finally {
      setCapturing(false);
    }
  }, []);

  if (!permission) return <Text style={styles.note}>Checking camera permission…</Text>;

  if (!permission.granted) {
    return (
      <View style={styles.permission}>
        <Text style={styles.permissionTitle}>Camera access is required</Text>
        <Text style={styles.note}>
          Every movement is recorded with a photo of the batch, so this step cannot work without the
          camera.
        </Text>
        {permission.canAskAgain ? (
          <PrimaryButton title="Grant camera access" onPress={() => void requestPermission()} />
        ) : (
          <PrimaryButton title="Open settings" onPress={() => void Linking.openSettings()} />
        )}
        {isAdmin && onOverride ? <OverrideButton onPress={onOverride} disabled={busy} /> : null}
      </View>
    );
  }

  // ---- review: a photo has been taken, and is being confirmed or retaken ----
  if (photo) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.title}>{title}</Text>

        <Image
          source={{ uri: photo.imageBase64 }}
          style={styles.preview}
          resizeMode="cover"
          accessibilityLabel="The photo just taken of this batch"
        />

        <View style={[styles.stamp, photo.latitude === null && styles.stampWarn]}>
          <Text style={styles.stampLine}>{new Date(photo.capturedAt).toLocaleString()}</Text>
          <Text style={styles.stampLine}>{describeFix(photo)}</Text>
          {photo.latitude === null ? (
            <Text style={styles.stampHint}>
              The photo is still valid — it will be recorded with the reason no position was
              available.
            </Text>
          ) : null}
        </View>

        {error ? <Text style={base.error}>{error}</Text> : null}

        <PrimaryButton title={ctaLabel} onPress={() => onDone(photo)} busy={busy} />
        <SecondaryButton title="Retake" onPress={() => setPhoto(null)} disabled={busy} />
      </View>
    );
  }

  // ---- viewfinder ----
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.note}>{hint}</Text>

      <View style={styles.viewfinder}>
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />
      </View>

      {captureError ? <Text style={base.error}>{captureError}</Text> : null}
      {error ? <Text style={base.error}>{error}</Text> : null}

      <PrimaryButton
        title={capturing ? 'Capturing…' : 'Take the photo'}
        onPress={() => void take()}
        busy={capturing}
      />
      {capturing ? (
        <View style={styles.busyRow}>
          <ActivityIndicator />
          <Text style={styles.note}>Compressing and reading the location…</Text>
        </View>
      ) : null}

      {isAdmin && onOverride ? <OverrideButton onPress={onOverride} disabled={busy} /> : null}
    </View>
  );
}

/** Amber, like the scan override on `ScanStep` — the two are the same kind of act. */
function OverrideButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        role="button"
        onPress={onPress}
        disabled={disabled}
        style={[styles.override, disabled && { opacity: 0.5 }]}
      >
        <Text style={styles.overrideText}>Continue without a photo (admin)</Text>
      </Pressable>
      <Text style={styles.note}>
        Recorded as an admin override, not as a photo. Use it when the camera is what has failed.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  title: { fontSize: 16, fontWeight: '700' },
  viewfinder: { height: 320, borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' },
  preview: { height: 320, borderRadius: 14, backgroundColor: '#000' },
  note: { opacity: 0.7, fontSize: 14 },
  busyRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  stamp: { backgroundColor: 'rgba(30,126,52,0.15)', borderRadius: 10, padding: 12, gap: 2 },
  stampWarn: { backgroundColor: 'rgba(184,134,11,0.18)' },
  stampLine: { fontWeight: '600', fontSize: 14 },
  stampHint: { fontSize: 13, opacity: 0.75, marginTop: 4 },
  permission: { gap: 12, paddingVertical: 20 },
  permissionTitle: { fontSize: 17, fontWeight: '700' },
  override: {
    borderWidth: 1,
    borderColor: '#b8860b',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  overrideText: { color: '#b8860b', fontSize: 16, fontWeight: '700' },
});
