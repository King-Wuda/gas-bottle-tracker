import { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { playCue } from '../sound';
import { colors, radius, space, type } from '../ui/theme';

export type ScanOutcome =
  | { kind: 'accepted'; serialCode: string; payload: string }
  | { kind: 'duplicate'; serialCode: string }
  | { kind: 'foreign'; serialCode: string }
  | { kind: 'invalid'; reason: string };

interface ScannerProps {
  /** Called once per distinct code; the caller decides what the scan means. */
  onScan: (raw: string) => ScanOutcome;
  /** Rendered under the viewfinder — the live scanned/expected checklist. */
  footer?: React.ReactNode;
}

/** Ignore repeats of the same code for this long — one sticker held in frame fires
 *  onBarcodeScanned many times a second. */
const REPEAT_SUPPRESS_MS = 1500;

export function Scanner({ onScan, footer }: ScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [last, setLast] = useState<ScanOutcome | null>(null);
  const seen = useRef(new Map<string, number>());

  const handle = useCallback(
    ({ data }: { data: string }) => {
      const now = Date.now();
      const previous = seen.current.get(data);
      if (previous && now - previous < REPEAT_SUPPRESS_MS) return;
      seen.current.set(data, now);
      // Every code the scanner takes in gets the beep, whatever it turns out to
      // mean. It answers "the camera saw that one" — which is the question the person
      // holding the phone has, because they are looking at the cylinder and not at
      // the screen. What the scan MEANT is still said visually, below, in colour:
      // the beep deliberately does not try to encode accepted vs. rejected, because
      // a tone nobody has been taught is not information.
      playCue('scan');
      setLast(onScan(data));
    },
    [onScan],
  );

  if (!permission) return <Text style={styles.note}>Checking camera permission…</Text>;

  if (!permission.granted) {
    return (
      <View style={styles.permission}>
        <Text style={styles.permissionTitle}>Camera access is required</Text>
        <Text style={styles.note}>
          Transfers must be proven by physically scanning each cylinder, so this screen cannot work
          without the camera.
        </Text>
        {permission.canAskAgain ? (
          <Pressable style={styles.grantButton} onPress={() => void requestPermission()}>
            <Text style={styles.grantText}>Grant camera access</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.grantButton} onPress={() => void Linking.openSettings()}>
            <Text style={styles.grantText}>Open settings</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.viewfinder}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handle}
        />
        <View style={styles.reticle} pointerEvents="none" />
      </View>

      {last ? (
        <ScanFeedback outcome={last} />
      ) : (
        <Text style={styles.note}>Point at a cylinder’s QR label.</Text>
      )}

      {footer}
    </View>
  );
}

function ScanFeedback({ outcome }: { outcome: ScanOutcome }) {
  const [tone, message] =
    outcome.kind === 'accepted'
      ? (['ok', `${outcome.serialCode} added`] as const)
      : outcome.kind === 'duplicate'
        ? (['warn', `${outcome.serialCode} already scanned`] as const)
        : outcome.kind === 'foreign'
          ? (['bad', `${outcome.serialCode} is not in this batch`] as const)
          : (['bad', outcome.reason] as const);

  return (
    <View
      style={[
        styles.feedback,
        tone === 'ok' ? styles.ok : tone === 'warn' ? styles.warn : styles.bad,
      ]}
    >
      <Text style={styles.feedbackText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  viewfinder: {
    height: 300,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.viewfinder,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  // Corner brackets rather than a full box: a closed rectangle reads as a frame the
  // label must fit exactly inside, and it does not have to.
  reticle: {
    position: 'absolute',
    top: '16%',
    left: '14%',
    right: '14%',
    bottom: '16%',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
    borderRadius: radius.md,
  },
  note: { ...type.caption, textAlign: 'center' },
  feedback: {
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  feedbackText: { fontWeight: '700', color: '#fff', fontSize: 14, flex: 1 },
  ok: { backgroundColor: colors.success },
  warn: { backgroundColor: colors.warning },
  bad: { backgroundColor: colors.danger },
  permission: { gap: space.md, paddingVertical: space.xl, alignItems: 'center' },
  permissionTitle: { ...type.title, textAlign: 'center' },
  grantButton: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  grantText: { color: colors.onBrand, fontSize: 16, fontWeight: '700' },
});
