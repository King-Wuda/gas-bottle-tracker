import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';

export function ScreenScroll({ children }: { children: ReactNode }) {
  return <ScrollView contentContainerStyle={styles.screen}>{children}</ScrollView>;
}

export function Field({ label, ...inputProps }: { label: string } & TextInputProps) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor="#9aa0a6" {...inputProps} />
    </View>
  );
}

export function PrimaryButton({
  title,
  onPress,
  disabled,
  busy,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      style={[styles.button, (disabled || busy) && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled || busy}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{title}</Text>}
    </Pressable>
  );
}

export function SecondaryButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.secondary, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.secondaryText}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  if (onPress) {
    return (
      <Pressable style={styles.card} onPress={onPress}>
        {children}
      </Pressable>
    );
  }
  return <View style={styles.card}>{children}</View>;
}

/**
 * M5 empty / loading / failure states.
 *
 * Field screens previously rendered nothing at all while loading and nothing at all
 * when a list came back empty, which is indistinguishable from a hung app on a slow
 * link. Each of these says which of the three it is, and a failure always offers the
 * way out.
 */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.state}>
      <ActivityIndicator />
      <Text style={styles.stateHint}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  title,
  hint,
  actionLabel,
  onAction,
}: {
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.state}>
      <Text style={styles.stateTitle}>{title}</Text>
      {hint ? <Text style={styles.stateHint}>{hint}</Text> : null}
      {actionLabel && onAction ? (
        <View style={styles.stateAction}>
          <SecondaryButton title={actionLabel} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}

/** A failed load. Distinct from `EmptyState`: there IS data, we just could not get it. */
export function ErrorState({
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <View style={styles.state}>
      <Text style={styles.stateTitle}>Something went wrong</Text>
      <Text style={styles.error}>{message}</Text>
      {onRetry ? (
        <View style={styles.stateAction}>
          <SecondaryButton title={retryLabel} onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Text style={styles.error}>{children}</Text>;
}

export const styles = StyleSheet.create({
  screen: { padding: 20, gap: 14 },
  fieldWrap: { gap: 6 },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.4)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#1f6feb',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondary: {
    borderWidth: 1,
    borderColor: '#1f6feb',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  secondaryText: { color: '#1f6feb', fontSize: 16, fontWeight: '600' },
  card: { backgroundColor: 'rgba(127,127,127,0.12)', borderRadius: 12, padding: 16, gap: 6 },
  error: { color: '#c0392b', fontSize: 14 },
  state: { alignItems: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 8 },
  stateTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  stateHint: { fontSize: 14, opacity: 0.65, textAlign: 'center' },
  stateAction: { alignSelf: 'stretch', paddingTop: 8 },
});
