import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  formatBatchDate,
  INITIAL_DELIVERY_POINT_LABELS,
  isValidProjectNumber,
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
import { ProjectNumberField, SegmentedToggle, Select } from '../../../src/ui/controls';
import { confirmAction } from '../../../src/ui/confirm';
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

/** A gas being added to the batch, held locally until Save. */
interface NewLineDraft {
  key: string;
  gasTypeId: string | null;
  supplierId: string | null;
  quantity: string;
  deliveryPoint: InitialDeliveryPoint;
}

let newLineSeq = 0;
const blankNewLine = (): NewLineDraft => ({
  key: `new-${++newLineSeq}`,
  gasTypeId: null,
  supplierId: null,
  quantity: '',
  deliveryPoint: 'STORES',
});

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
 * Changing an existing line's gas is not offered. It re-issues every serial on the
 * line — invalidating labels already printed and stuck on cylinders — so it belongs to
 * a "reprint and re-tag" procedure rather than a quick correction.
 *
 * ADDING a gas is offered ("Add a gas"): a batch booked as argon that also needed
 * nitrogen gets a new line with its own fresh serials. Those cylinders have never been
 * seen, so the batch goes back to needing initialization — only the new cylinders are
 * scanned in, and their QR labels are on a re-sent QR sheet.
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
  const [newLines, setNewLines] = useState<NewLineDraft[]>([]);
  const [reason, setReason] = useState('');
  /** The project's number, as it is being corrected. */
  const [projectNumber, setProjectNumber] = useState('');
  /** Every batch on the project — what renaming it reaches. Null until loaded. */
  const [projectBatchCount, setProjectBatchCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const { batch: b } = await apiGetBatch(id);
      setBatch(b);
      setManagerId(b.projectManagerId);
      setSiteId(b.siteId);
      setProjectNumber(b.projectNumber);
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
      if (project.status === 'fulfilled') {
        setSites(project.value.project.sites);
        setProjectBatchCount(project.value.project.batchCount);
      }
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

  const setNewLine = (key: string, patch: Partial<NewLineDraft>): void =>
    setNewLines((prev) => prev.map((n) => (n.key === key ? { ...n, ...patch } : n)));

  /** Suppliers are per gas — fetched the first time a gas is picked for a new line. */
  const pickNewGas = (key: string, gasTypeId: string): void => {
    setNewLine(key, { gasTypeId, supplierId: null });
    if (suppliersByGas[gasTypeId]) return;
    apiSuppliers(gasTypeId)
      .then((r) => setSuppliersByGas((prev) => ({ ...prev, [gasTypeId]: r.suppliers })))
      .catch(() => {
        /* the supplier select says there is nothing to choose from */
      });
  };

  if (loading && !batch) return <LoadingState label="Loading batch..." />;
  if (loadError && !batch) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }
  if (!batch) return null;

  const projectNumberChanged = projectNumber !== batch.projectNumber;
  const projectNumberValid = isValidProjectNumber(projectNumber);
  /** The other batches a rename reaches, beyond this one. */
  const otherBatches = Math.max((projectBatchCount ?? 1) - 1, 0);

  /** Only what actually differs from the stored batch — an empty patch is not sent. */
  const buildPatch = (): UpdateBatchRequest | null => {
    const patch: UpdateBatchRequest = {};
    if (projectNumberChanged && projectNumberValid) patch.projectNumber = projectNumber;
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
    for (const n of newLines) {
      const qty = Number.parseInt(n.quantity, 10);
      if (n.gasTypeId && n.supplierId && Number.isInteger(qty) && qty > 0) {
        lines.push({
          gasTypeId: n.gasTypeId,
          supplierId: n.supplierId,
          quantity: qty,
          initialDeliveryPoint: n.deliveryPoint,
        });
      }
    }
    if (lines.length > 0) patch.lines = lines;
    if (reason.trim()) patch.reason = reason.trim();

    const substantive =
      patch.projectManagerId !== undefined ||
      patch.siteId !== undefined ||
      patch.projectNumber !== undefined ||
      (patch.lines?.length ?? 0) > 0;
    return substantive ? patch : null;
  };

  const patch = buildPatch();
  /** A new gas started but not finished — saving now would silently drop it. */
  const newLineIncomplete = newLines.some((n) => {
    const qty = Number.parseInt(n.quantity, 10);
    return !(n.gasTypeId && n.supplierId && Number.isInteger(qty) && qty > 0);
  });
  const addedCylinders = newLines.reduce((sum, n) => {
    const qty = Number.parseInt(n.quantity, 10);
    return sum + (Number.isInteger(qty) && qty > 0 ? qty : 0);
  }, 0);

  const save = async () => {
    if (!patch || !id) return;
    // A rename reaches every batch on the project, so say so before it happens when
    // there are others — this screen is about one batch, and that is easy to forget.
    if (
      patch.projectNumber &&
      otherBatches > 0 &&
      !(await confirmAction(
        `Rename project ${batch.projectNumber} to ${patch.projectNumber}?\n\n` +
          `The number belongs to the project, so it changes on all ` +
          `${otherBatches + 1} batches booked on it — not only this one. Each of them ` +
          `records the correction.`,
      ))
    ) {
      return;
    }
    if (
      addedCylinders > 0 &&
      batch.initializedAt &&
      !(await confirmAction(
        `Add ${addedCylinders} cylinder(s) to ${batch.projectNumber}?\n\n` +
          `New cylinders get new serial numbers and QR labels, so the batch has to be ` +
          `initialized again — only the new cylinders need scanning. Until then nothing in ` +
          `this batch can be transferred or returned.`,
      ))
    ) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await apiAdminUpdateBatch(id, patch);
      setNewLines([]);
      await load();
      setBatch(res.batch);
      setProjectNumber(res.batch.projectNumber);
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
        <Text style={{ fontWeight: '700' }}>Project</Text>
        <ProjectNumberField
          value={projectNumber}
          onChangeText={setProjectNumber}
          showErrorNow={projectNumberChanged && projectNumber.length >= 15}
        />
        <Text style={styles.hint}>
          {projectNumberChanged && projectNumberValid
            ? otherBatches > 0
              ? `This renames the project. It changes on all ${otherBatches + 1} batches booked ` +
                `on ${batch.projectNumber}, not only this one.`
              : 'This renames the project. This is the only batch on it.'
            : 'Correct a mistyped project number here. The number belongs to the project, so it ' +
              'changes on every batch booked on it.'}
          {projectNumberChanged && projectNumberValid
            ? ' QR labels already printed keep the old number.'
            : ''}
        </Text>
      </Card>

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
          options={sites.map((s) => ({ value: s.id, label: s.location, hint: s.clientName }))}
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

      {newLines.map((n) => (
        <Card key={n.key}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text style={{ fontWeight: '700' }}>New gas</Text>
            <Text
              role="button"
              onPress={() => setNewLines((prev) => prev.filter((x) => x.key !== n.key))}
              style={{ color: colors.danger, fontWeight: '600' }}
            >
              Remove
            </Text>
          </View>
          <Select
            label="Gas"
            placeholder="Choose a gas"
            value={n.gasTypeId}
            onChange={(v) => pickNewGas(n.key, v)}
            options={gasTypes.map((g) => ({ value: g.id, label: g.name }))}
          />
          <Select
            label="Supplier"
            placeholder="Choose a supplier"
            value={n.supplierId}
            onChange={(v) => setNewLine(n.key, { supplierId: v })}
            disabled={!n.gasTypeId}
            disabledHint="Choose the gas first."
            options={(n.gasTypeId ? (suppliersByGas[n.gasTypeId] ?? []) : []).map((s) => ({
              value: s.id,
              label: s.name,
            }))}
          />
          <SegmentedToggle
            label="Initial delivery point"
            options={DELIVERY_POINTS}
            value={n.deliveryPoint}
            onChange={(v) => setNewLine(n.key, { deliveryPoint: v })}
          />
          <Field
            label="Quantity"
            keyboardType="number-pad"
            value={n.quantity}
            onChangeText={(t) => setNewLine(n.key, { quantity: t.replace(/[^0-9]/g, '') })}
          />
        </Card>
      ))}

      <SecondaryButton
        title="Add a gas"
        onPress={() => setNewLines((prev) => [...prev, blankNewLine()])}
      />
      {addedCylinders > 0 ? (
        <Text style={styles.hint}>
          The new cylinders get their own serial numbers. After saving, re-send the QR sheet from
          the batch page to print their labels, then initialize the batch again — only the new
          cylinders need scanning.
        </Text>
      ) : null}

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
        title={
          projectNumberChanged && !projectNumberValid
            ? 'Finish the project number'
            : newLineIncomplete
              ? 'Finish the new gas, or remove it'
              : patch
                ? 'Save corrections'
                : 'Nothing changed yet'
        }
        onPress={() => void save()}
        disabled={!patch || newLineIncomplete || (projectNumberChanged && !projectNumberValid)}
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
