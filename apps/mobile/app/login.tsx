import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth, ApiError } from '../src/auth/AuthContext';
import { configWarning } from '../src/config';
import { GeaLogo } from '../src/ui/GeaLogo';
import { Checkbox } from '../src/ui/components';
import { CylinderIcon } from '../src/ui/icons';
import { colors, radius, shadow, space, type } from '../src/ui/theme';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * On by default. This is a field app on a personal work phone: the common case is
   * one person, one device, all day, and making them retype a password at every gate
   * is how a shared login gets written on the back of the phone case.
   */
  const [remember, setRemember] = useState(true);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password, remember);
      // AuthGate redirects to '/' once status flips to signedIn.
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setError('Email or password is incorrect.');
      else if (e instanceof ApiError) setError(e.message);
      else setError('Could not reach the server. Check your connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* This screen has no navigation header (`headerShown: false`), so the mark
          that `ui/chrome` puts top-right everywhere else is placed by hand here —
          and this is the first screen anyone sees, so it is the one that must not
          be missing it. */}
      <View style={styles.brand} pointerEvents="none">
        <GeaLogo width={172} />
      </View>

      <View style={styles.container}>
        <View style={styles.card}>
          <View style={styles.mark}>
            <CylinderIcon color={colors.brand} size={30} />
          </View>
          <Text style={styles.title}>Gas Cylinder Tracker</Text>
          <Text style={styles.subtitle}>Sign in with your work account</Text>

          {/* A misconfigured standalone build cannot reach anything; say so here
              rather than letting every request fail as an unexplained network error. */}
          {configWarning ? <Text style={styles.configWarning}>{configWarning}</Text> : null}

          <View style={styles.fields}>
            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={colors.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              value={email}
              onChangeText={setEmail}
              editable={!busy}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={colors.inkFaint}
              secureTextEntry
              textContentType="password"
              value={password}
              onChangeText={setPassword}
              editable={!busy}
              onSubmitEditing={() => canSubmit && onSubmit()}
            />
          </View>

          <Checkbox
            label="Keep me signed in"
            hint={
              remember
                ? 'This device stays signed in until you sign out.'
                : 'You will be signed out when the app is closed.'
            }
            value={remember}
            onChange={setRemember}
            disabled={busy}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            role="button"
            accessibilityState={{ disabled: !canSubmit, busy }}
            style={({ pressed }) => [
              styles.button,
              canSubmit && shadow.brand,
              pressed && canSubmit && styles.buttonPressed,
              !canSubmit && styles.buttonDisabled,
            ]}
            onPress={onSubmit}
            disabled={!canSubmit}
          >
            {busy ? (
              <ActivityIndicator color={colors.onBrand} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </Pressable>
        </View>

        <Text style={styles.footnote}>
          Cylinder movements are recorded with a scan, a photo and a signature.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.canvas },
  brand: { position: 'absolute', top: space.lg, right: space.xl, zIndex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.lg },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.xxl,
    gap: space.md,
    // Wider than a phone on a desktop browser would stretch the fields to silly
    // lengths; centred so it reads as a panel rather than a full-bleed form.
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
    ...shadow.raised,
  },
  mark: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: space.xs,
  },
  title: { ...type.display, textAlign: 'center' },
  subtitle: { ...type.caption, fontSize: 14, textAlign: 'center', marginBottom: space.sm },

  fields: { gap: space.md },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 2,
    fontSize: 16,
    color: colors.ink,
  },
  error: { color: colors.danger, fontSize: 14, fontWeight: '500' },
  configWarning: {
    backgroundColor: colors.warningTint,
    color: colors.warning,
    borderRadius: radius.sm,
    padding: space.md,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },

  button: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    marginTop: space.xs,
  },
  buttonPressed: { backgroundColor: colors.brandDark },
  buttonDisabled: { backgroundColor: colors.sunken, shadowOpacity: 0, elevation: 0 },
  buttonText: { color: colors.onBrand, fontSize: 16, fontWeight: '700' },

  footnote: { ...type.caption, textAlign: 'center', maxWidth: 420, alignSelf: 'center' },
});
