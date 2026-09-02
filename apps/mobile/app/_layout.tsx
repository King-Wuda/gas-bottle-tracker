import { ActivityIndicator, View } from 'react-native';
import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { SyncProvider } from '../src/sync/SyncContext';

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
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: '600' } }}>
      <Stack.Screen name="index" options={{ title: 'Gas Cylinder Tracker' }} />
      <Stack.Screen name="login" options={{ title: 'Sign in', headerShown: false }} />
      <Stack.Screen name="new" options={{ headerShown: false }} />
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
