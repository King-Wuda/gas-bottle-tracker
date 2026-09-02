import { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

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
  wrap: { gap: 12 },
  viewfinder: {
    height: 280,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  reticle: {
    position: 'absolute',
    top: '18%',
    left: '18%',
    right: '18%',
    bottom: '18%',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 12,
  },
  note: { opacity: 0.7, fontSize: 14 },
  feedback: { borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  feedbackText: { fontWeight: '600', color: '#fff' },
  ok: { backgroundColor: '#1e7e34' },
  warn: { backgroundColor: '#b8860b' },
  bad: { backgroundColor: '#c0392b' },
  permission: { gap: 12, paddingVertical: 20 },
  permissionTitle: { fontSize: 17, fontWeight: '700' },
  grantButton: {
    backgroundColor: '#1f6feb',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  grantText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
