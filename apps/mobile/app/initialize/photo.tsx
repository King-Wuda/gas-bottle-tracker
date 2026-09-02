import { useState } from 'react';
import { Text } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import type { CapturedPhoto, CreateInitializationRequest } from '@gct/shared';
import { useAuth } from '../../src/auth/AuthContext';
import { PhotoCapture } from '../../src/components/PhotoCapture';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { useSync } from '../../src/sync/SyncContext';
import { enqueueMutation } from '../../src/sync/worker';
import { ScreenScroll, styles } from '../../src/ui/components';

/**
 * Workflow A2's last step: photograph the batch, then submit.
 *
 * Unlike Transfer and Returns, there is nothing after this — no destination to choose,
 * no signature to collect — so the capture screen is also the submit screen.
 */
export default function InitializePhoto() {
  const router = useRouter();
  const { batch, scans, overrides, photo, photoOverride, setPhoto, overridePhoto } = useScanFlow();
  const { sync, online } = useSync();
  const { user } = useAuth();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!batch || scans.length + overrides.length === 0) return <Redirect href="/initialize" />;

  const selectedCount = scans.length + overrides.length;

  const submit = async (evidence: { photo: CapturedPhoto | null; photoOverride: boolean }) => {
    setSubmitting(true);
    setError(null);
    try {
      // Minted once, here, as the intent is formed — and it becomes the outbox row's
      // id, so every later retry replays this same key. See docs/OFFLINE.md.
      const clientRequestId = Crypto.randomUUID();
      const body: CreateInitializationRequest = {
        batchId: batch.id,
        clientRequestId,
        scans: scans.map((s) => ({
          serialCode: s.serialCode,
          qrPayload: s.qrPayload,
          scannedAt: s.scannedAt,
        })),
        overrideSerials: overrides,
        photo: evidence.photo,
        photoOverride: evidence.photoOverride,
      };

      // Outbox first, network second: an initialization done in a dead spot is durable
      // before anything is attempted over the wire.
      await enqueueMutation({
        id: clientRequestId,
        kind: 'initialize',
        path: '/initializations',
        body,
        label: `${batch.projectNumber} initialized — ${selectedCount} cylinder(s)`,
      });
      await sync();
      router.replace({ pathname: '/initialize/result', params: { id: clientRequestId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not queue this initialization.');
      setSubmitting(false);
    }
  };

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        {batch.projectNumber} · {batch.contents}
      </Text>
      {overrides.length > 0 ? (
        <Text style={{ color: '#b8860b', fontWeight: '600' }}>
          {overrides.length} of these were not scanned — they will be recorded as an admin override.
        </Text>
      ) : null}
      {!online ? (
        <Text style={styles.label}>
          Offline — this initialization is queued on the device and sent when signal returns. The
          photo goes with it.
        </Text>
      ) : null}

      <PhotoCapture
        title="Photograph the whole batch where it stands"
        hint={
          'Get all ' +
          `${selectedCount} cylinder(s) in frame, with their labels visible. The photo is stamped ` +
          'with the time and, where the phone can get a fix, the location.'
        }
        ctaLabel="Submit initialization"
        onDone={(taken) => {
          setPhoto(taken);
          void submit({ photo: taken, photoOverride: false });
        }}
        isAdmin={user?.role === 'ADMIN'}
        onOverride={() => {
          overridePhoto();
          void submit({ photo: null, photoOverride: true });
        }}
        busy={submitting}
        error={error}
      />

      {/* A photo already held from a failed submit — resubmit it rather than making
          the operator walk back to the batch and take it again. */}
      {(photo || photoOverride) && !submitting && error ? (
        <Text style={styles.label}>
          The photo is still held on this device. Tap the button above to try again.
        </Text>
      ) : null}
    </ScreenScroll>
  );
}
