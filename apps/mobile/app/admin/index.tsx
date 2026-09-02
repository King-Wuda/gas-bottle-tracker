import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { Card, ScreenScroll, styles } from '../../src/ui/components';

/**
 * The admin landing screen.
 *
 * Two populations, deliberately on separate screens rather than one merged list:
 * **people who log in** and **people the paperwork is addressed to** are different
 * things that happen to both be called "users" in conversation, and merging them
 * would invite deactivating a project manager in order to revoke a login they never
 * had.
 */
export default function AdminHome() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        Signed in as {user?.name}. Changes here take effect immediately.
      </Text>

      <Card onPress={() => router.push('/admin/users')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>People</Text>
        <Text style={{ opacity: 0.75 }}>
          Admins, stores managers and technicians — the accounts that can sign in.
        </Text>
        <Text style={styles.label}>Add someone, change a role, or deactivate an account.</Text>
      </Card>

      <Card onPress={() => router.push('/admin/project-managers')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Project managers</Text>
        <Text style={{ opacity: 0.75 }}>
          The people QR sheets and delivery notes are emailed to. They do not sign in.
        </Text>
        <Text style={styles.label}>Add a manager, correct an address, or deactivate one.</Text>
      </Card>

      <Card onPress={() => router.push('/history')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Correct a batch</Text>
        <Text style={{ opacity: 0.75 }}>
          Find the batch in History, open it, then tap &quot;Correct these details&quot;.
        </Text>
        <Text style={styles.label}>
          Every correction is recorded with your name and what changed.
        </Text>
      </Card>
    </ScreenScroll>
  );
}
