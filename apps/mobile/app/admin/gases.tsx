import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  describeImpact,
  impactIsDestructive,
  type AdminGasTypeDto,
  type AdminSupplierDto,
} from '@gct/shared';
import {
  ApiError,
  apiAdminCreateGasType,
  apiAdminDeleteGasType,
  apiAdminGasTypeImpact,
  apiAdminGasTypes,
  apiAdminPairSupplier,
  apiAdminSuppliers,
  apiAdminUnpairSupplier,
  apiAdminUpdateGasType,
} from '../../src/api/client';
import { confirmAction, confirmByTyping } from '../../src/ui/confirm';
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
} from '../../src/ui/components';
import { StatusBadge } from '../../src/ui/controls';
import { colors } from '../../src/ui/theme';

/**
 * The gases the depot stocks, and which suppliers may be picked for each.
 *
 * The pairing lives here rather than on the supplier screen because that is the
 * direction the batch form reads it: pick a gas, then pick from the suppliers who
 * carry it. Managing it the other way round would mean an admin adding "Afrox" to
 * nitrogen has to think in the inverse of the screen they are trying to fix.
 *
 * Two different destructive actions share this screen, and the difference is the whole
 * point of keeping them visually apart:
 *
 *  - **Unpairing a supplier** touches nothing historical. `BatchLine` snapshots the
 *    supplier's name at intake, so it changes what tomorrow's form offers and nothing
 *    about what yesterday's recorded. It is a plain tap.
 *  - **Deleting a gas** takes every batch that ever contained it. That one is red,
 *    states the count first, and asks for the name to be typed.
 */
export default function AdminGases() {
  const [gases, setGases] = useState<AdminGasTypeDto[]>([]);
  const [suppliers, setSuppliers] = useState<AdminSupplierDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [creating, setCreating] = useState(false);

  /** Which gas's supplier list is expanded — only one at a time, so the page stays short. */
  const [openPairing, setOpenPairing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Both together: the pairing UI needs the full supplier list to offer the ones
      // NOT yet attached, and two sequential round trips would show a half-built row.
      const [g, s] = await Promise.all([apiAdminGasTypes(), apiAdminSuppliers()]);
      setGases(g.gasTypes);
      setSuppliers(s.suppliers);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load gases.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const validPrefix = /^[A-Za-z]{1,3}$/.test(prefix.trim());
  const canCreate = name.trim().length > 0 && validPrefix;

  const create = async () => {
    setCreating(true);
    setActionError(null);
    try {
      await apiAdminCreateGasType({ name: name.trim(), prefix: prefix.trim().toUpperCase() });
      setName('');
      setPrefix('');
      setFormOpen(false);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not add this gas.');
    } finally {
      setCreating(false);
    }
  };

  /** One wrapper for every row action, so a failure never leaves a row spinning. */
  const run = async (id: string, action: () => Promise<unknown>, failure: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : failure);
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (gas: AdminGasTypeDto) => {
    const ok = await confirmAction(
      gas.active
        ? `Stop offering ${gas.name}? It disappears from the batch form. Existing ` +
            `batches and cylinders are untouched, and you can turn it back on.`
        : `Offer ${gas.name} again?`,
    );
    if (!ok) return;
    await run(
      gas.id,
      () => apiAdminUpdateGasType(gas.id, { active: !gas.active }),
      'Could not update this gas.',
    );
  };

  /**
   * Delete the gas and everything booked against it.
   *
   * The impact is fetched BEFORE the confirmation rather than guessed from
   * `usageCount`: that column counts batch LINES, and the number that decides whether
   * to go ahead is how many batches and cylinders disappear.
   */
  const remove = async (gas: AdminGasTypeDto) => {
    setBusyId(gas.id);
    setActionError(null);
    let summary: string | null;
    try {
      const { impact } = await apiAdminGasTypeImpact(gas.id);
      summary = impactIsDestructive(impact) ? describeImpact(impact) : null;
    } catch (e) {
      setBusyId(null);
      setActionError(e instanceof ApiError ? e.message : 'Could not check what this would delete.');
      return;
    }
    setBusyId(null);

    const ok = summary
      ? await confirmByTyping(
          `Deleting ${gas.name} will permanently destroy ${summary}.\n\n` +
            `Every batch containing this gas goes, including the other gases on those ` +
            `batches. Signed delivery notes and signatures go with them. This cannot ` +
            `be undone.\n\nType ${gas.name} to confirm.`,
          gas.name,
        )
      : await confirmAction(
          `Delete ${gas.name}? Nothing has been booked against it, so nothing else is affected.`,
        );
    if (!ok) return;

    await run(gas.id, () => apiAdminDeleteGasType(gas.id), 'Could not delete this gas.');
  };

  if (loading && gases.length === 0) return <LoadingState label="Loading gases…" />;
  if (loadError && gases.length === 0) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        The gases the batch form offers, and which suppliers carry each one.
      </Text>

      {actionError ? <ErrorText>{actionError}</ErrorText> : null}

      {formOpen ? (
        <Card>
          <Field label="Gas name" value={name} onChangeText={setName} placeholder="Nitrogen" />
          <Field
            label="Serial prefix"
            value={prefix}
            onChangeText={(v) => setPrefix(v.toUpperCase())}
            placeholder="N"
            autoCapitalize="characters"
          />
          <Text style={styles.hint}>
            1–3 capital letters. It is stamped into every serial this gas issues — N-25-001 — so it
            cannot be changed afterwards.
          </Text>
          <PrimaryButton
            title="Add gas"
            onPress={() => void create()}
            disabled={!canCreate || creating}
          />
          <SecondaryButton title="Cancel" onPress={() => setFormOpen(false)} />
        </Card>
      ) : (
        <SecondaryButton title="Add a gas" onPress={() => setFormOpen(true)} />
      )}

      {gases.map((gas) => {
        const unpaired = suppliers.filter(
          (s) => s.active && !gas.suppliers.some((p) => p.id === s.id),
        );
        return (
          <Card key={gas.id}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 17, fontWeight: '700' }}>
                {gas.name} <Text style={{ opacity: 0.55 }}>({gas.prefix})</Text>
              </Text>
              <StatusBadge
                label={gas.active ? 'Offered' : 'Hidden'}
                tone={gas.active ? 'neutral' : 'done'}
              />
            </View>

            <Text style={styles.hint}>
              {gas.usageCount === 0
                ? 'Never used — safe to delete.'
                : `Used on ${gas.usageCount} batch line${gas.usageCount === 1 ? '' : 's'}.`}
            </Text>

            <Text style={{ marginTop: 6, fontWeight: '600' }}>
              Suppliers ({gas.suppliers.length})
            </Text>
            {gas.suppliers.length === 0 ? (
              <Text style={styles.hint}>
                None yet — this gas cannot be booked in until it has at least one.
              </Text>
            ) : (
              gas.suppliers.map((s) => (
                <View
                  key={s.id}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingVertical: 4,
                  }}
                >
                  <Text style={{ flexShrink: 1 }}>{s.name}</Text>
                  <Pressable
                    disabled={busyId === gas.id}
                    onPress={() =>
                      void run(
                        gas.id,
                        () => apiAdminUnpairSupplier(gas.id, s.id),
                        'Could not remove this supplier.',
                      )
                    }
                    style={{ paddingHorizontal: 8, paddingVertical: 6 }}
                  >
                    {/* Not red: this removes an option from a dropdown, not a record. */}
                    <Text style={{ color: colors.brand, fontWeight: '600' }}>Remove</Text>
                  </Pressable>
                </View>
              ))
            )}

            {openPairing === gas.id ? (
              <View style={{ marginTop: 4 }}>
                {unpaired.length === 0 ? (
                  <Text style={styles.hint}>Every active supplier already carries this gas.</Text>
                ) : (
                  unpaired.map((s) => (
                    <Pressable
                      key={s.id}
                      disabled={busyId === gas.id}
                      onPress={() =>
                        void run(
                          gas.id,
                          async () => {
                            await apiAdminPairSupplier(gas.id, s.id);
                            setOpenPairing(null);
                          },
                          'Could not add this supplier.',
                        )
                      }
                      style={{ paddingVertical: 8 }}
                    >
                      <Text style={{ color: colors.brand, fontWeight: '600' }}>+ {s.name}</Text>
                    </Pressable>
                  ))
                )}
                <SecondaryButton title="Done" onPress={() => setOpenPairing(null)} />
              </View>
            ) : (
              <Pressable onPress={() => setOpenPairing(gas.id)} style={{ paddingVertical: 8 }}>
                <Text style={{ color: colors.brand, fontWeight: '600' }}>Add a supplier</Text>
              </Pressable>
            )}

            <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
              <Pressable disabled={busyId === gas.id} onPress={() => void toggleActive(gas)}>
                <Text style={{ color: colors.brand, fontWeight: '600' }}>
                  {busyId === gas.id ? 'Working…' : gas.active ? 'Stop offering' : 'Offer again'}
                </Text>
              </Pressable>
              <Pressable disabled={busyId === gas.id} onPress={() => void remove(gas)}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>Delete permanently</Text>
              </Pressable>
            </View>
          </Card>
        );
      })}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
