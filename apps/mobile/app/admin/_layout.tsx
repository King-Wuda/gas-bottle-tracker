import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { LoadingState } from '../../src/ui/components';
import { stackScreenOptions } from '../../src/ui/chrome';

/**
 * The admin console.
 *
 * Guarded here rather than per screen: one gate is one thing to get right, and a
 * screen added later inherits it instead of having to remember it. This is a
 * convenience gate, not the security boundary — every `/admin/*` endpoint enforces the
 * role server-side, because a client check protects nothing from a client that has
 * been modified.
 */
export default function AdminLayout() {
  const { status, user } = useAuth();

  if (status === 'loading') return <LoadingState label="Checking access..." />;
  if (!user) return <Redirect href="/login" />;
  if (user.role !== 'ADMIN') return <Redirect href="/" />;

  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: 'Admin' }} />
      <Stack.Screen name="users" options={{ title: 'People' }} />
      <Stack.Screen name="project-managers" options={{ title: 'Project managers' }} />
      <Stack.Screen name="batch/[id]" options={{ title: 'Correct batch' }} />
    </Stack>
  );
}
