import { Image, View, type ImageStyle, type StyleProp } from 'react-native';
import { GEA_LOGO_ASPECT, GEA_LOGO_URI } from './geaLogo';

/**
 * The GEA wordmark.
 *
 * Callers give a width; the height follows the artwork's own aspect ratio, so the
 * mark can never be squashed by a caller that guessed one dimension. `resizeMode`
 * is `contain` as a second line of defence for the same reason.
 *
 * The source is a data URI (see `ui/geaLogo.ts`) rather than a bundled asset file,
 * which is what lets the same component render identically in the static web export
 * and in the APK without an asset path to get wrong.
 */
export function GeaLogo({ width = 96, style }: { width?: number; style?: StyleProp<ImageStyle> }) {
  return (
    <Image
      source={{ uri: GEA_LOGO_URI }}
      style={[{ width, height: width / GEA_LOGO_ASPECT }, style]}
      resizeMode="contain"
      accessibilityLabel="GEA"
      accessible
    />
  );
}

/**
 * The mark as it appears at the top right of every screen with a navigation header.
 *
 * Fed to `Stack.screenOptions.headerRight` (see `ui/chrome.tsx`), which is why it
 * carries its own right padding: React Navigation lays `headerRight` out flush to the
 * screen edge, so without it the last letter is clipped off the side of the display.
 *
 * Sized small on purpose. This shares the bar with a back arrow, a title and — on the
 * scan step — an "Override scan" action, and the branding must not be what pushes a
 * title into an ellipsis.
 */
export function HeaderLogo() {
  return (
    <View style={{ paddingRight: 14, paddingLeft: 10, justifyContent: 'center' }}>
      <GeaLogo width={54} />
    </View>
  );
}
