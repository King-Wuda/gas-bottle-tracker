import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { Card, ScreenScroll, styles } from '../../src/ui/components';

/**
 * The admin landing screen.
 *
 * People first, then the reference data the batch form is built out of.
 *
 * The two people screens stay separate rather than merging into one list: **people who
 * log in** and **people the paperwork is addressed to** are different things that
 * happen to both be called "users" in conversation, and merging them would invite
 * deactivating a project manager in order to revoke a login they never had.
 *
 * Everything below People can be deleted for real, and the screens say so before they
 * do it. Deactivating is still the everyday move — a supplier the depot stopped buying
 * from has three years of cylinders in the yard whose delivery notes must keep naming
 * them.
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
        <Text style={styles.hint}>Add someone, change a role, or deactivate an account.</Text>
      </Card>

      <Card onPress={() => router.push('/admin/project-managers')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Project managers</Text>
        <Text style={{ opacity: 0.75 }}>
          The people QR sheets and delivery notes are emailed to. They do not sign in.
        </Text>
        <Text style={styles.hint}>Add a manager, correct an address, or deactivate one.</Text>
      </Card>

      <Card onPress={() => router.push('/admin/clients')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Clients and locations</Text>
        <Text style={{ opacity: 0.75 }}>
          Who the depot delivers to, and the sites they take delivery at.
        </Text>
        <Text style={styles.hint}>
          Delete a location, all of them, or the client outright. Permanent.
        </Text>
      </Card>

      <Card onPress={() => router.push('/admin/gases')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Gases</Text>
        <Text style={{ opacity: 0.75 }}>
          What the batch form offers, and which suppliers carry each one.
        </Text>
        <Text style={styles.hint}>Add a gas, pair a supplier to it, or remove either.</Text>
      </Card>

      <Card onPress={() => router.push('/admin/suppliers')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Suppliers</Text>
        <Text style={{ opacity: 0.75 }}>The companies cylinders are bought from.</Text>
        <Text style={styles.hint}>Add one, rename it, or take it out of the pickers.</Text>
      </Card>

      <Card onPress={() => router.push('/history')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Correct a batch</Text>
        <Text style={{ opacity: 0.75 }}>
          Find the batch in History, open it, then tap &quot;Correct these details&quot;.
        </Text>
        <Text style={styles.hint}>
          Every correction is recorded with your name and what changed.
        </Text>
      </Card>
    </ScreenScroll>
  );
}
