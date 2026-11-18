import { useState } from 'react';
import { Text } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { PASSWORD_MIN } from '@gct/shared';
import { ApiError, apiChangePassword } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import {
  Card,
  ErrorText,
  Field,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../src/ui/components';

/**
 * Change your own password — every role, from the dashboard.
 *
 * Every account starts on the shared default (`gea`), so this is the step that makes
 * an account actually yours. It asks for the current password even though you are
 * signed in, and signs out your other devices; this one stays signed in.
 *
 * Same source on web and device: the only platform difference underneath is where the
 * new session is stored (`tokenStore` — localStorage vs secure store), which
 * `apiChangePassword` reaches through the same `setSession` every sign-in uses.
 */
export default function ChangePassword() {
  const router = useRouter();
  const { user } = useAuth();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!user) return <Redirect href="/login" />;

  const tooShort = next.length > 0 && next.length < PASSWORD_MIN;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSave = current.length > 0 && next.length >= PASSWORD_MIN && confirm === next && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await apiChangePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <ScreenScroll>
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '700' }}>Password changed</Text>
          <Text style={{ opacity: 0.75 }}>
            Use your new password next time you sign in. Any other phone or browser that was signed
            in to your account has been signed out.
          </Text>
        </Card>
        {/* Back, not replace('/'): the dashboard is already under this screen, and
            replacing would stack a second copy of it on top. */}
        <PrimaryButton
          title="Back to the dashboard"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        Signed in as {user.email}. Everyone starts with the same password, so set one of your own.
      </Text>

      <Card>
        <Field
          label="Current password"
          value={current}
          onChangeText={setCurrent}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label={`New password (at least ${PASSWORD_MIN} characters)`}
          value={next}
          onChangeText={setNext}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          error={tooShort ? `At least ${PASSWORD_MIN} characters.` : null}
        />
        <Field
          label="New password again"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          error={mismatch ? 'The two new passwords do not match.' : null}
        />
        <Text style={styles.hint}>
          Your other devices will be signed out. This one stays signed in.
        </Text>
      </Card>

      <ErrorText>{error}</ErrorText>

      <PrimaryButton
        title="Change password"
        onPress={() => void save()}
        disabled={!canSave}
        busy={busy}
      />
      <SecondaryButton title="Cancel" onPress={() => router.back()} />
    </ScreenScroll>
  );
}
