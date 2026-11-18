import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { DEFAULT_PASSWORD, PASSWORD_MIN, type AdminProjectManagerDto } from '@gct/shared';
import {
  ApiError,
  apiAdminCreateProjectManager,
  apiAdminDeleteProjectManager,
  apiAdminProjectManagers,
  apiAdminUpdateProjectManager,
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
import { confirmAction, confirmByTyping } from '../../src/ui/confirm';
import { StatusBadge } from '../../src/ui/controls';
import { colors } from '../../src/ui/theme';

/** Which inline editor is open on which card. */
type Editing = { id: string; field: 'email' | 'password'; value: string } | null;

/**
 * Project managers — the admins. Each one signs in, runs this console, and is who QR
 * sheets and delivery notes are addressed to. There is no other list of admin accounts:
 * adding someone here is how they get the console.
 *
 * Deactivating one does not orphan the batches addressed to them: those keep naming
 * the manager they were sent to, which is the honest answer to "who was this
 * delivered for?". What changes is that they can no longer sign in and stop appearing
 * in the pickers, so the next transfer of each open batch has to name a successor —
 * the transfer screen prompts for exactly that.
 *
 * Your own card offers no deactivate or delete: removing your own access could leave
 * nobody able to sign in here. The server refuses both anyway, and also refuses to
 * remove the last active manager.
 */
export default function AdminProjectManagers() {
  const { user: me } = useAuth();

  const [managers, setManagers] = useState<AdminProjectManagerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [creating, setCreating] = useState(false);

  const [editing, setEditing] = useState<Editing>(null);

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
  const canCreate = name.trim().length > 0 && validEmail(email) && password.length >= PASSWORD_MIN;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setActionError(null);
    try {
      await apiAdminCreateProjectManager({ name: name.trim(), email: email.trim(), password });
      setName('');
      setEmail('');
      setPassword(DEFAULT_PASSWORD);
      setFormOpen(false);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not add this project manager.');
    } finally {
      setCreating(false);
    }
  };

  /**
   * Delete the manager outright — their login and their manager record together.
   *
   * Typed confirmation, because unlike deactivating there is no way back. The message
   * says plainly that their deliveries stay: an admin expecting a delete to erase the
   * paperwork addressed to them would otherwise be surprised in the wrong direction.
   */
  const remove = async (target: AdminProjectManagerDto) => {
    const ok = await confirmByTyping(
      `Permanently delete ${target.name}?\n\n` +
        `Their sign-in is destroyed, they disappear from every picker, and their email ` +
        `address is freed for reuse. Projects and delivery notes addressed to them STAY ` +
        `on record under their name — deleting a manager does not delete the deliveries.\n\n` +
        `This cannot be undone. Type ${target.name} to confirm.`,
      target.name,
    );
    if (!ok) return;

    setBusyId(target.id);
    setActionError(null);
    try {
      await apiAdminDeleteProjectManager(target.id);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not delete this project manager.');
    } finally {
      setBusyId(null);
    }
  };

  const update = async (
    target: AdminProjectManagerDto,
    patch: { email?: string; active?: boolean; password?: string },
    confirmMessage?: string,
  ) => {
    if (confirmMessage && !(await confirmAction(confirmMessage))) return;
    setBusyId(target.id);
    setActionError(null);
    try {
      await apiAdminUpdateProjectManager(target.id, patch);
      setEditing(null);
      await load();
    } catch (e) {
      // The server refuses self-deactivation and removing the last manager. Those are
      // answers, not failures, so they are shown as-is rather than flattened.
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
        The people who run this console. Each one signs in, can add and remove people, and is who QR
        sheets and delivery notes are emailed to.
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
          <Field
            label={`Temporary password (at least ${PASSWORD_MIN} characters)`}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
          />
          <Text style={styles.hint}>
            They sign in with this email and password and get the full admin console.
          </Text>
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

      {managers.map((pm) => {
        const isMe = pm.userId === me?.id;
        const busy = busyId === pm.id;
        const edit = editing?.id === pm.id ? editing : null;
        return (
          <Card key={pm.id}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 10,
              }}
            >
              <Text style={{ fontSize: 16, fontWeight: '700', flexShrink: 1 }}>
                {pm.name}
                {isMe ? ' (you)' : ''}
              </Text>
              <StatusBadge
                label={pm.active ? 'Active' : 'Deactivated'}
                tone={pm.active ? 'neutral' : 'done'}
              />
            </View>

            {edit ? (
              <View style={{ gap: 8, marginTop: 4 }}>
                <Field
                  label={
                    edit.field === 'email'
                      ? 'Email'
                      : `New password (at least ${PASSWORD_MIN} characters)`
                  }
                  value={edit.value}
                  onChangeText={(value) => setEditing({ ...edit, value })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  {...(edit.field === 'email'
                    ? { keyboardType: 'email-address' as const }
                    : { secureTextEntry: true })}
                />
                <Text style={styles.hint}>
                  {edit.field === 'email'
                    ? 'This is the address they sign in with and where their FUTURE paperwork goes. ' +
                      'Batches already sent keep the address they actually went to.'
                    : isMe
                      ? 'You will be signed out on your other devices.'
                      : 'They will be signed out everywhere and must use the new password.'}
                </Text>
                <PrimaryButton
                  title={edit.field === 'email' ? 'Save email' : 'Save password'}
                  onPress={() =>
                    void update(
                      pm,
                      edit.field === 'email'
                        ? { email: edit.value.trim() }
                        : { password: edit.value },
                    )
                  }
                  disabled={
                    busy ||
                    (edit.field === 'email'
                      ? !validEmail(edit.value)
                      : edit.value.length < PASSWORD_MIN)
                  }
                  busy={busy}
                />
                <SecondaryButton title="Cancel" onPress={() => setEditing(null)} />
              </View>
            ) : (
              <>
                <Text style={{ opacity: 0.75 }}>{pm.email}</Text>
                <Text style={styles.hint}>
                  {pm.projectCount} project(s) · {pm.openBatchCount} batch(es) still open
                </Text>
                {!pm.hasPassword ? (
                  <Text style={[styles.hint, { color: colors.danger, fontWeight: '600' }]}>
                    Cannot sign in yet — set a password to give them the console.
                  </Text>
                ) : null}
                {isMe ? (
                  <Text style={styles.hint}>
                    Another project manager can deactivate or delete your account; you cannot.
                  </Text>
                ) : null}

                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    columnGap: 18,
                    rowGap: 8,
                    marginTop: 6,
                  }}
                >
                  <Pressable
                    onPress={() => setEditing({ id: pm.id, field: 'email', value: pm.email })}
                  >
                    <Text style={{ color: colors.brand, fontWeight: '600' }}>Correct email</Text>
                  </Pressable>

                  <Pressable
                    onPress={() =>
                      setEditing({
                        id: pm.id,
                        field: 'password',
                        value: pm.hasPassword ? '' : DEFAULT_PASSWORD,
                      })
                    }
                  >
                    <Text style={{ color: colors.brand, fontWeight: '600' }}>
                      {pm.hasPassword ? 'Reset password' : 'Set password'}
                    </Text>
                  </Pressable>

                  {!isMe ? (
                    <Pressable
                      disabled={busy}
                      onPress={() =>
                        void update(
                          pm,
                          { active: !pm.active },
                          pm.active
                            ? `Deactivate ${pm.name}? They will be signed out everywhere and ` +
                                `lose the console.` +
                                (pm.openBatchCount > 0
                                  ? ` ${pm.openBatchCount} open batch(es) are still addressed to them — ` +
                                    `the next transfer of each will ask for a new manager.`
                                  : '')
                            : `Reactivate ${pm.name}? They can sign in again and will appear in the pickers.`,
                        )
                      }
                    >
                      <Text
                        style={{
                          color: pm.active ? colors.danger : colors.brand,
                          fontWeight: '600',
                        }}
                      >
                        {busy ? 'Working…' : pm.active ? 'Deactivate' : 'Reactivate'}
                      </Text>
                    </Pressable>
                  ) : null}

                  {!isMe ? (
                    <Pressable disabled={busy} onPress={() => void remove(pm)}>
                      <Text style={{ color: colors.danger, fontWeight: '600' }}>
                        Delete permanently
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              </>
            )}
          </Card>
        );
      })}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
