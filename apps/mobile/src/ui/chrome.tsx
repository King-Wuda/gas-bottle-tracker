import type { ComponentProps } from 'react';
import { Stack } from 'expo-router';
import { HeaderLogo } from './GeaLogo';
import { colors } from './theme';

/**
 * The options every `Stack` in the app shares.
 *
 * There are seven stacks — root, new, initialize, transfer, returns, history, admin —
 * and the branding has to be on all of them or it reads as a rendering bug on the
 * ones that missed out. Defining it once is also what keeps a stack added later from
 * silently opting out.
 *
 * A screen that needs its own `headerRight` (only `ScanStep`, for the admin override)
 * must render `<HeaderLogo />` alongside it — `headerRight` is a replacement, not an
 * addition.
 *
 * The type is taken from `Stack` rather than imported from `@react-navigation/…`:
 * expo-router vendors its own fork of the native stack, so there is no top-level
 * `@react-navigation/native-stack` package here to import the options type from.
 */
export const stackScreenOptions: NonNullable<ComponentProps<typeof Stack>['screenOptions']> = {
  headerTitleStyle: { fontWeight: '700', fontSize: 17, color: colors.ink },
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.brand,
  // Flat, with the separation carried by a hairline instead. A drop shadow under the
  // bar competes with the cards below it, and this app is mostly cards.
  headerShadowVisible: false,
  // The screens paint the canvas themselves, but this is what shows through during a
  // push transition — without it the gap between screens flashes white.
  contentStyle: { backgroundColor: colors.canvas },
  headerRight: () => <HeaderLogo />,
};
