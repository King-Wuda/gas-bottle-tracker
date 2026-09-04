import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { CapturedPhoto } from '@gct/shared';
import { buildCapturedPhoto } from '../photo/capture';
import { PrimaryButton, SecondaryButton, styles as base } from '../ui/components';

/**
 * Photographing the collection driver's ID document, on the driver details screen.
 *
 * ## Why this is not `PhotoCapture`
 *
 * `PhotoCapture` owns a whole screen: it is the step, and its call to action submits
 * the work. This is one field among several on a form the driver is filling in with
 * the stores manager, so it has to stay folded away until it is used and give the
 * screen back afterwards. Sharing one component between the two would mean a prop
 * that turns half of it off, which is how a component ends up serving neither case.
 *
 * What it DOES share is `buildCapturedPhoto`, so an ID photo is compressed, stamped
 * with both clocks and positioned by exactly the same code as a batch photo. The
 * evidence is the same kind of thing; only the framing differs.
 *
 * ## The override
 *
 * Same shape as the camera override on `PhotoCapture`, and for the same reason: the
 * camera can be the thing that has failed, and the alternative to an admin waiving it
 * is a driver standing at the gate with cylinders on a truck. It is recorded as a
 * waiver, never as a photo — see `schemas/return.ts`.
 *
 * ## Why there is no barcode reader here
 *
 * There was one, briefly, and it was removed: it could not help with the documents
 * South African drivers actually carry, so it was a second capture mode that mostly
 * failed.
 *
 * - The **green ID book** has no barcode at all.
 * - The **smart ID card** has a PDF417 whose contents are encrypted with keys the
 *   Department of Home Affairs does not publish. There is no legitimate decoder.
 * - The **driving licence** also encrypts its PDF417. Its keys were reverse-engineered
 *   years ago and circulate publicly, but decoding it means relying on unofficial keys
 *   to extract identity data, which is not something to do quietly inside a stock app.
 *
 * Taking a picture works on all three. The number is read off that picture by
 * `POST /driver-id/read`, which is a suggestion the operator accepts — not a scan
 * they have to get to succeed before they can carry on.
 */
export function IdCapture({
  photo,
  onCaptured,
  onClear,
  overridden,
  isAdmin,
  onOverride,
  disabled = false,
}: {
  photo: CapturedPhoto | null;
  onCaptured: (photo: CapturedPhoto) => void;
  onClear: () => void;
  overridden: boolean;
  isAdmin: boolean;
  onOverride: () => void;
  disabled?: boolean;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const camera = useRef<CameraView>(null);

  const take = useCallback(async () => {
    if (!camera.current) return;
    setCapturing(true);
    setError(null);
    try {
      const shot = await camera.current.takePictureAsync({ quality: 1, skipProcessing: true });
      if (!shot?.uri) throw new Error('The camera did not return an image.');
      onCaptured(await buildCapturedPhoto({ uri: shot.uri }));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not photograph the ID.');
    } finally {
      setCapturing(false);
    }
  }, [onCaptured]);

  const openCamera = async () => {
    setError(null);
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setError('Camera access is needed to photograph the ID.');
        return;
      }
    }
    setOpen(true);
  };

  // ---- captured ----
  if (photo) {
    return (
      <View style={styles.wrap}>
        <Text style={base.label}>Driver ID document</Text>
        <Image
          source={{ uri: photo.imageBase64 }}
          style={styles.preview}
          resizeMode="contain"
          accessibilityLabel="The photograph of the driver's ID"
        />
        <Text style={styles.note}>
          Captured {new Date(photo.capturedAt).toLocaleString()}. It goes on the delivery note
          beside the signature.
        </Text>
        <SecondaryButton title="Retake the ID photo" onPress={onClear} disabled={disabled} />
      </View>
    );
  }

  // ---- waived ----
  if (overridden) {
    return (
      <View style={styles.wrap}>
        <Text style={base.label}>Driver ID document</Text>
        <View style={styles.waived}>
          <Text style={styles.waivedText}>No ID photo — admin override</Text>
          <Text style={styles.note}>
            Recorded as a waiver, not as a document. The ID number below is the only identification
            on this return.
          </Text>
        </View>
        <SecondaryButton
          title="Photograph the ID after all"
          onPress={onClear}
          disabled={disabled}
        />
      </View>
    );
  }

  // ---- viewfinder ----
  if (open) {
    return (
      <View style={styles.wrap}>
        <Text style={base.label}>Driver ID document</Text>
        <View style={styles.viewfinder}>
          <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />
          <View style={styles.guide} pointerEvents="none" />
        </View>
        <Text style={styles.note}>
          Fill the frame with the ID card or book, with the photograph and the number both legible.
        </Text>
        {error ? <Text style={base.error}>{error}</Text> : null}
        <PrimaryButton
          title={capturing ? 'Capturing…' : 'Capture the ID'}
          onPress={() => void take()}
          busy={capturing}
        />
        {capturing ? <ActivityIndicator /> : null}
        <SecondaryButton title="Cancel" onPress={() => setOpen(false)} disabled={capturing} />
      </View>
    );
  }

  // ---- collapsed ----
  return (
    <View style={styles.wrap}>
      <Text style={base.label}>Driver ID document</Text>
      <Text style={styles.note}>
        A photo of the ID the driver is presenting. It is what ties the name and number above to the
        person who actually took the cylinders — and the number is read off it for you.
      </Text>
      {error ? <Text style={base.error}>{error}</Text> : null}
      <SecondaryButton
        title="Photograph the driver's ID"
        onPress={() => void openCamera()}
        disabled={disabled}
      />
      {isAdmin ? (
        <Pressable
          role="button"
          onPress={onOverride}
          disabled={disabled}
          style={[styles.override, disabled && { opacity: 0.5 }]}
        >
          <Text style={styles.overrideText}>Continue without an ID photo (admin)</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  note: { opacity: 0.7, fontSize: 13 },
  viewfinder: { height: 240, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' },
  // An ID document is a landscape card; the guide says where to put it.
  guide: {
    position: 'absolute',
    top: '14%',
    left: '8%',
    right: '8%',
    bottom: '14%',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.8)',
    borderRadius: 8,
  },
  preview: { height: 200, borderRadius: 12, backgroundColor: '#111' },
  waived: { backgroundColor: 'rgba(184,134,11,0.18)', borderRadius: 10, padding: 12, gap: 4 },
  waivedText: { fontWeight: '700', color: '#b8860b' },
  override: {
    borderWidth: 1,
    borderColor: '#b8860b',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  overrideText: { color: '#b8860b', fontSize: 15, fontWeight: '700' },
});
