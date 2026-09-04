import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '../src/auth/AuthContext';
import { primeSounds } from '../src/sound';
import { useSync } from '../src/sync/SyncContext';
import { HeaderLogo } from '../src/ui/GeaLogo';

type DashboardRoute = '/new' | '/transfer' | '/returns' | '/history' | '/admin';

type Action = {
  key: string;
  label: string;
  hint: string;
  onPress: (go: (path: DashboardRoute) => void) => void;
};

const ACTIONS: Action[] = [
  {
    key: 'new',
    label: 'New',
    hint: 'Create a batch, generate serials & QR codes',
    onPress: (go) => go('/new'),
  },
  {
    key: 'transfer',
    label: 'Transfer',
    hint: 'Browse batches still to move, then scan',
    onPress: (go) => go('/transfer'),
  },
  {
    key: 'returns',
    label: 'Returns',
    hint: 'Browse outstanding batches, capture driver sign-off',
    onPress: (go) => go('/returns'),
  },
  {
    key: 'history',
    label: 'History',
    hint: 'Every change on record — creations, first scans, transfers, returns',
    onPress: (go) => go('/history'),
  },
];

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const { pending, rejected, online, syncing } = useSync();
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          // `headerRight` REPLACES the shared one from `ui/chrome`, so the logo has
          // to be re-rendered alongside Sign out or it disappears on this screen —
          // the only screen most users see for any length of time.
          headerRight: () => (
            <View style={styles.headerRight}>
              <Pressable onPress={() => void signOut()} hitSlop={12}>
                <Text style={styles.signOut}>Sign out</Text>
              </Pressable>
              <HeaderLogo />
            </View>
          ),
        }}
      />

      {user ? (
        <Text style={styles.who}>
          {user.name} · {user.role.replace('_', ' ').toLowerCase()}
        </Text>
      ) : null}

      {/* The admin console, above everything else and visually distinct — it is the
          screen an admin comes here for, and burying it under four operational tiles
          would make the common case the longest journey. Hidden for other roles: the
          server refuses them anyway, so showing it would only offer a dead end. */}
      {user?.role === 'ADMIN' ? (
        <Pressable style={styles.admin} onPress={() => router.push('/admin')}>
          <Text style={styles.adminLabel}>Admin dashboard</Text>
          <Text style={styles.adminHint}>
            People, project managers, and correcting batch details
          </Text>
        </Pressable>
      ) : null}

      {pending.length > 0 || rejected.length > 0 || !online ? (
        <Pressable
          style={[styles.queue, rejected.length > 0 && styles.queueAlert]}
          onPress={() => router.push('/queue')}
        >
          <Text style={styles.queueText}>
            {!online ? 'Offline · ' : ''}
            {/* The queue carries transfers AND returns, so name neither. */}
            {pending.length > 0 ? `${pending.length} submission(s) waiting to sync` : null}
            {pending.length > 0 && rejected.length > 0 ? ' · ' : null}
            {rejected.length > 0 ? `${rejected.length} need attention` : null}
            {pending.length === 0 && rejected.length === 0
              ? 'Offline — queued work will sync automatically'
              : null}
          </Text>
          <Text style={styles.queueHint}>
            {syncing ? 'Syncing…' : 'Tap to open the sync queue'}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.grid}>
        {ACTIONS.map((a) => (
          <Pressable
            key={a.key}
            style={styles.card}
            onPress={() => {
              // The tap that starts a workflow is also the last guaranteed user
              // gesture before the camera starts firing scans at us, and a browser
              // will not let audio start outside one. Priming here is what makes the
              // FIRST beep of a session audible on the web build.
              primeSounds();
              a.onPress((p) => router.push(p));
            }}
          >
            <Text style={styles.cardLabel}>{a.label}</Text>
            <Text style={styles.cardHint}>{a.hint}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 16 },
  who: { fontSize: 14, opacity: 0.6 },
  signOut: { color: '#1f6feb', fontSize: 15, fontWeight: '600' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  grid: { gap: 12 },
  card: {
    backgroundColor: 'rgba(127,127,127,0.12)',
    borderRadius: 14,
    padding: 20,
    gap: 6,
  },
  cardLabel: { fontSize: 20, fontWeight: '700' },
  cardHint: { fontSize: 14, opacity: 0.7 },
  queue: {
    backgroundColor: 'rgba(184,134,11,0.18)',
    borderRadius: 10,
    padding: 12,
    gap: 2,
  },
  queueAlert: { backgroundColor: 'rgba(192,57,43,0.16)' },
  queueText: { fontWeight: '600' },
  queueHint: { fontSize: 13, opacity: 0.7 },
  admin: {
    backgroundColor: '#1f6feb',
    borderRadius: 14,
    padding: 20,
    gap: 4,
  },
  adminLabel: { fontSize: 22, fontWeight: '800', color: '#fff' },
  adminHint: { fontSize: 14, color: 'rgba(255,255,255,0.85)' },
});
