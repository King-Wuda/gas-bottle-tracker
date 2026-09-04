import { ActivityIndicator, View } from 'react-native';
import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { SyncProvider } from '../src/sync/SyncContext';
import { stackScreenOptions } from '../src/ui/chrome';

function AuthGate() {
  const { status } = useAuth();
  const segments = useSegments();
  const onLogin = segments[0] === 'login';

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Redirect during render rather than in an effect: an effect runs after the first
  // commit, so a signed-out user would see one frame of the dashboard first.
  if (status === 'signedOut' && !onLogin) return <Redirect href="/login" />;
  if (status === 'signedIn' && onLogin) return <Redirect href="/" />;

  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: 'Gas Cylinder Tracker' }} />
      <Stack.Screen name="login" options={{ title: 'Sign in', headerShown: false }} />
      <Stack.Screen name="new" options={{ headerShown: false }} />
      {/* These two own nested stacks with their own headers, exactly like the four
          around them. Without this the root stack draws a second header above the
          nested one — two title bars, and now two GEA logos, on every admin and
          initialize screen. */}
      <Stack.Screen name="initialize" options={{ headerShown: false }} />
      <Stack.Screen name="admin" options={{ headerShown: false }} />
      <Stack.Screen name="transfer" options={{ headerShown: false }} />
      <Stack.Screen name="returns" options={{ headerShown: false }} />
      <Stack.Screen name="queue" options={{ title: 'Sync queue' }} />
      <Stack.Screen name="history" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <SyncProvider>
        <StatusBar style="auto" />
        <AuthGate />
      </SyncProvider>
    </AuthProvider>
  );
}
