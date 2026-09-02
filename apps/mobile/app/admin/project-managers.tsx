import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import type { AdminProjectManagerDto } from '@gct/shared';
import {
  ApiError,
  apiAdminCreateProjectManager,
  apiAdminProjectManagers,
  apiAdminUpdateProjectManager,
} from '../../src/api/client';
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

/** `Alert` is a no-op on react-native-web — see the note in admin/users.tsx. */
const confirmAction = async (message: string): Promise<boolean> => {
  if (Platform.OS === 'web') return globalThis.confirm(message);
  const { Alert } = await import('react-native');
  return new Promise((resolve) => {
    Alert.alert('Are you sure?', message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
};

/**
 * Project managers — the addressees of QR sheets and delivery notes. They never log in.
 *
 * Deactivating one does not orphan the batches addressed to them: those keep naming
 * the manager they were sent to, which is the honest answer to "who was this
 * delivered for?". What changes is that they stop appearing in the pickers, so the
 * next transfer of each open batch has to name a successor — the transfer screen
 * prompts for exactly that.
 */
export default function AdminProjectManagers() {
  const [managers, setManagers] = useState<AdminProjectManagerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);

  /** Which manager's address is being corrected, and to what. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiAdminProjectManagers();
      setManagers(res.projectManagers);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load project managers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const validEmail = (v: string): boolean => /.+@.+\..+/.test(v.trim());
  const canCreate = name.trim().length > 0 && validEmail(email);

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setActionError(null);
    try {
      await apiAdminCreateProjectManager({ name: name.trim(), email: email.trim() });
      setName('');
      setEmail('');
      setFormOpen(false);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not add this project manager.');
    } finally {
      setCreating(false);
    }
  };

  const update = async (
    target: AdminProjectManagerDto,
    patch: { email?: string; active?: boolean },
    confirmMessage?: string,
  ) => {
    if (confirmMessage && !(await confirmAction(confirmMessage))) return;
    setBusyId(target.id);
    setActionError(null);
    try {
      await apiAdminUpdateProjectManager(target.id, patch);
      setEditingId(null);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not update this project manager.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && managers.length === 0) return <LoadingState label="Loading project managers..." />;
  if (loadError && managers.length === 0) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        The people QR sheets and delivery notes are emailed to. They do not sign in, and are never
        deleted — batches keep naming the manager they were addressed to.
      </Text>

      {formOpen ? (
        <Card>
          <Text style={{ fontWeight: '700' }}>Add a project manager</Text>
          <Field label="Full name" value={name} onChangeText={setName} autoCapitalize="words" />
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <View style={{ gap: 8, marginTop: 6 }}>
            <PrimaryButton
              title="Add project manager"
              onPress={() => void create()}
              disabled={!canCreate}
              busy={creating}
            />
            <SecondaryButton title="Cancel" onPress={() => setFormOpen(false)} />
          </View>
        </Card>
      ) : (
        <SecondaryButton title="Add a project manager" onPress={() => setFormOpen(true)} />
      )}

      <ErrorText>{actionError}</ErrorText>

      {managers.map((pm) => (
        <Card key={pm.id}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 10,
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '700', flexShrink: 1 }}>{pm.name}</Text>
            <StatusBadge
              label={pm.active ? 'Active' : 'Deactivated'}
              tone={pm.active ? 'neutral' : 'done'}
            />
          </View>

          {editingId === pm.id ? (
            <View style={{ gap: 8, marginTop: 4 }}>
              <Field
                label="Email"
                value={editEmail}
                onChangeText={setEditEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              <Text style={styles.label}>
                Correcting the address changes where their FUTURE paperwork goes. Batches already
                sent keep the address they actually went to.
              </Text>
              <PrimaryButton
                title="Save email"
                onPress={() => void update(pm, { email: editEmail.trim() })}
                disabled={!validEmail(editEmail) || busyId === pm.id}
                busy={busyId === pm.id}
              />
              <SecondaryButton title="Cancel" onPress={() => setEditingId(null)} />
            </View>
          ) : (
            <>
              <Text style={{ opacity: 0.75 }}>{pm.email}</Text>
              <Text style={styles.label}>
                {pm.projectCount} project(s) · {pm.openBatchCount} batch(es) still open
              </Text>

              <View style={{ flexDirection: 'row', gap: 18, marginTop: 6 }}>
                <Pressable
                  onPress={() => {
                    setEditingId(pm.id);
                    setEditEmail(pm.email);
                  }}
                >
                  <Text style={{ color: '#1f6feb', fontWeight: '600' }}>Correct email</Text>
                </Pressable>

                <Pressable
                  disabled={busyId === pm.id}
                  onPress={() =>
                    void update(
                      pm,
                      { active: !pm.active },
                      pm.active
                        ? `Deactivate ${pm.name}?` +
                            (pm.openBatchCount > 0
                              ? ` ${pm.openBatchCount} open batch(es) are still addressed to them — ` +
                                `the next transfer of each will ask for a new manager.`
                              : '')
                        : `Reactivate ${pm.name}? They will appear in the pickers again.`,
                    )
                  }
                >
                  <Text style={{ color: pm.active ? '#c0392b' : '#1f6feb', fontWeight: '600' }}>
                    {busyId === pm.id ? 'Working…' : pm.active ? 'Deactivate' : 'Reactivate'}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </Card>
      ))}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
