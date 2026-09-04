import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

/**
 * The design tokens every screen draws from.
 *
 * ## Why a light theme only
 *
 * `app.json` pins `userInterfaceStyle` to light. This is a yard app: it is read at
 * arm's length, outdoors, in South African sun, by someone holding a cylinder in the
 * other hand. Dark surfaces lose that contest, and a half-themed dark mode — where one
 * screen inverted and the next did not — reads as a broken app rather than a missing
 * feature. One theme, done properly, is worth more here than two done partly.
 *
 * ## Colour carries meaning, and only one meaning
 *
 * The palette below is small on purpose, because this app already assigns jobs to
 * colour and those jobs must not blur:
 *
 * - **Blue** is GEA, and it is *action* — the thing to press.
 * - **Green** is a cylinder that was physically scanned. Nothing else is green.
 * - **Amber** is an admin's assertion in place of evidence: an override, a waived
 *   photo, a batch marked without a scan. It is deliberately not red, because it is
 *   permitted; and deliberately not green, because it is not proof.
 * - **Red** is something that failed or needs attention.
 *
 * Every new surface should reach for a neutral first. A screen where four things are
 * coloured says nothing about which of them matters.
 */

/** Taken from the wordmark itself — see ui/geaLogo.ts. The UI's blue and the logo's
 *  blue being different shades is the kind of thing nobody can name and everybody
 *  notices. */
const brand = '#1414C8';

export const colors = {
  /** GEA blue. Primary actions, links, the selected state. */
  brand,
  brandDark: '#0E0E9C',
  brandLight: '#4B4BDA',
  /** Backgrounds for brand-coloured surfaces that still carry text. */
  brandTint: '#ECECFC',
  brandTintStrong: '#D7D7F7',

  /** Text. `ink` is for content, `inkMuted` for supporting copy, `inkFaint` for
   *  placeholders and metadata that should recede until looked for. */
  ink: '#0C1729',
  inkMuted: '#4C5B71',
  inkFaint: '#8090A4',
  onBrand: '#FFFFFF',

  /** Surfaces. Cards sit on the canvas; `sunken` is for wells inside a card. */
  canvas: '#F1F5FA',
  surface: '#FFFFFF',
  sunken: '#EDF1F7',

  border: '#DEE5EF',
  borderStrong: '#C2CEDF',

  /** Physically scanned. */
  success: '#0E7A46',
  successTint: '#E3F4EB',
  /** An admin's assertion where evidence should be. */
  warning: '#A15C00',
  warningTint: '#FCF0DE',
  /** Failed, rejected, needs attention. */
  danger: '#B3261E',
  dangerTint: '#FBE9E7',

  /** Rocket exhaust. Decoration only — never a status. */
  flame: '#FF8F1F',
  /** Camera viewfinders and photo wells. */
  viewfinder: '#0B0F14',
} as const;

/** A 4pt grid. Everything that separates two things comes from here. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

/**
 * Elevation, given to both platforms at once.
 *
 * `shadow*` is what react-native-web turns into a box-shadow and what iOS reads;
 * `elevation` is the only one Android honours. Setting one without the other is the
 * usual way a card ends up flat on exactly one of the two targets.
 */
export const shadow = {
  card: {
    shadowColor: '#0C1729',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  raised: {
    shadowColor: '#0C1729',
    shadowOpacity: 0.1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  /** For the brand-coloured primary button, tinted so the glow reads as blue. */
  brand: {
    shadowColor: brand,
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
} satisfies Record<string, ViewStyle>;

/**
 * The type scale.
 *
 * No custom font is loaded. The system face is already the most legible thing on any
 * given device, it costs no bytes and no loading state, and a webfont that has not
 * arrived yet is a screen of invisible text — on the one surface, the web build, that
 * this app is actually demonstrated on.
 */
export const type = StyleSheet.create({
  /** Screen titles. */
  display: { fontSize: 26, fontWeight: '800', color: colors.ink, letterSpacing: -0.4 },
  title: { fontSize: 20, fontWeight: '700', color: colors.ink, letterSpacing: -0.2 },
  heading: { fontSize: 17, fontWeight: '700', color: colors.ink },
  body: { fontSize: 15, fontWeight: '400', color: colors.ink, lineHeight: 21 },
  bodyStrong: { fontSize: 15, fontWeight: '600', color: colors.ink },
  /** Supporting copy: hints, explanations, the reason a thing is the way it is. */
  caption: { fontSize: 13, fontWeight: '400', color: colors.inkMuted, lineHeight: 18 },
  /** Field labels and section eyebrows. Uppercase is applied by the style, not the
   *  copy, so the strings stay readable in source and to a screen reader. */
  overline: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkFaint,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  /** Serials, ID numbers — anything read out digit by digit. */
  mono: { fontFamily: 'monospace', fontSize: 13, color: colors.ink },
}) satisfies Record<string, TextStyle>;

/** Rows of things that sit side by side, which is most of them. */
export const row: ViewStyle = { flexDirection: 'row', alignItems: 'center' };
