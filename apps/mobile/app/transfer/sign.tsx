import { useState } from 'react';
import { Text } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import type { CreateTransferRequest } from '@gct/shared';
import { useAuth } from '../../src/auth/AuthContext';
import { DriverSignOffForm } from '../../src/components/DriverSignOffForm';
import { useDriverSignOff } from '../../src/driver/useDriverSignOff';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { playCue } from '../../src/sound';
import { useSync } from '../../src/sync/SyncContext';
import { enqueueMutation } from '../../src/sync/worker';
import { ErrorText, Notice, PrimaryButton, ScreenScroll, styles } from '../../src/ui/components';

/**
 * Workflow B5 — the driver's details, then the transfer is submitted.
 *
 * ## Why a transfer needs this at all
 *
 * A transfer hands physical cylinders to someone who drives away with them, exactly
 * as a return does; the only difference is where they are going. Recording who took
 * them on returns and not on transfers left the MORE common movement as the less
 * accountable one — a batch could cross the country with nobody named against it,
 * and the question "who moved these?" would have no answer at the point it is
 * usually asked.
 *
 * Everything collected here is shared with the return flow (`useDriverSignOff`), so
 * the two cannot drift in what they ask for or when they consider it complete.
 */
export default function TransferSign() {
  const router = useRouter();
  const { batch, scans, overrides, photo, photoOverride } = useScanFlow();
  const { sync, online } = useSync();
  const { user } = useAuth();
  const driver = useDriverSignOff({ online });
  const params = useLocalSearchParams<{
    destination?: string;
    siteId?: string;
    siteName?: string;
    projectManagerId?: string;
  }>();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!batch || scans.length + overrides.length === 0) return <Redirect href="/transfer" />;
  if (!photo && !photoOverride) return <Redirect href="/transfer/photo" />;
  // Deep-linked past the destination step: there is nothing to submit to, and the
  // server would refuse it. Send them back to choose rather than letting the driver
  // sign for a move with no destination.
  if (params.destination !== 'SITE' && params.destination !== 'STORES') {
    return <Redirect href="/transfer/destination" />;
  }

  const selectedCount = scans.length + overrides.length;
  const toStores = params.destination === 'STORES';
  const where = toStores ? 'Stores' : (params.siteName ?? 'the selected site');

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

      // The idempotency key is minted HERE, once, as the intent is formed — and it
      // becomes the outbox row's id. Every retry, now or after three days in a dead
      // spot, replays this same key, so the server recognises it as one transfer.
      const clientRequestId = Crypto.randomUUID();
      const body: CreateTransferRequest = {
        batchId: batch.id,
        clientRequestId,
        destination: toStores ? { type: 'STORES' } : { type: 'SITE', siteId: params.siteId! },
        scans: scans.map((s) => ({
          serialCode: s.serialCode,
          qrPayload: s.qrPayload,
          scannedAt: s.scannedAt,
        })),
        // Kept separate from `scans` the whole way, so the server can record which
        // cylinders were actually seen and which were asserted.
        overrideSerials: overrides,
        ...signOff,
        // Held on the flow since the photo step, so the destination and the sign-off
        // — which take a while — never cost a retake.
        photo,
        photoOverride,
        ...(params.projectManagerId ? { projectManagerId: params.projectManagerId } : {}),
      };

      // Outbox first, network second: if the app dies between these two lines the
      // work is already durable, and if the POST never happens the sync worker picks
      // it up later.
      await enqueueMutation({
        id: clientRequestId,
        kind: 'transfer',
        path: '/transfers',
        body,
        label: `${selectedCount} cylinder(s) → ${where}, taken by ${signOff.driverName}`,
      });
      await sync();
      router.replace({ pathname: '/transfer/result', params: { id: clientRequestId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not queue this transfer.');
      setSubmitting(false);
    }
  };

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        {selectedCount} cylinder(s) from {batch.projectNumber} → {where}
      </Text>

      {overrides.length > 0 ? (
        <Notice tone="warning" title={`${overrides.length} were not scanned`}>
          They will be recorded as an admin override on the audit trail. Make sure the driver sees
          that before signing.
        </Notice>
      ) : null}
      {photoOverride ? (
        <Notice tone="warning" title="No photo of the batch">
          This transfer will be recorded as an admin camera override. Make sure the driver knows
          before they sign.
        </Notice>
      ) : null}
      {!online ? (
        <Notice tone="neutral" title="Offline">
          The signed transfer is queued on this device and sent when signal returns. The photo, the
          ID and the signature go with it.
        </Notice>
      ) : null}

      <DriverSignOffForm
        driver={driver}
        isAdmin={user?.role === 'ADMIN'}
        online={online}
        submitting={submitting}
      />

      <Text style={styles.hint}>
        The driver signs above, then the transfer is submitted. Their name, ID number and signature
        are recorded against every cylinder that moves.
      </Text>

      <ErrorText>{error}</ErrorText>

      <PrimaryButton
        title={submitting ? 'Submitting…' : (driver.blocker ?? 'Sign & submit transfer')}
        onPress={() => void submit()}
        disabled={!driver.ready}
        busy={submitting}
      />
    </ScreenScroll>
  );
}
