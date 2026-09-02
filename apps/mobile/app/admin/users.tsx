import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { PASSWORD_MIN, type AdminUserDto, type Role } from '@gct/shared';
import {
  ApiError,
  apiAdminCreateUser,
  apiAdminUpdateUser,
  apiAdminUsers,
} from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
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
import { SegmentedToggle, StatusBadge } from '../../src/ui/controls';

const ROLES: { value: Role; label: string }[] = [
  { value: 'TECHNICIAN', label: 'Technician' },
  { value: 'STORES_MANAGER', label: 'Stores' },
  { value: 'ADMIN', label: 'Admin' },
];

const ROLE_LABEL: Record<Role, string> = {
  TECHNICIAN: 'Technician',
  STORES_MANAGER: 'Stores manager',
  ADMIN: 'Admin',
};

/**
 * `Alert` is a no-op on react-native-web, so a confirmation written with it would
 * silently do nothing in the browser — the surface this project is actually tested on.
 * `app/queue.tsx` set this precedent; it is the same shape here.
 */
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

export default function AdminUsers() {
  const { user: me } = useAuth();

  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // --- new user form ---
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role | null>('TECHNICIAN');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiAdminUsers();
      setUsers(res.users);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load people.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canCreate =
    name.trim().length > 0 &&
    /.+@.+\..+/.test(email.trim()) &&
    password.length >= PASSWORD_MIN &&
    !!role;

  const create = async () => {
    if (!canCreate || !role) return;
    setCreating(true);
    setActionError(null);
    try {
      await apiAdminCreateUser({
        name: name.trim(),
        email: email.trim(),
        password,
        role,
      });
      setName('');
      setEmail('');
      setPassword('');
      setRole('TECHNICIAN');
      setFormOpen(false);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not add this person.');
    } finally {
      setCreating(false);
    }
  };

  const update = async (
    target: AdminUserDto,
    patch: { role?: Role; active?: boolean },
    confirmMessage?: string,
  ) => {
    if (confirmMessage && !(await confirmAction(confirmMessage))) return;
    setBusyId(target.id);
    setActionError(null);
    try {
      await apiAdminUpdateUser(target.id, patch);
      await load();
    } catch (e) {
      // The server refuses self-demotion and removing the last admin. Those are
      // answers, not failures, so they are shown as-is rather than flattened.
      setActionError(e instanceof ApiError ? e.message : 'Could not update this person.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && users.length === 0) return <LoadingState label="Loading people..." />;
  if (loadError && users.length === 0) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        Accounts that can sign in. Nobody is deleted — deactivating removes their access while
        keeping their name on the batches and scans they recorded.
      </Text>

      {formOpen ? (
        <Card>
          <Text style={{ fontWeight: '700' }}>Add a person</Text>
          <Field label="Full name" value={name} onChangeText={setName} autoCapitalize="words" />
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <Field
            label={`Temporary password (at least ${PASSWORD_MIN} characters)`}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
          />
          <SegmentedToggle label="Role" options={ROLES} value={role} onChange={setRole} />
          <View style={{ gap: 8, marginTop: 6 }}>
            <PrimaryButton
              title="Add person"
              onPress={() => void create()}
              disabled={!canCreate}
              busy={creating}
            />
            <SecondaryButton title="Cancel" onPress={() => setFormOpen(false)} />
          </View>
        </Card>
      ) : (
        <SecondaryButton title="Add a person" onPress={() => setFormOpen(true)} />
      )}

      <ErrorText>{actionError}</ErrorText>

      {users.map((u) => {
        const isMe = u.id === me?.id;
        return (
          <Card key={u.id}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 10,
              }}
            >
              <Text style={{ fontSize: 16, fontWeight: '700', flexShrink: 1 }}>
                {u.name}
                {isMe ? ' (you)' : ''}
              </Text>
              <StatusBadge
                label={u.active ? ROLE_LABEL[u.role] : 'Deactivated'}
                tone={u.active ? (u.role === 'ADMIN' ? 'moved' : 'neutral') : 'done'}
              />
            </View>
            <Text style={{ opacity: 0.75 }}>{u.email}</Text>
            <Text style={styles.label}>
              {u.batchesCreated} batch(es) created · {u.movementsRecorded} movement(s) recorded
            </Text>

            {/* Role is only offered for an active account: changing the role of someone
                who cannot sign in has no observable effect and reads as if it does. */}
            {u.active ? (
              <View style={{ marginTop: 6 }}>
                <SegmentedToggle
                  label="Role"
                  options={ROLES}
                  value={u.role}
                  disabled={busyId === u.id || isMe}
                  onChange={(next) =>
                    void update(
                      u,
                      { role: next },
                      next === u.role
                        ? undefined
                        : `Change ${u.name} from ${ROLE_LABEL[u.role]} to ${ROLE_LABEL[next]}? ` +
                            `They will be signed out on all devices.`,
                    )
                  }
                />
                {isMe ? (
                  <Text style={styles.label}>
                    You cannot change your own role or deactivate yourself.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {!isMe ? (
              <Pressable
                disabled={busyId === u.id}
                onPress={() =>
                  void update(
                    u,
                    { active: !u.active },
                    u.active
                      ? `Deactivate ${u.name}? They will be signed out everywhere and cannot ` +
                          `sign in again. Their history stays on record.`
                      : `Reactivate ${u.name}? They will be able to sign in again.`,
                  )
                }
                style={{ paddingVertical: 10 }}
              >
                <Text
                  style={{
                    color: u.active ? '#c0392b' : '#1f6feb',
                    fontWeight: '600',
                  }}
                >
                  {busyId === u.id ? 'Working…' : u.active ? 'Deactivate' : 'Reactivate'}
                </Text>
              </Pressable>
            ) : null}
          </Card>
        );
      })}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
