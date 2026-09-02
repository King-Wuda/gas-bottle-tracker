import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import * as Crypto from 'expo-crypto';
import type { BatchDto, BatchLineInput } from '@gct/shared';

export interface DraftLine extends BatchLineInput {
  /** local id for list keys */
  key: string;
  /** Display names for the draft list. The request carries the ids; these are what a
   *  human reads back before committing, so they travel with the line. */
  gasTypeName: string;
  supplierName: string;
}

export interface CreatedBatch {
  batch: BatchDto;
  serials: string[];
}

interface NewFlowValue {
  projectId: string | null;
  siteId: string | null;
  projectNumber: string | null;
  siteName: string | null;
  lines: DraftLine[];
  /**
   * The batch's idempotency key, minted ONCE when the draft's first line is added —
   * never at submit time.
   *
   * The whole draft is now one batch, so there is one key for the whole draft. A
   * retry after a timeout replays it, and the server returns the batch it already
   * created rather than allocating a second set of serials and emailing the PM a
   * duplicate QR sheet. It is deliberately NOT re-minted when lines are added or
   * removed afterwards: a submission that timed out but actually landed must still
   * be recognisable as the same one.
   */
  clientRequestId: string | null;
  result: CreatedBatch | null;

  setTarget: (v: {
    projectId: string;
    siteId: string;
    projectNumber: string;
    siteName: string;
  }) => void;
  addLine: (line: Omit<DraftLine, 'key'>) => void;
  removeLine: (key: string) => void;
  setResult: (r: CreatedBatch) => void;
  reset: () => void;
}

const NewFlowContext = createContext<NewFlowValue | null>(null);

const nextKey = (): string => Crypto.randomUUID();

export function NewFlowProvider({ children }: { children: ReactNode }) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [projectNumber, setProjectNumber] = useState<string | null>(null);
  const [siteName, setSiteName] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [clientRequestId, setClientRequestId] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedBatch | null>(null);

  const setTarget = useCallback<NewFlowValue['setTarget']>((v) => {
    setProjectId(v.projectId);
    setSiteId(v.siteId);
    setProjectNumber(v.projectNumber);
    setSiteName(v.siteName);
  }, []);

  const addLine = useCallback<NewFlowValue['addLine']>((line) => {
    // Adding a line only appends to the draft — nothing is created until the batch is
    // submitted. The key is minted here, on the first line, because that is the point
    // at which there is an intent to create something.
    setClientRequestId((id) => id ?? Crypto.randomUUID());
    setLines((prev) => [...prev, { ...line, key: nextKey() }]);
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }, []);

  const reset = useCallback(() => {
    setProjectId(null);
    setSiteId(null);
    setProjectNumber(null);
    setSiteName(null);
    setLines([]);
    setClientRequestId(null);
    setResult(null);
  }, []);

  const value = useMemo<NewFlowValue>(
    () => ({
      projectId,
      siteId,
      projectNumber,
      siteName,
      lines,
      clientRequestId,
      result,
      setTarget,
      addLine,
      removeLine,
      setResult,
      reset,
    }),
    [
      projectId,
      siteId,
      projectNumber,
      siteName,
      lines,
      clientRequestId,
      result,
      setTarget,
      addLine,
      removeLine,
      reset,
    ],
  );

  return <NewFlowContext.Provider value={value}>{children}</NewFlowContext.Provider>;
}

export function useNewFlow(): NewFlowValue {
  const ctx = useContext(NewFlowContext);
  if (!ctx) throw new Error('useNewFlow must be used within <NewFlowProvider>');
  return ctx;
}
