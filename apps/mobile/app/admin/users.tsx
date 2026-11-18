import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { DEFAULT_PASSWORD, PASSWORD_MIN, type AdminUserDto, type StaffRole } from '@gct/shared';
import {
  ApiError,
  apiAdminCreateUser,
  apiAdminDeleteUser,
  apiAdminUpdateUser,
  apiAdminUsers,
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
import { SegmentedToggle, StatusBadge } from '../../src/ui/controls';
import { colors } from '../../src/ui/theme';

/**
 * Project manager is deliberately not offered. A project manager is the admin AND
 * the person paperwork is addressed to, so they are added on the Project managers
 * screen, which creates both halves together; the server refuses the role here too.
 */
const ROLES: { value: StaffRole; label: string }[] = [
  { value: 'TECHNICIAN', label: 'Technician' },
  { value: 'SUBCONTRACTOR', label: 'Subcontractor' },
  { value: 'STORES_MANAGER', label: 'Stores' },
];

const ROLE_LABEL: Record<StaffRole, string> = {
  TECHNICIAN: 'Technician',
  SUBCONTRACTOR: 'Subcontractor',
  STORES_MANAGER: 'Stores manager',
};

/**
 * Staff — the accounts that do the work. Project managers sign in too, but they are
 * managed on their own screen and never listed here, so nobody on this list is ever
 * the person using the console: there is no "(you)" and no self-guard to show.
 */
export default function AdminUsers() {
  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // --- new user form ---
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [role, setRole] = useState<StaffRole | null>('TECHNICIAN');
  const [company, setCompany] = useState('');
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
    !!role &&
    (role !== 'SUBCONTRACTOR' || company.trim().length > 0);

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
        ...(role === 'SUBCONTRACTOR' ? { company: company.trim() } : {}),
      });
      setName('');
      setEmail('');
      setPassword(DEFAULT_PASSWORD);
      setRole('TECHNICIAN');
      setCompany('');
      setFormOpen(false);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not add this person.');
    } finally {
      setCreating(false);
    }
  };

  /**
   * Delete the account outright.
   *
   * Typed confirmation rather than a yes/no: this cannot be undone, and unlike
   * deactivation there is no reactivating afterwards. The message states plainly that
   * the person's work stays on record, because an admin who expects a delete to erase
   * the movement log would otherwise be surprised in the wrong direction.
   */
  const remove = async (target: AdminUserDto) => {
    const ok = await confirmByTyping(
      `Permanently delete ${target.name}?\n\n` +
        `Their account, password and sessions are destroyed and the email address is ` +
        `freed for reuse. Batches they booked in and cylinders they scanned STAY on ` +
        `record under their name — deleting a person does not delete the work.\n\n` +
        `This cannot be undone. Type ${target.name} to confirm.`,
      target.name,
    );
    if (!ok) return;

    setBusyId(target.id);
    setActionError(null);
    try {
      await apiAdminDeleteUser(target.id);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not delete this person.');
    } finally {
      setBusyId(null);
    }
  };

  const update = async (
    target: AdminUserDto,
    patch: { role?: StaffRole; active?: boolean },
    confirmMessage?: string,
  ) => {
    if (confirmMessage && !(await confirmAction(confirmMessage))) return;
    setBusyId(target.id);
    setActionError(null);
    try {
      await apiAdminUpdateUser(target.id, patch);
      await load();
    } catch (e) {
      // A refusal from the server is an answer, not a failure, so it is shown as-is.
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
        Technicians, subcontractors and stores managers. Project managers are on their own screen.
        Deactivating removes someone&apos;s access while keeping their name on the batches and scans
        they recorded.
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
          {role === 'SUBCONTRACTOR' ? (
            <Field
              label="Company"
              value={company}
              onChangeText={setCompany}
              autoCapitalize="words"
            />
          ) : null}
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
              <Text style={{ fontSize: 16, fontWeight: '700', flexShrink: 1 }}>{u.name}</Text>
              <StatusBadge
                label={u.active ? ROLE_LABEL[u.role] : 'Deactivated'}
                tone={u.active ? 'neutral' : 'done'}
              />
            </View>
            <Text style={{ opacity: 0.75 }}>{u.email}</Text>
            {u.company ? <Text style={{ opacity: 0.75 }}>{u.company}</Text> : null}
            <Text style={styles.hint}>
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
                  disabled={busyId === u.id}
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
              </View>
            ) : null}

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
                  color: u.active ? colors.danger : colors.brand,
                  fontWeight: '600',
                }}
              >
                {busyId === u.id ? 'Working…' : u.active ? 'Deactivate' : 'Reactivate'}
              </Text>
            </Pressable>

            <Pressable
              disabled={busyId === u.id}
              onPress={() => void remove(u)}
              style={{ paddingVertical: 10 }}
            >
              <Text style={{ color: colors.danger, fontWeight: '600' }}>Delete permanently</Text>
            </Pressable>
          </Card>
        );
      })}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
