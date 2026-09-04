import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '../src/auth/AuthContext';
import { primeSounds } from '../src/sound';
import { useSync } from '../src/sync/SyncContext';
import { HeaderLogo } from '../src/ui/GeaLogo';
import {
  AdminIcon,
  ChevronIcon,
  HistoryIcon,
  NewBatchIcon,
  ReturnIcon,
  SyncIcon,
  TransferIcon,
} from '../src/ui/icons';
import { colors, radius, shadow, space, type } from '../src/ui/theme';

type DashboardRoute = '/new' | '/transfer' | '/returns' | '/history' | '/admin';

interface Action {
  key: string;
  label: string;
  hint: string;
  route: DashboardRoute;
  icon: (color: string) => ReactNode;
}

/**
 * The four things a person comes here to do, in the order the batch lifecycle
 * happens: book it in, move it, take it back, look at what happened.
 */
const ACTIONS: Action[] = [
  {
    key: 'new',
    label: 'New batch',
    hint: 'Allocate serials and print QR labels',
    route: '/new',
    icon: (c) => <NewBatchIcon color={c} size={26} />,
  },
  {
    key: 'transfer',
    label: 'Transfer',
    hint: 'Scan cylinders onto a truck or to a site',
    route: '/transfer',
    icon: (c) => <TransferIcon color={c} size={26} />,
  },
  {
    key: 'returns',
    label: 'Returns',
    hint: 'Scan cylinders back and take driver sign-off',
    route: '/returns',
    icon: (c) => <ReturnIcon color={c} size={26} />,
  },
  {
    key: 'history',
    label: 'History',
    hint: 'Every movement on record, with its evidence',
    route: '/history',
    icon: (c) => <HistoryIcon color={c} size={26} />,
  },
];

/** "Stores manager" out of STORES_MANAGER, without shouting it. */
const readableRole = (role: string): string =>
  role.charAt(0) + role.slice(1).toLowerCase().replace(/_/g, ' ');

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const { pending, rejected, online, syncing } = useSync();
  const router = useRouter();

  const go = (route: DashboardRoute) => {
    // The tap that starts a workflow is also the last guaranteed user gesture before
    // the camera starts firing scans at us, and a browser will not let audio start
    // outside one. Priming here is what makes the FIRST beep of a session audible on
    // the web build.
    primeSounds();
    router.push(route);
  };

  const needsAttention = rejected.length > 0;
  const queueVisible = pending.length > 0 || needsAttention || !online;

  return (
    <ScrollView style={styles.bg} contentContainerStyle={styles.container}>
      <Stack.Screen
        options={{
          // `headerRight` REPLACES the shared one from `ui/chrome`, so the logo has to
          // be re-rendered alongside Sign out or it disappears on this screen — the
          // one most users see for the longest.
          headerRight: () => (
            <View style={styles.headerRight}>
              <Pressable role="button" onPress={() => void signOut()} hitSlop={12}>
                <Text style={styles.signOut}>Sign out</Text>
              </Pressable>
              <HeaderLogo />
            </View>
          ),
        }}
      />

      {user ? (
        <View style={styles.greeting}>
          <Text style={styles.greetingName}>{user.name}</Text>
          <View style={styles.rolePill}>
            <Text style={styles.rolePillText}>{readableRole(user.role)}</Text>
          </View>
        </View>
      ) : null}

      {/* The admin console, above everything else and visually distinct — it is the
          screen an admin comes here for, and burying it under four operational tiles
          would make the common case the longest journey. Hidden for other roles: the
          server refuses them anyway, so showing it would only offer a dead end. */}
      {user?.role === 'ADMIN' ? (
        <Pressable
          role="button"
          onPress={() => router.push('/admin')}
          style={({ pressed }) => [styles.admin, pressed && styles.adminPressed]}
        >
          <View style={styles.adminIcon}>
            <AdminIcon color={colors.onBrand} size={24} />
          </View>
          <View style={styles.adminCopy}>
            <Text style={styles.adminLabel}>Admin console</Text>
            <Text style={styles.adminHint}>People, project managers, batch corrections</Text>
          </View>
          <ChevronIcon color="rgba(255,255,255,0.75)" size={20} />
        </Pressable>
      ) : null}

      {/* Only when there is something to say. A permanent "0 waiting" row trains
          people to stop reading the one place that ever carries bad news. */}
      {queueVisible ? (
        <Pressable
          role="button"
          onPress={() => router.push('/queue')}
          style={({ pressed }) => [
            styles.queue,
            needsAttention && styles.queueAlert,
            pressed && styles.queuePressed,
          ]}
        >
          <SyncIcon color={needsAttention ? colors.danger : colors.warning} size={22} />
          <View style={styles.queueCopy}>
            <Text style={[styles.queueText, needsAttention && styles.queueTextAlert]}>
              {!online ? 'Offline · ' : ''}
              {/* The queue carries transfers AND returns, so name neither. */}
              {pending.length > 0 ? `${pending.length} submission(s) waiting to sync` : null}
              {pending.length > 0 && needsAttention ? ' · ' : null}
              {needsAttention ? `${rejected.length} need attention` : null}
              {pending.length === 0 && !needsAttention
                ? 'Offline — queued work syncs automatically'
                : null}
            </Text>
            <Text style={styles.queueHint}>
              {syncing ? 'Syncing…' : 'Tap to open the sync queue'}
            </Text>
          </View>
          <ChevronIcon color={needsAttention ? colors.danger : colors.warning} size={18} />
        </Pressable>
      ) : null}

      <View style={styles.grid}>
        {ACTIONS.map((a) => (
          <Pressable
            key={a.key}
            role="button"
            onPress={() => go(a.route)}
            style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
          >
            <View style={styles.tileIcon}>{a.icon(colors.brand)}</View>
            <View style={styles.tileCopy}>
              <Text style={styles.tileLabel}>{a.label}</Text>
              <Text style={styles.tileHint}>{a.hint}</Text>
            </View>
            <ChevronIcon size={20} />
          </Pressable>
        ))}
      </View>

      <Text style={styles.footnote}>
        Initializing a new batch lives under New batch — a batch cannot be moved or returned until
        its labels have been scanned back off the cylinders.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bg: { backgroundColor: colors.canvas },
  container: { padding: space.xl, paddingBottom: space.xxxl, gap: space.lg },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  signOut: { color: colors.brand, fontSize: 15, fontWeight: '600' },

  greeting: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' },
  greetingName: type.display,
  rolePill: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 1,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTint,
  },
  rolePillText: { fontSize: 12, fontWeight: '700', color: colors.brand, letterSpacing: 0.2 },

  admin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.brand,
    borderRadius: radius.lg,
    padding: space.lg,
    ...shadow.brand,
  },
  adminPressed: { backgroundColor: colors.brandDark },
  adminIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  adminCopy: { flex: 1, gap: 2 },
  adminLabel: { fontSize: 17, fontWeight: '800', color: colors.onBrand },
  adminHint: { fontSize: 13, color: 'rgba(255,255,255,0.82)', lineHeight: 18 },

  queue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.warningTint,
    borderWidth: 1,
    borderColor: '#EBD3AA',
    borderRadius: radius.md,
    padding: space.md + 2,
  },
  queueAlert: { backgroundColor: colors.dangerTint, borderColor: '#F3CFCB' },
  queuePressed: { opacity: 0.85 },
  queueCopy: { flex: 1, gap: 2 },
  queueText: { fontSize: 14, fontWeight: '700', color: colors.warning },
  queueTextAlert: { color: colors.danger },
  queueHint: { fontSize: 12, color: colors.inkMuted },

  grid: { gap: space.md },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    ...shadow.card,
  },
  tilePressed: { backgroundColor: colors.brandTint, borderColor: colors.brandTintStrong },
  tileIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileCopy: { flex: 1, gap: 3 },
  tileLabel: { fontSize: 17, fontWeight: '700', color: colors.ink },
  tileHint: { fontSize: 13, color: colors.inkMuted, lineHeight: 18 },

  footnote: { ...type.caption, textAlign: 'center', paddingHorizontal: space.md },
});
