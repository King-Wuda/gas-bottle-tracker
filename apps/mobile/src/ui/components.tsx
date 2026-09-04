import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { colors, radius, shadow, space, type } from './theme';

/**
 * The shared UI kit. Every screen is built from these, which is what makes the app
 * look like one thing rather than twenty.
 *
 * Two rules hold it together:
 *
 * 1. **Nothing here invents a colour or a gap.** Everything comes from `theme.ts`, so
 *    changing the brand is one file and not a search across forty.
 * 2. **State is visible.** Disabled, busy and pressed all look different from resting.
 *    A button that gives no feedback gets pressed twice, and on this app the second
 *    press is a second submission.
 */

export function ScreenScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={styles.screenBg} contentContainerStyle={styles.screen}>
      {children}
    </ScrollView>
  );
}

/** A screen's opening line: what this is, and one line on what to do. */
export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.pageHeader}>
      <Text style={type.display}>{title}</Text>
      {subtitle ? <Text style={styles.pageSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

/** A labelled group inside a screen. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={type.overline}>{children}</Text>;
}

export function Field({
  label,
  hint,
  error,
  ...inputProps
}: { label: string; hint?: string; error?: string | null } & TextInputProps) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, error ? styles.inputInvalid : null]}
        placeholderTextColor={colors.inkFaint}
        {...inputProps}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {hint && !error ? <Text style={styles.hint}>{hint}</Text> : null}
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
  const inert = disabled || busy;
  return (
    <Pressable
      role="button"
      accessibilityState={{ disabled: !!inert, busy: !!busy }}
      style={({ pressed }) => [
        styles.button,
        !inert && shadow.brand,
        pressed && !inert && styles.buttonPressed,
        inert && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={inert}
    >
      {busy ? (
        <ActivityIndicator color={colors.onBrand} />
      ) : (
        <Text style={styles.buttonText}>{title}</Text>
      )}
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
      role="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.secondary,
        pressed && !disabled && styles.secondaryPressed,
        disabled && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.secondaryText}>{title}</Text>
    </Pressable>
  );
}

/**
 * The amber affordance: an admin doing something in place of evidence.
 *
 * Visually its own thing, and deliberately never the primary button on a screen. What
 * it records is "an admin waived this", not "this was proved" — see ScanStep and
 * PhotoCapture — and an override that looked like the normal path would quietly
 * devalue every real scan and photo in the system.
 */
export function OverrideButton({
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
      role="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.override,
        pressed && !disabled && styles.overridePressed,
        disabled && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.overrideText}>{title}</Text>
    </Pressable>
  );
}

export function Card({
  children,
  onPress,
  style,
  padded = true,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle | ViewStyle[];
  /** Off for cards that hold an edge-to-edge image or viewfinder. */
  padded?: boolean;
}) {
  const base = [styles.card, padded && styles.cardPadded, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable
      role="button"
      onPress={onPress}
      style={({ pressed }) => [...base, pressed && styles.cardPressed]}
    >
      {children}
    </Pressable>
  );
}

export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const TONE_SURFACE: Record<Tone, ViewStyle> = {
  neutral: { backgroundColor: colors.sunken },
  brand: { backgroundColor: colors.brandTint },
  success: { backgroundColor: colors.successTint },
  warning: { backgroundColor: colors.warningTint },
  danger: { backgroundColor: colors.dangerTint },
};

const TONE_INK: Record<Tone, string> = {
  neutral: colors.inkMuted,
  brand: colors.brand,
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
};

/** A small status word: "At stores", "4 still out", "Admin override". */
export function Pill({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return (
    <View style={[styles.pill, TONE_SURFACE[tone]]}>
      <Text style={[styles.pillText, { color: TONE_INK[tone] }]}>{label}</Text>
    </View>
  );
}

/**
 * A whole-width message with a coloured spine.
 *
 * Used for the things this app has to say out loud before someone commits: cylinders
 * going out without a scan, a photo an admin waived, work sitting in the outbox. The
 * spine rather than a filled block, so a screen carrying two of them is still legible.
 */
export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <View style={[styles.notice, TONE_SURFACE[tone], { borderLeftColor: TONE_INK[tone] }]}>
      {title ? <Text style={[styles.noticeTitle, { color: TONE_INK[tone] }]}>{title}</Text> : null}
      {typeof children === 'string' ? <Text style={styles.noticeBody}>{children}</Text> : children}
    </View>
  );
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
      <ActivityIndicator color={colors.brand} />
      <Text style={styles.stateHint}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  title,
  hint,
  actionLabel,
  onAction,
  icon,
}: {
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
}) {
  return (
    <View style={styles.state}>
      {icon ? <View style={styles.stateIcon}>{icon}</View> : null}
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
  screenBg: { backgroundColor: colors.canvas },
  screen: { padding: space.xl, paddingBottom: space.xxxl, gap: space.lg },

  pageHeader: { gap: space.xs, marginBottom: space.xs },
  pageSubtitle: { ...type.caption, fontSize: 14 },

  fieldWrap: { gap: space.xs + 2 },
  label: type.overline,
  hint: type.caption,
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 1,
    fontSize: 16,
    color: colors.ink,
  },
  inputInvalid: { borderColor: colors.danger, backgroundColor: colors.dangerTint },

  button: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  buttonPressed: { backgroundColor: colors.brandDark },
  buttonDisabled: {
    backgroundColor: colors.sunken,
    // The shadow has to go too: a flat disabled button that still floats reads as
    // pressable, which is the whole thing being communicated against.
    shadowOpacity: 0,
    elevation: 0,
    borderColor: colors.border,
  },
  buttonText: { color: colors.onBrand, fontSize: 16, fontWeight: '700', letterSpacing: 0.1 },

  secondary: {
    borderWidth: 1.5,
    borderColor: colors.brand,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  secondaryPressed: { backgroundColor: colors.brandTint },
  secondaryText: { color: colors.brand, fontSize: 15, fontWeight: '700' },

  override: {
    borderWidth: 1.5,
    borderColor: colors.warning,
    backgroundColor: colors.warningTint,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  overridePressed: { backgroundColor: '#F7E4C4' },
  overrideText: { color: colors.warning, fontSize: 15, fontWeight: '700' },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  cardPadded: { padding: space.lg, gap: space.sm },
  cardPressed: { backgroundColor: colors.brandTint, borderColor: colors.brandTintStrong },

  pill: {
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },

  notice: {
    borderRadius: radius.md,
    borderLeftWidth: 4,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: space.xs,
  },
  noticeTitle: { fontSize: 14, fontWeight: '700' },
  noticeBody: { ...type.caption, color: colors.ink },

  error: { color: colors.danger, fontSize: 14, fontWeight: '500' },

  state: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xxxl,
    paddingHorizontal: space.sm,
  },
  stateIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.sunken,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  stateTitle: { ...type.heading, textAlign: 'center' },
  stateHint: { ...type.caption, textAlign: 'center', maxWidth: 320 },
  stateAction: { alignSelf: 'stretch', paddingTop: space.sm },
});
