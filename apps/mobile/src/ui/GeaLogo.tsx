import Svg, { Path } from 'react-native-svg';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { space } from './theme';

/**
 * The GEA wordmark, as vector paths.
 *
 * ## What was wrong before
 *
 * This used to be a pair of PNGs embedded as data URIs, DRAWN by `scripts/gen-logo.mjs`
 * as an approximation of the real thing: stroked circles and lines forming rough
 * letters, a diagonal slash across them, and "Engineering for a better world." set in
 * DejaVu Sans. It was never the GEA logo — it was a placeholder standing in for one,
 * and it shipped to the live site looking like a broken version of the brand.
 *
 * These are the real outlines from the 2022 identity: three filled paths on a
 * 1000 x 303.8 grid. Not a trace, not a font substitute — the actual artwork.
 *
 * ## Why vector rather than another PNG
 *
 * `react-native-svg` is already a dependency (the signature pad and every icon use
 * it), and it renders identically in the web export and the APK — which is the whole
 * problem the data-URI PNGs existed to solve, solved better. A logo is line art: at
 * 112px in a header it stays crisp, and it costs about 700 bytes of source instead of
 * 60KB of base64 inlined into the bundle.
 *
 * That also retires `assets/gea-*.png`, `src/ui/geaLogo.ts`, `scripts/embed-logo.mjs`
 * and `scripts/gen-logo.mjs`. There is nothing left to regenerate: to change the mark,
 * change the paths below.
 */

/** The brand blue, straight from the official artwork. Not a theme colour: the logo
 *  is the logo, and it must not drift if the palette is ever retuned. */
const GEA_BLUE = '#0303B8';

/** The artwork's own grid, so any width lays out at the right height. */
const VIEW_BOX = '0 0 1000 303.8';
export const GEA_LOGO_ASPECT = 1000 / 303.8;

const PATHS = [
  'm 848.01324,0.0378 h -75.9148 l -50.60947,101.24357 56.31008,0.0118 32.45945,-64.84954 133.43142,267.32488 H 1000 Z',
  'm 822.71264,126.62652 -657.92432,-0.0236 -25.30532,50.62129 h 101.22012 v 75.93252 h -89.71491 c -55.472478,0 -100.603501,-45.21611 -100.603501,-101.20713 0,-55.9909 45.131023,-101.29232 100.603501,-101.29232 H 265.91273 V 0.01097 l -114.92452,10e-6 C 67.732932,0.01095 0,68.17091 0,151.94957 c 0,83.77914 67.732932,151.8296 150.98821,151.8296 H 291.31259 V 177.22418 h 75.91362 V 303.77917 H 569.6641 L 594.96942,253.1567 H 417.83568 V 177.22418 H 683.219 l -62.94543,126.55499 h 56.2829 l 63.27041,-126.55499 h 108.1899 z',
  'm 417.83686,50.64626 177.1302,0.0128 V 0.0372 L 367.19785,0 l 0.005,101.29254 h 50.63428 z',
];

/**
 * The wordmark. Callers give a width; the height follows the artwork's aspect ratio,
 * so it can never be squashed by a caller that guessed one dimension.
 */
export function GeaLogo({ width = 160, style }: { width?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[{ width, height: width / GEA_LOGO_ASPECT }, style]}
      accessibilityLabel="GEA"
      accessible
    >
      <Svg width="100%" height="100%" viewBox={VIEW_BOX}>
        {PATHS.map((d) => (
          <Path key={d.slice(0, 24)} d={d} fill={GEA_BLUE} />
        ))}
      </Svg>
    </View>
  );
}

/**
 * The same mark, kept as a separate export because callers ask for it by name.
 *
 * It used to differ: the lockup carried a tagline and this one dropped it, because
 * three lines of 4px text on a 92px rocket read as a smudge. The 2022 identity is the
 * wordmark alone, so there is no tagline to drop and the two are the same drawing —
 * and being vector, it is legible at rocket size rather than merely small.
 */
export function GeaMark({ width = 96, style }: { width?: number; style?: StyleProp<ViewStyle> }) {
  return <GeaLogo width={width} style={style} />;
}

/** Kept for callers that measured against the mark rather than the lockup. */
export const GEA_MARK_ASPECT = GEA_LOGO_ASPECT;

/**
 * The lockup as it appears at the top right of every screen with a navigation header.
 *
 * Fed to `Stack.screenOptions.headerRight` (see `ui/chrome.tsx`), which is why it
 * carries its own right padding: React Navigation lays `headerRight` out flush to the
 * screen edge, so without it the last letter is clipped off the side of the display.
 */
export function HeaderLogo() {
  return (
    <View style={{ paddingRight: space.md, paddingLeft: space.sm, justifyContent: 'center' }}>
      <GeaLogo width={112} />
    </View>
  );
}
