import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { AdminGasTypeDto, AdminSupplierDto } from '@gct/shared';
import {
  ApiError,
  apiAdminCreateSupplier,
  apiAdminGasTypes,
  apiAdminDeleteSupplier,
  apiAdminSuppliers,
  apiAdminUpdateSupplier,
} from '../../src/api/client';
import { confirmAction } from '../../src/ui/confirm';
import {
  Card,
  Checkbox,
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
 * The companies cylinders are bought from.
 *
 * This screen owns the supplier: adding one, renaming it, changing which gases it
 * offers ("Edit gases" — the same pairing the Gases screen edits from the other side),
 * hiding it from the pickers, and deleting it.
 *
 * Nothing here changes a batch already booked. Every batch line keeps the supplier's
 * name as it was at intake, so renaming, re-pairing or deleting a supplier only
 * changes what the batch form offers from now on. "Stop offering" is the reversible
 * way to do that; "Delete" removes the supplier for good, and its batches stay exactly
 * as they were.
 */
export default function AdminSuppliers() {
  const [suppliers, setSuppliers] = useState<AdminSupplierDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  /**
   * Which gases the new supplier carries.
   *
   * Asked for at creation rather than left to a second trip through the Gases screen:
   * a supplier that carries nothing appears in no picker, so adding one without this
   * produces a row that looks saved and changes nothing about the batch form. The
   * pairing is still editable afterwards, on either screen.
   */
  const [gases, setGases] = useState<AdminGasTypeDto[]>([]);
  const [pickedGasIds, setPickedGasIds] = useState<string[]>([]);

  /** Which supplier's gases are being edited, and the gases ticked. */
  const [gasEditId, setGasEditId] = useState<string | null>(null);
  const [gasEditIds, setGasEditIds] = useState<string[]>([]);

  /** Which supplier is being renamed, and to what. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [sup, gas] = await Promise.all([apiAdminSuppliers(), apiAdminGasTypes()]);
      setSuppliers(sup.suppliers);
      setGases(gas.gasTypes.filter((g) => g.active));
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load suppliers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    setActionError(null);
    try {
      await apiAdminCreateSupplier({ name: name.trim(), gasTypeIds: pickedGasIds });
      setName('');
      setPickedGasIds([]);
      setFormOpen(false);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not add this supplier.');
    } finally {
      setCreating(false);
    }
  };

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

  /**
   * Renaming is safe in a way that is worth being explicit about: `BatchLine` keeps the
   * name it was given at intake, so correcting a spelling here does not rewrite what
   * last year's delivery notes say.
   */
  const rename = async (supplier: AdminSupplierDto) => {
    const next = editName.trim();
    if (next.length === 0 || next === supplier.name) {
      setEditingId(null);
      return;
    }
    await run(
      supplier.id,
      async () => {
        await apiAdminUpdateSupplier(supplier.id, { name: next });
        setEditingId(null);
      },
      'Could not rename this supplier.',
    );
  };

  const toggleActive = async (supplier: AdminSupplierDto) => {
    const ok = await confirmAction(
      supplier.active
        ? `Stop offering ${supplier.name}? They disappear from the batch form. Existing ` +
            `batches keep naming them, and you can turn this back on.`
        : `Offer ${supplier.name} again?`,
    );
    if (!ok) return;
    await run(
      supplier.id,
      () => apiAdminUpdateSupplier(supplier.id, { active: !supplier.active }),
      'Could not update this supplier.',
    );
  };

  const saveGases = async (supplier: AdminSupplierDto) => {
    await run(
      supplier.id,
      async () => {
        await apiAdminUpdateSupplier(supplier.id, { gasTypeIds: gasEditIds });
        setGasEditId(null);
      },
      'Could not change the gases.',
    );
  };

  /** Nothing booked is touched: batch lines keep the supplier's name. */
  const remove = async (supplier: AdminSupplierDto) => {
    const ok = await confirmAction(
      supplier.usageCount === 0
        ? `Delete ${supplier.name}? Nothing has been booked from them.`
        : `Delete ${supplier.name}? They will no longer be offered for new batches. The ` +
            `${supplier.usageCount} batch line${supplier.usageCount === 1 ? '' : 's'} booked ` +
            `from them stay exactly as they are and keep naming them.`,
    );
    if (!ok) return;
    await run(
      supplier.id,
      () => apiAdminDeleteSupplier(supplier.id),
      'Could not delete this supplier.',
    );
  };

  if (loading && suppliers.length === 0) return <LoadingState label="Loading suppliers…" />;
  if (loadError && suppliers.length === 0) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        Who cylinders are bought from, and which gases each one offers. Changes here only affect new
        batches — nothing already booked changes.
      </Text>

      {actionError ? <ErrorText>{actionError}</ErrorText> : null}

      {formOpen ? (
        <Card>
          <Field label="Supplier name" value={name} onChangeText={setName} placeholder="Afrox" />

          <Text style={{ fontWeight: '600', marginTop: 8 }}>Which gases do they supply?</Text>
          {gases.length === 0 ? (
            <Text style={styles.hint}>
              No gases yet — add one on the Gases screen first, or save the supplier and pair them
              later.
            </Text>
          ) : (
            gases.map((g) => (
              <Checkbox
                key={g.id}
                label={`${g.name} (${g.prefix})`}
                value={pickedGasIds.includes(g.id)}
                onChange={(next) =>
                  setPickedGasIds((ids) =>
                    next ? [...ids, g.id] : ids.filter((id) => id !== g.id),
                  )
                }
              />
            ))
          )}
          <Text style={styles.hint}>
            A supplier carrying no gases appears in no picker. You can change this later on either
            screen.
          </Text>

          <PrimaryButton
            title="Add supplier"
            onPress={() => void create()}
            disabled={name.trim().length === 0 || creating}
          />
          <SecondaryButton title="Cancel" onPress={() => setFormOpen(false)} />
        </Card>
      ) : (
        <SecondaryButton title="Add a supplier" onPress={() => setFormOpen(true)} />
      )}

      {suppliers.map((s) => (
        <Card key={s.id}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text style={{ fontSize: 17, fontWeight: '700', flexShrink: 1 }}>{s.name}</Text>
            <StatusBadge
              label={s.active ? 'Offered' : 'Hidden'}
              tone={s.active ? 'neutral' : 'done'}
            />
          </View>

          <Text style={styles.hint}>
            {s.gasTypes.length === 0
              ? 'Carries no gases yet — tap Edit gases to choose some.'
              : `Carries ${s.gasTypes.map((g) => g.name).join(', ')}.`}
          </Text>
          <Text style={styles.hint}>
            {s.usageCount === 0
              ? 'Never used.'
              : `Used on ${s.usageCount} batch line${s.usageCount === 1 ? '' : 's'} — deleting keeps them.`}
          </Text>

          {gasEditId === s.id ? (
            <View style={{ marginTop: 6 }}>
              <Text style={{ fontWeight: '600' }}>Which gases do they supply?</Text>
              {gases.map((g) => (
                <Checkbox
                  key={g.id}
                  label={`${g.name} (${g.prefix})`}
                  value={gasEditIds.includes(g.id)}
                  onChange={(next) =>
                    setGasEditIds((ids) =>
                      next ? [...ids, g.id] : ids.filter((id) => id !== g.id),
                    )
                  }
                />
              ))}
              <Text style={styles.hint}>
                Only what the batch form offers from now on changes. Batches already booked keep
                their supplier.
              </Text>
              <PrimaryButton
                title="Save gases"
                onPress={() => void saveGases(s)}
                disabled={busyId === s.id}
              />
              <SecondaryButton title="Cancel" onPress={() => setGasEditId(null)} />
            </View>
          ) : editingId === s.id ? (
            <View style={{ marginTop: 6 }}>
              <Field label="New name" value={editName} onChangeText={setEditName} />
              <Text style={styles.hint}>
                Batches already booked keep the name they were given, so this does not rewrite any
                delivery note.
              </Text>
              <PrimaryButton
                title="Save"
                onPress={() => void rename(s)}
                disabled={busyId === s.id}
              />
              <SecondaryButton title="Cancel" onPress={() => setEditingId(null)} />
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
              <Pressable
                disabled={busyId === s.id}
                onPress={() => {
                  setEditingId(s.id);
                  setEditName(s.name);
                }}
              >
                <Text style={{ color: colors.brand, fontWeight: '600' }}>Rename</Text>
              </Pressable>
              <Pressable
                disabled={busyId === s.id}
                onPress={() => {
                  setGasEditId(s.id);
                  setGasEditIds(s.gasTypes.map((g) => g.id));
                }}
              >
                <Text style={{ color: colors.brand, fontWeight: '600' }}>Edit gases</Text>
              </Pressable>
              <Pressable disabled={busyId === s.id} onPress={() => void toggleActive(s)}>
                <Text style={{ color: colors.brand, fontWeight: '600' }}>
                  {busyId === s.id ? 'Working…' : s.active ? 'Stop offering' : 'Offer again'}
                </Text>
              </Pressable>
              <Pressable disabled={busyId === s.id} onPress={() => void remove(s)}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>Delete</Text>
              </Pressable>
            </View>
          )}
        </Card>
      ))}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
