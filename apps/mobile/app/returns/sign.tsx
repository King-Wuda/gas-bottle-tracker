import { useState } from 'react';
import { Text } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import type { CreateReturnRequest } from '@gct/shared';
import { useAuth } from '../../src/auth/AuthContext';
import { DriverSignOffForm } from '../../src/components/DriverSignOffForm';
import { useDriverSignOff } from '../../src/driver/useDriverSignOff';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { playCue } from '../../src/sound';
import { useSync } from '../../src/sync/SyncContext';
import { enqueueMutation } from '../../src/sync/worker';
import { ErrorText, Notice, PrimaryButton, ScreenScroll, styles } from '../../src/ui/components';

/**
 * Workflow C4 — the driver's details, then C5 submits.
 *
 * The signature is evidence that a named person took the cylinders. On its own it is
 * a squiggle over a name somebody typed, so it is collected alongside the number off
 * the driver's ID and a photograph of that document: together they make "who took
 * them" checkable months later, when the batch is being reconciled and the driver is
 * long gone.
 *
 * The form itself is shared with the transfer flow — see `useDriverSignOff`. What is
 * left here is what is specific to a RETURN: the warnings this batch has earned, and
 * the outbox row it becomes.
 */
export default function Sign() {
  const router = useRouter();
  const { batch, scans, overrides, photo, photoOverride } = useScanFlow();
  const { sync, online } = useSync();
  const { user } = useAuth();
  const driver = useDriverSignOff({ online });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!batch || scans.length + overrides.length === 0) return <Redirect href="/returns" />;
  // See transfer/destination.tsx: the driver must not sign for a return the server
  // will refuse for want of a photo.
  if (!photo && !photoOverride) return <Redirect href="/returns/photo" />;

  const selectedCount = scans.length + overrides.length;

  const submit = async () => {
    if (!driver.ready) return;
    setSubmitting(true);
    setError(null);
    // The submit cue: a struck steel cylinder. It fires on the press rather than on
    // the server's reply, because it is confirming the TAP — and the reply may not
    // come for hours, this being a submission that is durable in the outbox first and
    // sent over the wire second.
    playCue('clang');
    try {
      const signOff = driver.build();
      if (!signOff) {
        setError('The signature did not record. Please clear the pad and sign again.');
        setSubmitting(false);
        return;
      }

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
        ...signOff,
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
        label: `${selectedCount} cylinder(s) returned by ${signOff.driverName}`,
      });
      await sync();
      router.replace({ pathname: '/returns/result', params: { id: clientRequestId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not queue this return.');
      setSubmitting(false);
    }
  };

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        {selectedCount} cylinder(s) from {batch.projectNumber}
      </Text>
      {overrides.length > 0 ? (
        <Notice tone="warning" title={`${overrides.length} were not scanned`}>
          They will be listed on the delivery note as &quot;no scan&quot; — make sure the driver
          sees that before signing.
        </Notice>
      ) : null}
      {photoOverride ? (
        <Notice tone="warning" title="No photo of the batch">
          This return will be recorded as an admin camera override. Make sure the driver knows
          before they sign.
        </Notice>
      ) : null}
      {!online ? (
        <Notice tone="neutral" title="Offline">
          The signed return is queued on this device and sent when signal returns. The photo, the ID
          and the signature go with it.
        </Notice>
      ) : null}

      <DriverSignOffForm
        driver={driver}
        isAdmin={user?.role === 'ADMIN'}
        online={online}
        submitting={submitting}
      />

      <Text style={styles.hint}>
        The driver signs above, then the return is submitted. A signed delivery note carrying the
        signature and the ID is emailed to the project manager.
      </Text>

      <ErrorText>{error}</ErrorText>

      <PrimaryButton
        title={submitting ? 'Submitting…' : (driver.blocker ?? 'Sign & submit')}
        onPress={() => void submit()}
        disabled={!driver.ready}
        busy={submitting}
      />
    </ScreenScroll>
  );
}
