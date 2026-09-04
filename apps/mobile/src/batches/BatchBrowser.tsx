import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  formatBatchDate,
  type BatchListScope,
  type BatchSummary,
  type GasTypeDto,
  type ProjectManagerDto,
  type SupplierDto,
} from '@gct/shared';
import {
  ApiError,
  apiGasTypes,
  apiListBatches,
  apiProjectManagers,
  apiSuppliers,
} from '../api/client';
import {
  Card,
  EmptyState,
  ErrorState,
  ErrorText,
  Field,
  LoadingState,
  ScreenScroll,
} from '../ui/components';
import { Chip, Select, StatusBadge, type BadgeTone } from '../ui/controls';
import { BatchContents } from './BatchContents';
import { colors, radius, space, type } from '../ui/theme';

/**
 * The batch list, search and filter panel shared by Transfer, Returns and History.
 *
 * Sections 8-10 of the change spec are one component on purpose. The three tabs differ
 * in exactly one respect — which batches they hide by default — and that is passed in
 * as `scope` rather than branched on inside, so adding a fourth view is a call site
 * and not an `if`. Everything else (live search, the three attribute filters, the
 * chips, the count, the empty state, the row) is defined once here.
 *
 * Filtering happens on the SERVER, not over a page of rows already fetched. The list
 * is capped, so client-side filtering would search only the newest 200 batches and
 * quietly report "no matches" for a project sitting at number 201.
 */

/** How one tab narrows the shared list. */
export interface BatchBrowserConfig {
  scope: BatchListScope;
  /**
   * `active` drops fully-returned batches outright — right for Transfer and Returns,
   * where a returned cylinder can neither move nor come back again. `all` keeps them,
   * which is what History wants.
   *
   * Note what is NOT here any more: the "include already-transferred" and "include
   * already-returned" toggles. They existed because a batch was assumed to move once,
   * all at once, so having moved meant having finished. Partial movement makes that
   * false — 3 of 7 nitrogen going to site leaves 4 that still have to be transferable
   * — so a batch that has moved stays in the list, as many times as it takes.
   */
  status: 'active' | 'all';
  intro: string;
  /** Shown when the tab has no batches at all, as opposed to none matching a search. */
  emptyTitle: string;
  emptyHint: string;
}

interface Props {
  config: BatchBrowserConfig;
  onPick: (batch: BatchSummary) => void;
  /** Row spinner while the caller mirrors the batch for offline scanning. */
  busyBatchId?: string | null;
  /** Surfaced under the search bar — the caller's own failure, not the list's. */
  error?: string | null;
  /** Tab-specific affordance rendered above the search bar (History's serial lookup). */
  headerExtra?: ReactNode;
}

const SEARCH_DEBOUNCE_MS = 200;

/**
 * The badge now describes where the batch IS, not what has happened to it once.
 *
 * "Transferred" was a fact about the past that read as a terminal state, which is
 * wrong for a batch that is half at stores and half on site — the half at stores is
 * still available to move. So a split batch says so, and the exact numbers are one
 * line below in the contents block.
 */
function badgeFor(b: BatchSummary): { label: string; tone: BadgeTone } {
  if (b.returnedAt) return { label: 'Returned', tone: 'done' };
  // Ahead of the location badges: until a batch is initialized nothing in it can move,
  // so "At stores" would describe cylinders that cannot leave.
  if (!b.initializedAt) return { label: 'Not initialized', tone: 'moved' };
  if (b.status === 'PARTIAL') return { label: 'Partly returned', tone: 'moved' };

  const live = b.distribution.filter((d) => d.kind !== 'RETURNED');
  const atStores = live.filter((d) => d.kind === 'STORES').reduce((n, d) => n + d.count, 0);
  const onSite = live.filter((d) => d.kind === 'SITE').reduce((n, d) => n + d.count, 0);

  if (atStores > 0 && onSite > 0) return { label: 'Split', tone: 'moved' };
  if (onSite > 0) return { label: 'On site', tone: 'moved' };
  return { label: 'At stores', tone: 'neutral' };
}

export function BatchBrowser({
  config,
  onPick,
  busyBatchId = null,
  error = null,
  headerExtra = null,
}: Props) {
  // --- filter state ---
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [projectManagerId, setProjectManagerId] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [gasTypeId, setGasTypeId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // --- data ---
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [matched, setMatched] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // --- filter dropdown options ---
  const [managers, setManagers] = useState<ProjectManagerDto[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierDto[]>([]);
  const [gasTypes, setGasTypes] = useState<GasTypeDto[]>([]);

  useEffect(() => {
    // Best effort: an empty filter dropdown is a degraded panel, not a broken screen,
    // so a failure here must not take the list down with it.
    void Promise.allSettled([apiProjectManagers(), apiSuppliers(), apiGasTypes()]).then(
      ([pm, sup, gas]) => {
        if (pm.status === 'fulfilled') setManagers(pm.value.projectManagers);
        if (sup.status === 'fulfilled') setSuppliers(sup.value.suppliers);
        if (gas.status === 'fulfilled') setGasTypes(gas.value.gasTypes);
      },
    );
  }, []);

  // Debounced so a five-letter project number is one request, not five.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  /**
   * Monotonic request id. Live filtering fires overlapping requests and they can
   * complete out of order — without this, a slow response for "12" can land after a
   * fast one for "123" and repopulate the list with results for text no longer in the
   * box.
   */
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    setListError(null);
    try {
      const res = await apiListBatches({
        scope: config.scope,
        status: config.status,
        ...(debouncedQ ? { q: debouncedQ } : {}),
        ...(projectManagerId ? { projectManagerId } : {}),
        ...(supplierId ? { supplierId } : {}),
        ...(gasTypeId ? { gasTypeId } : {}),
      });
      if (ticket !== latest.current) return;
      setBatches(res.batches);
      setMatched(res.matched);
      setTotal(res.total);
    } catch (e) {
      if (ticket !== latest.current) return;
      setListError(e instanceof ApiError ? e.message : 'Could not load batches.');
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [config.scope, config.status, debouncedQ, projectManagerId, supplierId, gasTypeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const managerName = (id: string): string => managers.find((m) => m.id === id)?.name ?? 'Manager';
  const supplierName = (id: string): string =>
    suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
  const gasName = (id: string): string => gasTypes.find((g) => g.id === id)?.name ?? 'Gas';

  const chips = useMemo(() => {
    const out: { key: string; label: string; clear: () => void }[] = [];
    if (debouncedQ) {
      out.push({ key: 'q', label: `"${debouncedQ}"`, clear: () => setQ('') });
    }
    if (projectManagerId) {
      out.push({
        key: 'pm',
        label: `PM: ${managerName(projectManagerId)}`,
        clear: () => setProjectManagerId(null),
      });
    }
    if (supplierId) {
      out.push({
        key: 'sup',
        label: `Supplier: ${supplierName(supplierId)}`,
        clear: () => setSupplierId(null),
      });
    }
    if (gasTypeId) {
      out.push({
        key: 'gas',
        label: `Gas: ${gasName(gasTypeId)}`,
        clear: () => setGasTypeId(null),
      });
    }
    return out;
  }, [debouncedQ, projectManagerId, supplierId, gasTypeId, managers, suppliers, gasTypes]);

  const clearAll = (): void => {
    setQ('');
    setProjectManagerId(null);
    setSupplierId(null);
    setGasTypeId(null);
  };

  return (
    <ScreenScroll>
      <Text style={rowStyles.intro}>{config.intro}</Text>

      {headerExtra}

      <Field
        label="Search project number or project manager"
        value={q}
        onChangeText={setQ}
        placeholder="123456-789-1-23 or a name"
        autoCorrect={false}
        // No submit button and no returnKeyType="search": the list narrows on each
        // keystroke, so there is nothing to submit.
      />

      {/* The filter toggle sizes to its label rather than stretching: a full-width
          secondary button reads as the screen's main action, and it is not. */}
      <View style={rowStyles.filterRow}>
        <Pressable
          role="button"
          aria-expanded={panelOpen}
          onPress={() => setPanelOpen((o) => !o)}
          style={({ pressed }) => [
            rowStyles.filterButton,
            (panelOpen || pressed) && rowStyles.filterButtonOn,
          ]}
        >
          <Text style={rowStyles.filterButtonText}>{panelOpen ? 'Hide filters' : 'Filters'}</Text>
        </Pressable>
        <Text style={rowStyles.count}>
          {matched} of {total} batches
        </Text>
      </View>

      {panelOpen ? (
        <Card>
          <Select
            label="Project manager"
            placeholder="Any project manager"
            value={projectManagerId}
            onChange={setProjectManagerId}
            options={managers.map((m) => ({ value: m.id, label: m.name, hint: m.email }))}
          />
          <Select
            label="Supplier"
            placeholder="Any supplier"
            value={supplierId}
            onChange={setSupplierId}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            label="Gas type"
            placeholder="Any gas"
            value={gasTypeId}
            onChange={setGasTypeId}
            options={gasTypes.map((g) => ({ value: g.id, label: g.name }))}
          />
        </Card>
      ) : null}

      {chips.length > 0 ? (
        <View style={rowStyles.chipRow}>
          {chips.map((c) => (
            <Chip key={c.key} label={c.label} onRemove={c.clear} />
          ))}
          <Pressable role="button" onPress={clearAll} style={rowStyles.clearAll}>
            <Text style={rowStyles.clearAllText}>Clear all</Text>
          </Pressable>
        </View>
      ) : null}

      <ErrorText>{error}</ErrorText>

      {listError ? (
        <ErrorState message={listError} onRetry={() => void load()} retryLabel="Try again" />
      ) : loading && batches.length === 0 ? (
        <LoadingState label="Loading batches..." />
      ) : batches.length === 0 ? (
        // "Nothing here yet" and "nothing matched" are different problems with
        // different fixes, so they get different words.
        chips.length > 0 ? (
          <EmptyState
            title="No batches match your search."
            hint="Clear a filter or try a different project number."
            actionLabel="Clear all filters"
            onAction={clearAll}
          />
        ) : (
          <EmptyState title={config.emptyTitle} hint={config.emptyHint} />
        )
      ) : (
        batches.map((b) => {
          const badge = badgeFor(b);
          const outstanding = b.cylinderCount - b.returnedCount;
          return (
            <Card key={b.id} onPress={() => onPick(b)}>
              <View style={rowStyles.cardHead}>
                <Text style={rowStyles.projectNumber}>{b.projectNumber}</Text>
                <StatusBadge label={badge.label} tone={badge.tone} />
              </View>
              <Text style={rowStyles.where}>
                {b.projectManagerName} · {b.siteName}
              </Text>

              {/* Contents AND where each gas actually is — the partial-movement fact
                  this list exists to communicate. */}
              <View style={rowStyles.contents}>
                <BatchContents lines={b.lines} distribution={b.distribution} compact />
              </View>

              <View style={rowStyles.cardFoot}>
                <Text style={rowStyles.meta}>{formatBatchDate(b.createdAt)}</Text>
                <Text style={rowStyles.metaDot}>·</Text>
                <Text style={[rowStyles.meta, outstanding > 0 && rowStyles.metaOut]}>
                  {outstanding} of {b.cylinderCount} still out
                </Text>
              </View>
              {busyBatchId === b.id ? (
                <ActivityIndicator color={colors.brand} style={rowStyles.busy} />
              ) : null}
            </Card>
          );
        })
      )}
    </ScreenScroll>
  );
}

const rowStyles = StyleSheet.create({
  intro: { ...type.caption, fontSize: 14 },

  filterRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  filterButton: {
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 1,
    paddingHorizontal: space.lg,
  },
  filterButtonOn: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  filterButtonText: { color: colors.brand, fontSize: 14, fontWeight: '700' },
  count: { ...type.caption, marginLeft: 'auto' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  clearAll: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  clearAllText: { color: colors.brand, fontWeight: '700', fontSize: 13 },

  cardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.md,
  },
  projectNumber: { fontSize: 17, fontWeight: '800', color: colors.ink, flexShrink: 1 },
  where: { ...type.caption, fontSize: 14 },
  contents: { marginTop: space.xs / 2 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, flexWrap: 'wrap' },
  meta: { ...type.overline, fontSize: 10.5 },
  metaDot: { color: colors.inkFaint, fontSize: 11 },
  /** Outstanding cylinders are the reason this row is in the list, so they are the
   *  one piece of metadata allowed to carry colour. */
  metaOut: { color: colors.warning },
  busy: { alignSelf: 'flex-start' },
});
