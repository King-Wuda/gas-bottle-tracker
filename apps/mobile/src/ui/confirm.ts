import { Platform } from 'react-native';

/**
 * "Are you sure?", on both targets.
 *
 * **`Alert.alert` is a no-op on react-native-web.** It does not throw and it does not
 * warn — the promise simply never settles, so a confirmation written the native way
 * silently swallows the action on the surface this project is actually tested on. Two
 * screens had already grown their own copy of this branch; this is that copy, once,
 * before a third and fourth could drift from it.
 *
 * Resolves false on cancel, which is the safe answer for every caller here.
 */
export async function confirmAction(message: string, title = 'Are you sure?'): Promise<boolean> {
  if (Platform.OS === 'web') return globalThis.confirm(message);
  const { Alert } = await import('react-native');
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}

/**
 * The second gate in front of a delete that destroys evidence.
 *
 * A destructive confirm is only as good as the reader's attention, and "Are you sure?"
 * is answered yes by reflex. Where a delete takes batches, signatures and delivery
 * notes with it, the admin types the name of the thing first — which cannot be done by
 * reflex, and forces them to read which client they actually picked.
 *
 * `expected` is compared case-insensitively and trimmed: this is a speed bump against
 * acting without looking, not a spelling test.
 */
export async function confirmByTyping(message: string, expected: string): Promise<boolean> {
  const answer =
    Platform.OS === 'web'
      ? globalThis.prompt(message)
      : await promptNative(message, expected).catch(() => null);
  return answer !== null && answer.trim().toLowerCase() === expected.trim().toLowerCase();
}

/**
 * `Alert.prompt` is iOS-only. On Android there is no built-in text prompt at all, so
 * the fallback is the plain confirmation — the impact counts are in the message either
 * way, and an Android admin is not made safer by a dialog that cannot render.
 */
async function promptNative(message: string, expected: string): Promise<string | null> {
  const { Alert } = await import('react-native');
  if (Platform.OS !== 'ios' || typeof Alert.prompt !== 'function') {
    return (await confirmAction(message)) ? expected : null;
  }
  return new Promise((resolve) => {
    Alert.prompt(
      'Type the name to confirm',
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        { text: 'Delete', style: 'destructive', onPress: (text?: string) => resolve(text ?? '') },
      ],
      'plain-text',
    );
  });
}
