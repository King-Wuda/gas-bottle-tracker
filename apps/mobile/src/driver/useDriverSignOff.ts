import { useCallback, useState } from 'react';
import { driverEmailSchema, driverPhoneSchema } from '@gct/shared';
import type { CachedDriver } from '../db';
import { hasInk, renderSignature, type Stroke } from '../signature/raster';
import { useDriverProfiles } from './drivers';

/**
 * Everything the driver sign-off collects, and the rules about when it is complete.
 *
 * Shared by Workflow B (transfer) and Workflow C (return). Both hand physical
 * cylinders to a named person who is not the operator, and both need the same things:
 * who the driver is, how to reach them, and their signature.
 *
 * Who the driver is comes one of two ways. A regular is PICKED from the driver
 * profiles a project manager keeps (Admin console → Drivers), so their details are
 * never re-typed. Anyone else is entered on the spot by ticking "Driver not
 * registered" and typing their name, email and phone. Either way the submission
 * carries the name, email and phone: the server copies a registered driver's from
 * their profile, and an offline submission still says who it was if the profile has
 * gone by the time it syncs.
 */
export interface DriverSignOff {
  /** The active profiles, cached for use with no signal. */
  profiles: CachedDriver[];
  profilesLoaded: boolean;
  /** The picked profile, when the driver is registered. */
  selectedId: string | null;
  select: (id: string) => void;
  selected: CachedDriver | null;
  /** Ticked: the driver is not registered and their details are typed in. */
  unregistered: boolean;
  setUnregistered: (v: boolean) => void;
  driverName: string;
  setDriverName: (v: string) => void;
  driverEmail: string;
  setDriverEmail: (v: string) => void;
  driverPhone: string;
  setDriverPhone: (v: string) => void;
  /** True once something is typed that the server would not accept. */
  driverEmailInvalid: boolean;
  driverPhoneInvalid: boolean;
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
    driverId: string | null;
    driverName: string;
    driverEmail: string;
    driverPhone: string;
    signaturePng: string;
  } | null;
}

export function useDriverSignOff({ online }: { online: boolean }): DriverSignOff {
  const { drivers: profiles, loaded: profilesLoaded } = useDriverProfiles({ online });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unregistered, setUnregistered] = useState(false);
  const [driverName, setDriverName] = useState('');
  const [driverEmail, setDriverEmail] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
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

  const selected = profiles.find((d) => d.id === selectedId) ?? null;
  const signed = hasInk(signature.strokes);

  // The same rules the server applies, so the button cannot enable on details that
  // would then be refused — on a queued submission, refused hours later.
  const emailOk = driverEmailSchema.safeParse(driverEmail).success;
  const phoneOk = driverPhoneSchema.safeParse(driverPhone).success;

  const blocker = !unregistered
    ? selected
      ? null
      : profiles.length === 0
        ? 'Tick “Driver not registered” and enter their details'
        : 'Choose the driver'
    : driverName.trim().length === 0
      ? 'Enter the driver’s name and surname'
      : !emailOk
        ? 'Enter the driver’s email address'
        : !phoneOk
          ? 'Enter the driver’s phone number'
          : null;
  const blockerWithSignature = blocker ?? (signed ? null : 'The driver must sign above');

  return {
    profiles,
    profilesLoaded,
    selectedId,
    select: setSelectedId,
    selected,
    unregistered,
    setUnregistered,
    driverName,
    setDriverName,
    driverEmail,
    setDriverEmail,
    driverPhone,
    setDriverPhone,
    driverEmailInvalid: driverEmail.trim().length > 0 && !emailOk,
    driverPhoneInvalid: driverPhone.trim().length > 0 && !phoneOk,
    onSign,
    signed,
    ready: blockerWithSignature === null,
    blocker: blockerWithSignature,
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
      if (!unregistered && selected) {
        return {
          driverId: selected.id,
          driverName: selected.fullName,
          driverEmail: selected.email,
          driverPhone: selected.phone,
          signaturePng,
        };
      }
      return {
        driverId: null,
        driverName: driverName.trim(),
        driverEmail: driverEmail.trim().toLowerCase(),
        driverPhone: driverPhone.trim(),
        signaturePng,
      };
    },
  };
}
