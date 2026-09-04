import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  formatBatchDate,
  INITIAL_DELIVERY_POINT_LABELS,
  summariseDistribution,
  type BatchAmendmentDto,
  type BatchDto,
  type GasTypeDto,
  type InitialDeliveryPoint,
  type ProjectManagerDto,
  type SiteDto,
  type SupplierDto,
  type UpdateBatchRequest,
} from '@gct/shared';
import {
  ApiError,
  apiAdminBatchAmendments,
  apiAdminUpdateBatch,
  apiGasTypes,
  apiGetBatch,
  apiGetProject,
  apiProjectManagers,
  apiSuppliers,
} from '../../../src/api/client';
import {
  Card,
  ErrorState,
  ErrorText,
  Field,
  LoadingState,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../../src/ui/components';
import { SegmentedToggle, Select } from '../../../src/ui/controls';
import { colors } from '../../../src/ui/theme';

const DELIVERY_POINTS: { value: InitialDeliveryPoint; label: string }[] = [
  { value: 'STORES', label: INITIAL_DELIVERY_POINT_LABELS.STORES },
  { value: 'SITE', label: INITIAL_DELIVERY_POINT_LABELS.SITE },
];

/** Per-line edits held locally until Save. Empty string = "leave alone". */
interface LineDraft {
  supplierId: string | null;
  quantity: string;
  deliveryPoint: InitialDeliveryPoint | null;
}

/**
 * Correcting a batch that was entered wrong.
 *
 * The screen is deliberately honest about what it cannot do. Supplier, delivery point
 * and the addressee are paperwork and always editable. Quantity is editable up, and
 * down only as far as cylinders that have never moved — the server enforces this and
 * says so when it refuses, and that refusal is shown verbatim rather than being
 * softened into "could not save". A cylinder that has been scanned onto a site is a
 * rental someone is being charged for, not a typo, and quietly deleting it here would
 * make this screen a way to erase the very evidence the system exists to keep.
 *
 * Gas type is not offered. It re-issues every serial on the line — invalidating labels
 * already printed and stuck on cylinders — so it belongs to a "reprint and re-tag"
 * procedure rather than a quick correction. Remove the line and add a new one, which
 * makes the reprint obvious.
 */
export default function AdminBatchEdit() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [batch, setBatch] = useState<BatchDto | null>(null);
  const [amendments, setAmendments] = useState<BatchAmendmentDto[]>([]);
  const [managers, setManagers] = useState<ProjectManagerDto[]>([]);
  const [sites, setSites] = useState<SiteDto[]>([]);
  const [gasTypes, setGasTypes] = useState<GasTypeDto[]>([]);
  const [suppliersByGas, setSuppliersByGas] = useState<Record<string, SupplierDto[]>>({});

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // --- draft state ---
  const [managerId, setManagerId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const { batch: b } = await apiGetBatch(id);
      setBatch(b);
      setManagerId(b.projectManagerId);
      setSiteId(b.siteId);
      setLineDrafts(
        Object.fromEntries(
          b.lines.map((l) => [
            l.id,
            {
              supplierId: l.supplierId,
              quantity: String(l.quantity),
              deliveryPoint: l.initialDeliveryPoint as InitialDeliveryPoint,
            },
          ]),
        ),
      );

      // Everything else is context for the pickers. A failure in any of them degrades
      // one control rather than the screen, so they are settled independently.
      const [pm, project, gas, amend] = await Promise.allSettled([
        apiProjectManagers(),
        apiGetProject(b.projectId),
        apiGasTypes(),
        apiAdminBatchAmendments(id),
      ]);
      if (pm.status === 'fulfilled') setManagers(pm.value.projectManagers);
      if (project.status === 'fulfilled') setSites(project.value.project.sites);
      if (gas.status === 'fulfilled') setGasTypes(gas.value.gasTypes);
      if (amend.status === 'fulfilled') setAmendments(amend.value.amendments);

      // Suppliers are per-gas, so one request per distinct gas on the batch.
      const distinct = [...new Set(b.lines.map((l) => l.gasTypeId))];
      const results = await Promise.allSettled(distinct.map((g) => apiSuppliers(g)));
      const map: Record<string, SupplierDto[]> = {};
      distinct.forEach((g, i) => {
        const r = results[i];
        if (r?.status === 'fulfilled') map[g] = r.value.suppliers;
      });
      setSuppliersByGas(map);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load this batch.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const setDraft = (lineId: string, patch: Partial<LineDraft>): void =>
    setLineDrafts((prev) => ({ ...prev, [lineId]: { ...prev[lineId]!, ...patch } }));

  if (loading && !batch) return <LoadingState label="Loading batch..." />;
  if (loadError && !batch) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }
  if (!batch) return null;

  /** Only what actually differs from the stored batch — an empty patch is not sent. */
  const buildPatch = (): UpdateBatchRequest | null => {
    const patch: UpdateBatchRequest = {};
    if (managerId && managerId !== batch.projectManagerId) patch.projectManagerId = managerId;
    if (siteId && siteId !== batch.siteId) patch.siteId = siteId;

    const lines = batch.lines.flatMap((l) => {
      const d = lineDrafts[l.id];
      if (!d) return [];
      const edit: NonNullable<UpdateBatchRequest['lines']>[number] = { id: l.id };
      let changed = false;
      if (d.supplierId && d.supplierId !== l.supplierId) {
        edit.supplierId = d.supplierId;
        changed = true;
      }
      const qty = Number.parseInt(d.quantity, 10);
      if (Number.isInteger(qty) && qty > 0 && qty !== l.quantity) {
        edit.quantity = qty;
        changed = true;
      }
      if (d.deliveryPoint && d.deliveryPoint !== l.initialDeliveryPoint) {
        edit.initialDeliveryPoint = d.deliveryPoint;
        changed = true;
      }
      return changed ? [edit] : [];
    });
    if (lines.length > 0) patch.lines = lines;
    if (reason.trim()) patch.reason = reason.trim();

    const substantive =
      patch.projectManagerId !== undefined ||
      patch.siteId !== undefined ||
      (patch.lines?.length ?? 0) > 0;
    return substantive ? patch : null;
  };

  const patch = buildPatch();

  const save = async () => {
    if (!patch || !id) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await apiAdminUpdateBatch(id, patch);
      setBatch(res.batch);
      setReason('');
      setSaved(true);
      const fresh = await apiAdminBatchAmendments(id).catch(() => null);
      if (fresh) setAmendments(fresh.amendments);
    } catch (e) {
      // The server's refusal explains which cylinders have already moved. Shown as
      // written — it is the most useful sentence on the screen.
      setSaveError(e instanceof ApiError ? e.message : 'Could not save these corrections.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 18, fontWeight: '700' }}>{batch.projectNumber}</Text>
      <Text style={{ opacity: 0.7 }}>
        Created {formatBatchDate(batch.createdAt)} · {batch.quantity} cylinder(s)
      </Text>
      <Text style={styles.hint}>
        Every change here is recorded with your name. Cylinders that have already been transferred
        or returned cannot be edited away.
      </Text>

      <Card>
        <Text style={{ fontWeight: '700' }}>Where the paperwork goes</Text>
        <Select
          label="Project manager"
          placeholder="Choose a project manager"
          value={managerId}
          onChange={setManagerId}
          options={managers.map((m) => ({ value: m.id, label: m.name, hint: m.email }))}
        />
        <Select
          label="Site"
          placeholder="Choose a site"
          value={siteId}
          onChange={setSiteId}
          options={sites.map((s) => ({ value: s.id, label: s.name, hint: s.location }))}
        />
      </Card>

      {batch.lines.map((l) => {
        const d = lineDrafts[l.id];
        const here = batch.distribution.filter((x) => x.gasTypeId === l.gasTypeId);
        const moved = here.some((x) => x.kind !== 'STORES');
        const gasName = gasTypes.find((g) => g.id === l.gasTypeId)?.name ?? l.gasTypeName;
        return (
          <Card key={l.id}>
            <Text style={{ fontWeight: '700' }}>
              {l.quantity} × {gasName}
            </Text>
            <Text style={styles.hint}>{summariseDistribution(here) || 'No cylinders'}</Text>

            <Select
              label="Supplier"
              placeholder="Choose a supplier"
              value={d?.supplierId ?? null}
              onChange={(v) => setDraft(l.id, { supplierId: v })}
              options={(suppliersByGas[l.gasTypeId] ?? []).map((s) => ({
                value: s.id,
                label: s.name,
              }))}
            />
            <SegmentedToggle
              label="Initial delivery point"
              options={DELIVERY_POINTS}
              value={d?.deliveryPoint ?? null}
              onChange={(v) => setDraft(l.id, { deliveryPoint: v })}
            />
            <Field
              label="Quantity"
              keyboardType="number-pad"
              value={d?.quantity ?? ''}
              onChangeText={(t) => setDraft(l.id, { quantity: t.replace(/[^0-9]/g, '') })}
            />
            {moved ? (
              <Text style={styles.hint}>
                Some of these cylinders have already moved. The quantity can still go up, but it can
                only go down as far as the ones that never left stores.
              </Text>
            ) : null}
          </Card>
        );
      })}

      <Field
        label="Why (optional — recorded with the change)"
        value={reason}
        onChangeText={setReason}
        placeholder="e.g. supplier keyed in wrong on delivery"
      />

      <ErrorText>{saveError}</ErrorText>
      {saved && !saveError ? (
        <Text style={{ color: colors.success, fontWeight: '600' }}>Corrections saved.</Text>
      ) : null}

      <PrimaryButton
        title={patch ? 'Save corrections' : 'Nothing changed yet'}
        onPress={() => void save()}
        disabled={!patch}
        busy={saving}
      />

      {batch.lines.some(
        (l) => lineDrafts[l.id]?.supplierId && lineDrafts[l.id]?.supplierId !== l.supplierId,
      ) ? (
        <Text style={styles.hint}>
          Changing the supplier does not reprint the QR labels — they carry the supplier name.
          Re-send the QR sheet from the batch page afterwards.
        </Text>
      ) : null}

      {amendments.length > 0 ? (
        <Card>
          <Text style={{ fontWeight: '700' }}>Correction history</Text>
          <View style={{ gap: 10, marginTop: 6 }}>
            {amendments.map((a) => (
              <View key={a.id}>
                <Text style={styles.hint}>
                  {formatBatchDate(a.createdAt)} · {a.userName}
                </Text>
                {a.changes.map((c, i) => (
                  <Text key={i}>{c}</Text>
                ))}
                {a.reason ? <Text style={{ opacity: 0.7 }}>“{a.reason}”</Text> : null}
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      <SecondaryButton
        title="Back to batch"
        onPress={() =>
          router.replace({ pathname: '/history/batch/[id]', params: { id: batch.id } })
        }
      />
    </ScreenScroll>
  );
}
