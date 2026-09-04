import { Image, View, type ImageStyle, type StyleProp } from 'react-native';
import { GEA_LOGO_ASPECT, GEA_LOGO_URI, GEA_MARK_ASPECT, GEA_MARK_URI } from './geaLogo';
import { space } from './theme';

/**
 * The GEA lockup: the letters plus "Engineering for a better world."
 *
 * Callers give a width; the height follows the artwork's own aspect ratio, so the mark
 * can never be squashed by a caller that guessed one dimension. `resizeMode` is
 * `contain` as a second line of defence for the same reason.
 *
 * The source is a data URI (see `ui/geaLogo.ts`) rather than a bundled asset file,
 * which is what lets the same component render identically in the static web export
 * and in the APK without an asset path to get wrong.
 */
export function GeaLogo({ width = 160, style }: { width?: number; style?: StyleProp<ImageStyle> }) {
  return (
    <Image
      source={{ uri: GEA_LOGO_URI }}
      style={[{ width, height: width / GEA_LOGO_ASPECT }, style]}
      resizeMode="contain"
      accessibilityLabel="GEA — Engineering for a better world"
      accessible
    />
  );
}

/**
 * The letters alone.
 *
 * For the places where the tagline would be illegible rather than merely small: the
 * rockets, whose bodies are 92px across. Printing three lines of 4px text there is
 * worse than not printing them — it reads as a smudge and makes the mark look broken.
 */
export function GeaMark({ width = 96, style }: { width?: number; style?: StyleProp<ImageStyle> }) {
  return (
    <Image
      source={{ uri: GEA_MARK_URI }}
      style={[{ width, height: width / GEA_MARK_ASPECT }, style]}
      resizeMode="contain"
      accessibilityLabel="GEA"
      accessible
    />
  );
}

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
