import { useState } from 'react';
import { Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import SignatureScreen from 'react-native-signature-canvas';
import type { CreateReturnRequest } from '@gct/shared';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { useSync } from '../../src/sync/SyncContext';
import { enqueueMutation } from '../../src/sync/worker';
import {
  ErrorText,
  Field,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';

/**
 * Workflow C4 — the driver signs on screen, then C5 submits. The signature is the
 * evidence that a named person took the cylinders, so nothing is submitted until
 * both a name and a drawn signature exist.
 */
export default function Sign() {
  const router = useRouter();
  const { batch, scans, overrides, photo, photoOverride } = useScanFlow();
  const { sync, online } = useSync();

  const [driverName, setDriverName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!batch || scans.length + overrides.length === 0) return <Redirect href="/returns" />;
  // See transfer/destination.tsx: the driver must not sign for a return the server
  // will refuse for want of a photo.
  if (!photo && !photoOverride) return <Redirect href="/returns/photo" />;

  const selectedCount = scans.length + overrides.length;

  const submit = async (png: string) => {
    setSubmitting(true);
    setError(null);
    try {
      // Minted once, here, as the intent is formed — and it becomes the outbox row's
      // id, so every later retry replays this same key. See docs/OFFLINE.md.
      const clientRequestId = Crypto.randomUUID();
      const body: CreateReturnRequest = {
        batchId: batch.id,
        clientRequestId,
        scans: scans.map((s) => ({
          serialCode: s.serialCode,
          qrPayload: s.qrPayload,
          scannedAt: s.scannedAt,
        })),
        // Held apart from the scans so the delivery note can mark these "no scan" —
        // the driver is signing for them, and is entitled to see which ones nobody
        // actually put a camera on.
        overrideSerials: overrides,
        driverName: driverName.trim(),
        signaturePng: png,
        // Taken before the pen went on the screen: the driver is signing for what is
        // in this photo.
        photo,
        photoOverride,
      };

      // Outbox first, network second: a return captured in a dead spot is durable
      // before anything is attempted over the wire.
      await enqueueMutation({
        id: clientRequestId,
        kind: 'return',
        path: '/returns',
        body,
        label: `${selectedCount} cylinder(s) returned by ${driverName.trim()}`,
      });
      await sync();
      router.replace({ pathname: '/returns/result', params: { id: clientRequestId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not queue this return.');
      setSubmitting(false);
    }
  };

  const ready = driverName.trim().length > 0;

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        {selectedCount} cylinder(s) from {batch.projectNumber}
      </Text>
      {overrides.length > 0 ? (
        <Text style={{ color: '#b8860b', fontWeight: '600' }}>
          {overrides.length} of these were not scanned. They will be listed on the delivery note as
          &quot;no scan&quot; — make sure the driver sees that before signing.
        </Text>
      ) : null}
      {photoOverride ? (
        <Text style={{ color: '#b8860b', fontWeight: '600' }}>
          No photo was taken — this return will be recorded as an admin camera override. Make sure
          the driver knows before they sign.
        </Text>
      ) : null}
      {!online ? (
        <Text style={styles.label}>
          Offline — the signed return is queued on this device and sent when signal returns. The
          photo and the signature go with it.
        </Text>
      ) : null}

      <Field
        label="Collection driver name"
        value={driverName}
        onChangeText={setDriverName}
        autoCapitalize="words"
        placeholder="As it appears on their ID"
      />

      <Text style={styles.label}>Driver signature</Text>
      <View
        style={{
          height: 240,
          borderWidth: 1,
          borderColor: 'rgba(127,127,127,0.4)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <SignatureScreen
          onOK={(sig: string) => {
            setSignature(sig);
            if (ready) void submit(sig);
          }}
          onEmpty={() => setError('Please have the driver sign before submitting.')}
          descriptionText=""
          clearText="Clear"
          confirmText={ready ? 'Sign & submit' : 'Enter the driver name first'}
          webStyle={SIGNATURE_PAD_CSS}
          autoClear={false}
          imageType="image/png"
        />
      </View>

      <Text style={styles.label}>
        The driver signs above, then taps “Sign &amp; submit”. A signed delivery note is emailed to
        the project manager.
      </Text>

      <ErrorText>{error}</ErrorText>

      {signature && !submitting ? (
        <SecondaryButton title="Re-submit" onPress={() => void submit(signature)} />
      ) : null}
      {submitting ? <PrimaryButton title="Submitting…" onPress={() => {}} busy /> : null}
    </ScreenScroll>
  );
}

/**
 * The canvas renders inside a WebView, so its chrome is styled with CSS rather than
 * RN styles. Hiding the default footer border keeps it from double-framing the card.
 */
const SIGNATURE_PAD_CSS = `
  .m-signature-pad { box-shadow: none; border: none; margin: 0; }
  .m-signature-pad--body { border: none; }
  .m-signature-pad--footer { margin: 0 8px 8px; }
  .m-signature-pad--footer .button { border-radius: 8px; padding: 8px 14px; font-size: 14px; }
  body, html { height: 100%; margin: 0; }
`;
