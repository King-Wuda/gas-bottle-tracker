import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { describeImpact, impactIsDestructive, type AdminSupplierDto } from '@gct/shared';
import {
  ApiError,
  apiAdminCreateSupplier,
  apiAdminDeleteSupplier,
  apiAdminSupplierImpact,
  apiAdminSuppliers,
  apiAdminUpdateSupplier,
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
 * The companies cylinders are bought from.
 *
 * Which GASES each one carries is set on the Gases screen, not here — see the note
 * there. This screen owns the supplier's own existence: adding one, renaming it,
 * hiding it from the pickers, and deleting it outright.
 *
 * "Stop offering" is almost always the right action and is deliberately the
 * unremarkable one. A depot that stops buying from Afrox still has three years of
 * Afrox cylinders in the yard, and the delivery notes for them have to keep naming who
 * supplied them.
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

  /** Which supplier is being renamed, and to what. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiAdminSuppliers();
      setSuppliers(res.suppliers);
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
      await apiAdminCreateSupplier({ name: name.trim() });
      setName('');
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

  const remove = async (supplier: AdminSupplierDto) => {
    setBusyId(supplier.id);
    setActionError(null);
    let summary: string | null;
    try {
      const { impact } = await apiAdminSupplierImpact(supplier.id);
      summary = impactIsDestructive(impact) ? describeImpact(impact) : null;
    } catch (e) {
      setBusyId(null);
      setActionError(e instanceof ApiError ? e.message : 'Could not check what this would delete.');
      return;
    }
    setBusyId(null);

    const ok = summary
      ? await confirmByTyping(
          `Deleting ${supplier.name} will permanently destroy ${summary}.\n\n` +
            `Every batch sourced from them goes, along with its signed delivery notes. ` +
            `If you only want them out of the batch form, use "Stop offering" ` +
            `instead.\n\nType ${supplier.name} to confirm.`,
          supplier.name,
        )
      : await confirmAction(
          `Delete ${supplier.name}? Nothing has been booked from them, so nothing else is affected.`,
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
        Who cylinders are bought from. Which gases each carries is set on the Gases screen.
      </Text>

      {actionError ? <ErrorText>{actionError}</ErrorText> : null}

      {formOpen ? (
        <Card>
          <Field label="Supplier name" value={name} onChangeText={setName} placeholder="Afrox" />
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
              ? 'Carries no gases yet — add it to one on the Gases screen.'
              : `Carries ${s.gasTypes.map((g) => g.name).join(', ')}.`}
          </Text>
          <Text style={styles.hint}>
            {s.usageCount === 0
              ? 'Never used — safe to delete.'
              : `Used on ${s.usageCount} batch line${s.usageCount === 1 ? '' : 's'}.`}
          </Text>

          {editingId === s.id ? (
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
              <Pressable disabled={busyId === s.id} onPress={() => void toggleActive(s)}>
                <Text style={{ color: colors.brand, fontWeight: '600' }}>
                  {busyId === s.id ? 'Working…' : s.active ? 'Stop offering' : 'Offer again'}
                </Text>
              </Pressable>
              <Pressable disabled={busyId === s.id} onPress={() => void remove(s)}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>Delete permanently</Text>
              </Pressable>
            </View>
          )}
        </Card>
      ))}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
