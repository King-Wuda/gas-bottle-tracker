import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapturedPhoto } from '@gct/shared';
import { apiReadDriverId } from '../api/client';
import { hasInk, renderSignature, type Stroke } from '../signature/raster';

/**
 * Everything the driver sign-off collects, and the rules about when it is complete.
 *
 * Shared by Workflow B (transfer) and Workflow C (return). Both hand physical
 * cylinders to a named person who is not the operator, and both need the same four
 * things: a name, the number off a document, a photograph of that document, and a
 * signature. Duplicating the state machine, the OCR call and the readiness rules
 * across two screens would have guaranteed they drifted — and the half that drifted
 * would be the one nobody was looking at.
 */

/** What the server was able to read off the ID photo, and how that went. */
type Reading =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'read'; idNumber: string; description: string }
  | { state: 'none'; reason: string };

export interface DriverSignOff {
  driverName: string;
  setDriverName: (v: string) => void;
  driverIdNumber: string;
  setDriverIdNumber: (v: string) => void;
  driverIdPhoto: CapturedPhoto | null;
  driverIdOverride: boolean;
  captureId: (photo: CapturedPhoto) => void;
  clearId: () => void;
  overrideId: () => void;
  reading: Reading;
  acceptReading: (idNumber: string) => void;
  onSign: (strokes: Stroke[], pad: { width: number; height: number }) => void;
  signed: boolean;
  /** True when everything the server requires is present. */
  ready: boolean;
  /** What is still missing, in words — a disabled button with no reason is a dead end. */
  blocker: string | null;
  /**
   * The submission fields, or `null` when the signature rasterised blank.
   *
   * Rasterised HERE rather than on every pen stroke: it is a 600x220 raster and a
   * deflate pass, which is nothing once and wasteful sixty times a second.
   */
  build: () => {
    driverName: string;
    driverIdNumber: string;
    driverIdPhoto: CapturedPhoto | null;
    driverIdOverride: boolean;
    signaturePng: string;
  } | null;
}

export function useDriverSignOff({ online }: { online: boolean }): DriverSignOff {
  const [driverName, setDriverName] = useState('');
  const [driverIdNumber, setDriverIdNumber] = useState('');
  const [driverIdPhoto, setDriverIdPhoto] = useState<CapturedPhoto | null>(null);
  const [driverIdOverride, setDriverIdOverride] = useState(false);
  const [reading, setReading] = useState<Reading>({ state: 'idle' });
  // The strokes, plus the box of the pad they were drawn on — the rasteriser needs
  // both to fit the drawing onto the fixed-size output PNG without distorting it.
  const [signature, setSignature] = useState<{
    strokes: Stroke[];
    pad: { width: number; height: number };
  }>({ strokes: [], pad: { width: 0, height: 0 } });

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

  const signed = hasInk(signature.strokes);
  const idEvidence = driverIdPhoto !== null || driverIdOverride;
  const ready =
    driverName.trim().length > 0 && driverIdNumber.trim().length >= 4 && idEvidence && signed;

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

  return {
    driverName,
    setDriverName,
    driverIdNumber,
    setDriverIdNumber,
    driverIdPhoto,
    driverIdOverride,
    captureId: (photo) => {
      setDriverIdPhoto(photo);
      setDriverIdOverride(false);
    },
    clearId: () => {
      setDriverIdPhoto(null);
      setDriverIdOverride(false);
      setReading({ state: 'idle' });
    },
    overrideId: () => setDriverIdOverride(true),
    reading,
    acceptReading: (idNumber) => {
      setDriverIdNumber(idNumber);
      setReading({ state: 'idle' });
    },
    onSign,
    signed,
    ready,
    blocker,
    build: () => {
      const { dataUrl: signaturePng, inkedPixels } = renderSignature(
        signature.strokes,
        signature.pad.width,
        signature.pad.height,
      );
      // Strokes that never reached the canvas are still strokes. Refusing here is
      // what keeps a blank signature — a valid PNG of white paper — from being filed
      // as the proof that a named person took the cylinders. See signature/raster.ts.
      if (inkedPixels === 0) return null;
      return {
        driverName: driverName.trim(),
        driverIdNumber: driverIdNumber.trim(),
        driverIdPhoto,
        // Real evidence outranks an assertion: if a photo was taken after all, the
        // waiver is dropped rather than recorded alongside it.
        driverIdOverride: driverIdPhoto === null && driverIdOverride,
        signaturePng,
      };
    },
  };
}
