import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  createDriverRequestSchema,
  type CreateDriverRequest,
  type DriverProfileDto,
} from '@gct/shared';
import {
  ApiError,
  apiAdminCreateDriver,
  apiAdminDeleteDriver,
  apiAdminDriverImpact,
  apiAdminDrivers,
  apiAdminUpdateDriver,
} from '../../src/api/client';
import { confirmAction } from '../../src/ui/confirm';
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
 * Driver profiles — the regular collection drivers.
 *
 * Whoever does a transfer or a return picks a driver from this list at sign-off
 * instead of typing their name, email and phone every time. A driver who is not on it
 * can still be entered by hand there ("Driver not registered").
 *
 * Every transfer and return keeps its own copy of the driver's details, so editing a
 * profile here never changes a past delivery, and deleting one only removes the link.
 * "Remove from the list" (deactivate) is the usual action; delete is for a mistake.
 */
const BLANK: CreateDriverRequest = { name: '', surname: '', email: '', phone: '' };

function DriverForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: CreateDriverRequest;
  submitLabel: string;
  busy: boolean;
  onSubmit: (v: CreateDriverRequest) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const set = (k: keyof CreateDriverRequest) => (text: string) =>
    setV((o) => ({ ...o, [k]: text }));
  const parsed = createDriverRequestSchema.safeParse(v);
  const issue = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Check the details');

  return (
    <View>
      <Field label="Name" value={v.name} onChangeText={set('name')} autoCapitalize="words" />
      <Field
        label="Surname"
        value={v.surname}
        onChangeText={set('surname')}
        autoCapitalize="words"
      />
      <Field
        label="Email address"
        value={v.email}
        onChangeText={set('email')}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="e.g. bongani@example.com"
      />
      <Field
        label="Phone number"
        value={v.phone}
        onChangeText={set('phone')}
        keyboardType="phone-pad"
        placeholder="e.g. 082 555 0199"
      />
      <PrimaryButton
        title={busy ? 'Saving…' : (issue ?? submitLabel)}
        onPress={() => parsed.success && onSubmit(parsed.data)}
        disabled={!parsed.success || busy}
        busy={busy}
      />
      <SecondaryButton title="Cancel" onPress={onCancel} />
    </View>
  );
}

export default function AdminDrivers() {
  const [drivers, setDrivers] = useState<DriverProfileDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setDrivers((await apiAdminDrivers()).drivers);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load drivers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, action: () => Promise<unknown>, failure: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      await load();
      return true;
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : failure);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (d: DriverProfileDto) => {
    const ok = await confirmAction(
      d.active
        ? `Remove ${d.fullName} from the driver list? They will no longer be offered at ` +
            `sign-off. Past transfers and returns keep their details, and you can add them back.`
        : `Put ${d.fullName} back on the driver list?`,
    );
    if (!ok) return;
    await run(
      d.id,
      () => apiAdminUpdateDriver(d.id, { active: !d.active }),
      'Could not update this driver.',
    );
  };

  const remove = async (d: DriverProfileDto) => {
    setBusyId(d.id);
    setActionError(null);
    let used: number;
    try {
      const impact = await apiAdminDriverImpact(d.id);
      used = impact.transfers + impact.returns;
    } catch (e) {
      setBusyId(null);
      setActionError(e instanceof ApiError ? e.message : 'Could not check this driver.');
      return;
    }
    setBusyId(null);
    const ok = await confirmAction(
      used === 0
        ? `Delete ${d.fullName}? They have not signed for anything, so nothing else changes.`
        : `Delete ${d.fullName}? They signed for ${used} transfer(s) and return(s). Those ` +
            `keep the name, email and phone they were signed under — only the profile goes.`,
    );
    if (!ok) return;
    await run(d.id, () => apiAdminDeleteDriver(d.id), 'Could not delete this driver.');
  };

  if (loading && drivers.length === 0) return <LoadingState label="Loading drivers…" />;
  if (loadError && drivers.length === 0) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        The regular collection drivers. At sign-off, a transfer or return picks the driver from this
        list instead of typing their details.
      </Text>

      {actionError ? <ErrorText>{actionError}</ErrorText> : null}

      {adding ? (
        <Card>
          <DriverForm
            initial={BLANK}
            submitLabel="Add driver"
            busy={busyId === 'new'}
            onCancel={() => setAdding(false)}
            onSubmit={(v) =>
              void run('new', () => apiAdminCreateDriver(v), 'Could not add this driver.').then(
                (ok) => ok && setAdding(false),
              )
            }
          />
        </Card>
      ) : (
        <SecondaryButton title="Add a driver" onPress={() => setAdding(true)} />
      )}

      {drivers.length === 0 ? <Text style={styles.hint}>No drivers yet.</Text> : null}

      {drivers.map((d) => (
        <Card key={d.id}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text style={{ fontSize: 17, fontWeight: '700', flexShrink: 1 }}>{d.fullName}</Text>
            <StatusBadge
              label={d.active ? 'On the list' : 'Removed'}
              tone={d.active ? 'neutral' : 'done'}
            />
          </View>
          <Text style={styles.hint}>
            {d.phone} · {d.email}
          </Text>
          <Text style={styles.hint}>
            {d.transfers + d.returns === 0
              ? 'Has not signed for anything yet.'
              : `Signed for ${d.transfers} transfer(s) and ${d.returns} return(s).`}
          </Text>

          {editingId === d.id ? (
            <DriverForm
              initial={{ name: d.name, surname: d.surname, email: d.email, phone: d.phone }}
              submitLabel="Save"
              busy={busyId === d.id}
              onCancel={() => setEditingId(null)}
              onSubmit={(v) =>
                void run(d.id, () => apiAdminUpdateDriver(d.id, v), 'Could not save.').then(
                  (ok) => ok && setEditingId(null),
                )
              }
            />
          ) : (
            <View style={{ flexDirection: 'row', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
              <Pressable disabled={busyId === d.id} onPress={() => setEditingId(d.id)}>
                <Text style={{ color: colors.brand, fontWeight: '600' }}>Edit</Text>
              </Pressable>
              <Pressable disabled={busyId === d.id} onPress={() => void toggleActive(d)}>
                <Text style={{ color: colors.brand, fontWeight: '600' }}>
                  {busyId === d.id ? 'Working…' : d.active ? 'Remove from list' : 'Add back'}
                </Text>
              </Pressable>
              <Pressable disabled={busyId === d.id} onPress={() => void remove(d)}>
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
