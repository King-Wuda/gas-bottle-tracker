import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import {
  INITIAL_DELIVERY_POINT_LABELS,
  type GasTypeDto,
  type InitialDeliveryPoint,
  type SupplierDto,
} from '@gct/shared';
import { ApiError, apiCreateBatch, apiGasTypes, apiSuppliers } from '../../src/api/client';
import { useNewFlow } from '../../src/new/NewFlowContext';
import {
  Card,
  ErrorText,
  Field,
  LoadingState,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';
import { Select, SegmentedToggle } from '../../src/ui/controls';
import { colors } from '../../src/ui/theme';

const DELIVERY_POINTS: { value: InitialDeliveryPoint; label: string }[] = [
  { value: 'STORES', label: INITIAL_DELIVERY_POINT_LABELS.STORES },
  { value: 'SITE', label: INITIAL_DELIVERY_POINT_LABELS.SITE },
];

export default function LineItems() {
  const router = useRouter();
  const flow = useNewFlow();

  const [gasTypes, setGasTypes] = useState<GasTypeDto[]>([]);
  const [loadingGas, setLoadingGas] = useState(true);
  const [gasError, setGasError] = useState<string | null>(null);

  const [gasTypeId, setGasTypeId] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierDto[]>([]);
  const [loadingSuppliers, setLoadingSuppliers] = useState(false);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [deliveryPoint, setDeliveryPoint] = useState<InitialDeliveryPoint | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    apiGasTypes()
      .then((r) => setGasTypes(r.gasTypes))
      .catch((e) => setGasError(e instanceof ApiError ? e.message : 'Could not load gas types.'))
      .finally(() => setLoadingGas(false));
  }, []);

  // The dependent half of the pair. Which suppliers apply is a server question — the
  // pairing lives in GasSupplier — so changing the gas refetches rather than filtering
  // a list the client already holds.
  useEffect(() => {
    if (!gasTypeId) {
      setSuppliers([]);
      return;
    }
    let live = true;
    setLoadingSuppliers(true);
    apiSuppliers(gasTypeId)
      .then((r) => {
        if (live) setSuppliers(r.suppliers);
      })
      .catch(() => {
        if (live) setSuppliers([]);
      })
      .finally(() => {
        if (live) setLoadingSuppliers(false);
      });
    return () => {
      live = false;
    };
  }, [gasTypeId]);

  const quantity = Number.parseInt(qty, 10);
  const canAdd =
    !!gasTypeId &&
    !!supplierId &&
    Number.isInteger(quantity) &&
    quantity > 0 &&
    quantity <= 500 &&
    !!deliveryPoint;

  const totalCylinders = useMemo(
    () => flow.lines.reduce((n, l) => n + l.quantity, 0),
    [flow.lines],
  );

  if (!flow.projectId || !flow.siteId) return <Redirect href="/new" />;

  /** Changing the gas invalidates the supplier: a supplier of Argon need not stock
   *  Nitrogen, and silently keeping the old pick would submit an invalid pair. */
  const chooseGas = (id: string): void => {
    setGasTypeId(id);
    setSupplierId(null);
  };

  const addLine = () => {
    const gt = gasTypes.find((g) => g.id === gasTypeId);
    const sup = suppliers.find((s) => s.id === supplierId);
    if (!gt || !sup || !deliveryPoint || !canAdd) return;
    flow.addLine({
      gasTypeId: gt.id,
      gasTypeName: gt.name,
      supplierId: sup.id,
      supplierName: sup.name,
      quantity,
      initialDeliveryPoint: deliveryPoint,
    });
    setQty('');
  };

  /**
   * ONE batch, from every line in the draft.
   *
   * This used to loop, POSTing a batch per line and tracking which ones landed — the
   * model where "a batch is one gas" made a two-gas delivery two batches. It is now a
   * single request: the delivery that arrived on one truck, against one project, on
   * one day is one record, and the server writes it whole or not at all. That also
   * removes the partial-failure state entirely — there is no "3 of 5 created" to
   * recover from, because there is one thing to create.
   */
  const submitBatch = async () => {
    if (!flow.projectId || !flow.siteId || !flow.clientRequestId || flow.lines.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await apiCreateBatch({
        projectId: flow.projectId,
        siteId: flow.siteId,
        clientRequestId: flow.clientRequestId,
        lines: flow.lines.map((l) => ({
          gasTypeId: l.gasTypeId,
          supplierId: l.supplierId,
          quantity: l.quantity,
          initialDeliveryPoint: l.initialDeliveryPoint,
        })),
      });
      flow.setResult(res);
      router.replace('/new/confirm');
    } catch (e) {
      // The draft is left exactly as it was, and clientRequestId is not re-minted, so
      // tapping Create again replays rather than duplicates.
      setSubmitError(
        e instanceof ApiError
          ? `${e.message} Nothing was created — tap Create batch to try again.`
          : 'Could not reach the server. Nothing was created — tap Create batch to try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        {flow.projectNumber} · {flow.siteName}
      </Text>

      {loadingGas ? (
        <LoadingState label="Loading gas types..." />
      ) : gasError ? (
        <ErrorText>{gasError}</ErrorText>
      ) : (
        <>
          <Select
            label="Gas type"
            placeholder="Choose a gas"
            options={gasTypes.map((g) => ({ value: g.id, label: g.name }))}
            value={gasTypeId}
            onChange={chooseGas}
          />

          <Select
            label="Supplier"
            placeholder={loadingSuppliers ? 'Loading suppliers...' : 'Choose a supplier'}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
            value={supplierId}
            onChange={setSupplierId}
            disabled={!gasTypeId}
            disabledHint="Choose a gas first — suppliers depend on it."
          />

          <SegmentedToggle
            label="Initial delivery point"
            options={DELIVERY_POINTS}
            value={deliveryPoint}
            onChange={setDeliveryPoint}
          />

          <Field
            label="Quantity"
            keyboardType="number-pad"
            value={qty}
            onChangeText={(t) => setQty(t.replace(/[^0-9]/g, ''))}
          />

          <SecondaryButton title="Add line item" onPress={addLine} disabled={!canAdd} />
        </>
      )}

      {flow.lines.length > 0 ? (
        <View style={{ gap: 8, marginTop: 6 }}>
          <Text style={{ fontWeight: '700' }}>
            This batch: {flow.lines.length} line(s) · {totalCylinders} cylinder(s)
          </Text>
          {flow.lines.map((l) => (
            <Card key={l.key}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: '700' }}>
                  {l.quantity} × {l.gasTypeName}
                </Text>
                <Pressable role="button" onPress={() => flow.removeLine(l.key)}>
                  <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
                </Pressable>
              </View>
              <Text style={{ opacity: 0.7 }}>
                {l.supplierName} · delivered to{' '}
                {INITIAL_DELIVERY_POINT_LABELS[l.initialDeliveryPoint]}
              </Text>
            </Card>
          ))}
        </View>
      ) : null}

      <ErrorText>{submitError}</ErrorText>
      <PrimaryButton
        title={
          flow.lines.length === 0
            ? 'Add a line item first'
            : `Create batch (${totalCylinders} cylinder${totalCylinders === 1 ? '' : 's'})`
        }
        onPress={() => void submitBatch()}
        disabled={flow.lines.length === 0}
        busy={submitting}
      />
      <Text style={[styles.hint, { textAlign: 'center' }]}>
        Adding a line item does not create anything yet. Every line above is created together, as
        one batch, when you tap Create batch.
      </Text>
    </ScreenScroll>
  );
}
