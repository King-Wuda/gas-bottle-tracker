import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import type { CapturedPhoto, CreateReturnRequest } from '@gct/shared';
import { apiReadDriverId } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { IdCapture } from '../../src/components/IdCapture';
import { SignaturePad } from '../../src/components/SignaturePad';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { hasInk, renderSignature, type Stroke } from '../../src/signature/raster';
import { playCue } from '../../src/sound';
import { useSync } from '../../src/sync/SyncContext';
import { enqueueMutation } from '../../src/sync/worker';
import {
  Card,
  ErrorText,
  Field,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';

/**
 * Workflow C4 — the driver's details, then C5 submits.
 *
 * ## What is collected, and why each part is here
 *
 * The signature is evidence that a named person took the cylinders. On its own it is
 * a squiggle over a name somebody typed, so it is now collected alongside the number
 * off the driver's ID and a photograph of that document: together they are what makes
 * "who took them" checkable months later, when the batch is being reconciled and the
 * driver is long gone. All four are on ONE screen because they are one conversation
 * at the gate — the driver hands over their ID, the manager reads the number off it,
 * photographs it, and hands the phone over to sign.
 *
 * Nothing is submitted until the name, the number, the ID evidence and a drawn
 * signature all exist; the server refuses the submission otherwise, so a screen that
 * let it through would only move the failure somewhere less useful.
 */
export default function Sign() {
  const router = useRouter();
  const { batch, scans, overrides, photo, photoOverride } = useScanFlow();
  const { sync, online } = useSync();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [driverName, setDriverName] = useState('');
  const [driverIdNumber, setDriverIdNumber] = useState('');
  const [driverIdPhoto, setDriverIdPhoto] = useState<CapturedPhoto | null>(null);
  const [driverIdOverride, setDriverIdOverride] = useState(false);
  /** What the server read off the ID photo, and how it went. Never applied over
   *  something the operator typed — see `reading` below. */
  const [reading, setReading] = useState<
    | { state: 'idle' }
    | { state: 'busy' }
    | { state: 'read'; idNumber: string; description: string }
    | { state: 'none'; reason: string }
  >({ state: 'idle' });
  // The strokes, plus the box of the pad they were drawn on — the rasteriser needs
  // both to fit the drawing onto the fixed-size output PNG without distorting it.
  const [signature, setSignature] = useState<{
    strokes: Stroke[];
    pad: { width: number; height: number };
  }>({ strokes: [], pad: { width: 0, height: 0 } });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSign = useCallback(
    (strokes: Stroke[], pad: { width: number; height: number }) => setSignature({ strokes, pad }),
    [],
  );

  // Read once per photo. Held in a ref rather than derived from `reading`, so that
  // dismissing a suggestion does not immediately re-request the same one.
  const readFor = useRef<string | null>(null);
  const idPhotoData = driverIdPhoto?.imageBase64 ?? null;

  useEffect(() => {
    if (!idPhotoData || !online || readFor.current === idPhotoData) return;
    readFor.current = idPhotoData;
    let cancelled = false;
    setReading({ state: 'busy' });
    apiReadDriverId({ imageBase64: idPhotoData })
      .then((r) => {
        if (cancelled) return;
        setReading(
          r.idNumber && r.description
            ? { state: 'read', idNumber: r.idNumber, description: r.description }
            : { state: 'none', reason: r.reason ?? 'The number could not be read.' },
        );
      })
      .catch(() => {
        // A convenience that failed is not an error worth putting in front of
        // someone: the number is typed in exactly as it was before this existed.
        if (!cancelled) setReading({ state: 'idle' });
      });
    return () => {
      cancelled = true;
    };
  }, [idPhotoData, online]);

  if (!batch || scans.length + overrides.length === 0) return <Redirect href="/returns" />;
  // See transfer/destination.tsx: the driver must not sign for a return the server
  // will refuse for want of a photo.
  if (!photo && !photoOverride) return <Redirect href="/returns/photo" />;

  const selectedCount = scans.length + overrides.length;
  const signed = hasInk(signature.strokes);
  const idEvidence = driverIdPhoto !== null || driverIdOverride;
  const ready =
    driverName.trim().length > 0 && driverIdNumber.trim().length >= 4 && idEvidence && signed;

  const submit = async () => {
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    // The submit cue: a struck steel cylinder. It fires on the press rather than on
    // the server's reply, because it is confirming the TAP — and the reply may not
    // come for hours, this being a submission that is durable in the outbox first and
    // sent over the wire second.
    playCue('clang');
    try {
      // Rasterised HERE rather than on every pen stroke: it is a 600x220 raster and a
      // deflate pass, which is nothing once but wasteful sixty times a second.
      const { dataUrl: signaturePng, inkedPixels } = renderSignature(
        signature.strokes,
        signature.pad.width,
        signature.pad.height,
      );
      // Strokes that never reached the canvas are still strokes. Refusing here is
      // what keeps a blank signature — a valid PNG of white paper — from being filed
      // as the proof that a named person took the cylinders. See signature/raster.ts.
      if (inkedPixels === 0) {
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
        driverName: driverName.trim(),
        driverIdNumber: driverIdNumber.trim(),
        driverIdPhoto,
        // Real evidence outranks an assertion: if a photo was taken after all, the
        // waiver is dropped rather than recorded alongside it.
        driverIdOverride: driverIdPhoto === null && driverIdOverride,
        signaturePng,
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

  /** What is still missing, named — a disabled button with no reason is a dead end. */
  const blocker =
    driverName.trim().length === 0
      ? 'Enter the driver’s name'
      : driverIdNumber.trim().length < 4
        ? 'Enter the driver’s ID number'
        : !idEvidence
          ? 'Photograph the driver’s ID'
          : !signed
            ? 'The driver must sign above'
            : null;

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
          photo, the ID and the signature go with it.
        </Text>
      ) : null}

      <Card>
        <Field
          label="Collection driver name"
          value={driverName}
          onChangeText={setDriverName}
          autoCapitalize="words"
          placeholder="As it appears on their ID"
          editable={!submitting}
        />
        <Field
          label="Driver ID number"
          value={driverIdNumber}
          onChangeText={setDriverIdNumber}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="ID, passport or licence number"
          editable={!submitting}
        />
        <Text style={styles.label}>
          Whatever document they are carrying — an ID card, a passport, a foreign licence. Type it
          exactly as printed.
        </Text>
      </Card>

      <Card>
        <IdCapture
          photo={driverIdPhoto}
          onCaptured={(taken) => {
            setDriverIdPhoto(taken);
            setDriverIdOverride(false);
          }}
          onClear={() => {
            setDriverIdPhoto(null);
            setDriverIdOverride(false);
            setReading({ state: 'idle' });
          }}
          overridden={driverIdOverride}
          isAdmin={isAdmin}
          onOverride={() => setDriverIdOverride(true)}
          disabled={submitting}
        />

        {/* What the server made of the photograph. Always a suggestion: the operator
            is holding the document, and the app is not. */}
        {reading.state === 'busy' ? (
          <Text style={styles.label}>Reading the number off the photo…</Text>
        ) : null}
        {reading.state === 'read' ? (
          <View style={{ gap: 6 }}>
            <Text style={{ fontWeight: '700' }}>Read from the photo</Text>
            <Text style={{ fontFamily: 'monospace' }}>{reading.description}</Text>
            <Text style={styles.label}>
              Check it against the card before you use it. The checksum on the number is valid,
              which is not the same as it being this driver&apos;s.
            </Text>
            <SecondaryButton
              title={
                driverIdNumber.trim().length === 0
                  ? 'Use this number'
                  : 'Replace what I typed with this'
              }
              onPress={() => {
                setDriverIdNumber(reading.idNumber);
                setReading({ state: 'idle' });
              }}
              disabled={submitting}
            />
          </View>
        ) : null}
        {reading.state === 'none' ? <Text style={styles.label}>{reading.reason}</Text> : null}
        {!online && driverIdPhoto ? (
          <Text style={styles.label}>
            Offline — the number cannot be read off the photo from here. Type it in; the photo is
            queued with the return either way.
          </Text>
        ) : null}
      </Card>

      <View style={{ gap: 6 }}>
        <Text style={styles.label}>Driver signature</Text>
        <SignaturePad onChange={onSign} />
      </View>

      <Text style={styles.label}>
        The driver signs above, then the return is submitted. A signed delivery note carrying the
        signature and the ID is emailed to the project manager.
      </Text>

      <ErrorText>{error}</ErrorText>

      <PrimaryButton
        title={submitting ? 'Submitting…' : (blocker ?? 'Sign & submit')}
        onPress={() => void submit()}
        disabled={!ready}
        busy={submitting}
      />
    </ScreenScroll>
  );
}
