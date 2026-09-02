import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CapturedPhoto } from '@gct/shared';
import type { CachedBatch, CachedCylinder, CachedSite } from '../db';

/**
 * Shared by Workflow B (transfer) and Workflow C (returns): both pick one active
 * batch, mirror it locally, then hold a set of verified scans until submission.
 * Each flow's `_layout` mounts its own provider, so a half-finished transfer and a
 * half-finished return never see each other's scans.
 */

/** One verified scan, held until the flow is submitted. */
export interface HeldScan {
  serialCode: string;
  /** The raw signed payload, forwarded so the server can re-verify it. */
  qrPayload: string;
  scannedAt: string;
}

interface ScanFlowValue {
  batch: CachedBatch | null;
  cylinders: CachedCylinder[];
  sites: CachedSite[];
  scans: HeldScan[];
  /**
   * Serials an ADMIN selected without scanning them.
   *
   * Held separately from `scans`, never merged into it, because they are not the same
   * evidence: a scan is a signed label the camera actually read, an override is an
   * admin's word for it. Keeping them apart here is what lets the request carry them
   * apart, which is what lets the movement log record which is which.
   */
  overrides: string[];

  /**
   * The batch photo, taken after the scan step and held until submission.
   *
   * Lives here rather than on the photo screen because the screen that takes it is not
   * the screen that submits: a transfer photographs the batch, then picks a
   * destination; a return photographs it, then collects a signature. Losing the photo
   * across that navigation would mean retaking it.
   */
  photo: CapturedPhoto | null;
  /**
   * An ADMIN chose to continue without a photo. Held separately from `photo` for the
   * same reason `overrides` is held apart from `scans`: they are different kinds of
   * claim, and the request carries them apart so the record can too.
   */
  photoOverride: boolean;

  selectBatch: (batch: CachedBatch, cylinders: CachedCylinder[], sites: CachedSite[]) => void;
  addScan: (scan: HeldScan) => void;
  removeScan: (serialCode: string) => void;
  clearScans: () => void;
  /** Select every cylinder not already scanned. Admin only — the caller checks. */
  overrideAll: () => void;
  /** Deselect one, whether it was scanned or overridden. */
  deselect: (serialCode: string) => void;
  clearOverrides: () => void;
  setPhoto: (photo: CapturedPhoto) => void;
  /** Admin only — the caller checks. */
  overridePhoto: () => void;
  reset: () => void;
}

const ScanFlowContext = createContext<ScanFlowValue | null>(null);

export function ScanFlowProvider({ children }: { children: ReactNode }) {
  const [batch, setBatch] = useState<CachedBatch | null>(null);
  const [cylinders, setCylinders] = useState<CachedCylinder[]>([]);
  const [sites, setSites] = useState<CachedSite[]>([]);
  const [scans, setScans] = useState<HeldScan[]>([]);
  const [overrides, setOverrides] = useState<string[]>([]);
  const [photo, setPhotoState] = useState<CapturedPhoto | null>(null);
  const [photoOverride, setPhotoOverride] = useState(false);

  const selectBatch = useCallback<ScanFlowValue['selectBatch']>((b, cyls, siteRows) => {
    setBatch(b);
    setCylinders(cyls);
    setSites(siteRows);
    // A new batch starts a new session — every kind of selection, and the evidence.
    setScans([]);
    setOverrides([]);
    setPhotoState(null);
    setPhotoOverride(false);
  }, []);

  const addScan = useCallback((scan: HeldScan) => {
    setScans((prev) =>
      prev.some((s) => s.serialCode === scan.serialCode) ? prev : [...prev, scan],
    );
  }, []);

  const removeScan = useCallback((serialCode: string) => {
    setScans((prev) => prev.filter((s) => s.serialCode !== serialCode));
  }, []);

  const clearScans = useCallback(() => {
    setScans([]);
    setOverrides([]);
  }, []);

  // Taking a photo supersedes a previous override: real evidence outranks the
  // assertion, which is the same rule the server applies to the pair.
  const setPhoto = useCallback((next: CapturedPhoto) => {
    setPhotoState(next);
    setPhotoOverride(false);
  }, []);

  const overridePhoto = useCallback(() => {
    setPhotoState(null);
    setPhotoOverride(true);
  }, []);

  const overrideAll = useCallback(() => {
    // Everything not already genuinely scanned. A real scan is never downgraded to an
    // override by pressing this — the stronger evidence stays.
    setOverrides(() => {
      const scanned = new Set(scans.map((s) => s.serialCode));
      return cylinders.map((c) => c.serialCode).filter((code) => !scanned.has(code));
    });
  }, [cylinders, scans]);

  const deselect = useCallback((serialCode: string) => {
    setScans((prev) => prev.filter((s) => s.serialCode !== serialCode));
    setOverrides((prev) => prev.filter((c) => c !== serialCode));
  }, []);

  const clearOverrides = useCallback(() => setOverrides([]), []);

  const reset = useCallback(() => {
    setBatch(null);
    setCylinders([]);
    setSites([]);
    setScans([]);
    setOverrides([]);
    setPhotoState(null);
    setPhotoOverride(false);
  }, []);

  const value = useMemo<ScanFlowValue>(
    () => ({
      batch,
      cylinders,
      sites,
      scans,
      overrides,
      photo,
      photoOverride,
      selectBatch,
      addScan,
      removeScan,
      clearScans,
      overrideAll,
      deselect,
      clearOverrides,
      setPhoto,
      overridePhoto,
      reset,
    }),
    [
      batch,
      cylinders,
      sites,
      scans,
      overrides,
      photo,
      photoOverride,
      selectBatch,
      addScan,
      removeScan,
      clearScans,
      overrideAll,
      deselect,
      clearOverrides,
      setPhoto,
      overridePhoto,
      reset,
    ],
  );

  return <ScanFlowContext.Provider value={value}>{children}</ScanFlowContext.Provider>;
}

export function useScanFlow(): ScanFlowValue {
  const ctx = useContext(ScanFlowContext);
  if (!ctx) throw new Error('useScanFlow must be used within <ScanFlowProvider>');
  return ctx;
}
