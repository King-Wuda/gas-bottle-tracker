import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { Card, ScreenScroll, styles } from '../../src/ui/components';

/**
 * The admin landing screen.
 *
 * People first, then the reference data the batch form is built out of.
 *
 * Project managers come first because they ARE the admins: every one of them signs in
 * and runs this console, and they are who the paperwork is addressed to. There is no
 * separate list of admin accounts. People is everyone else who signs in — technicians,
 * subcontractors and stores managers.
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

      <Card onPress={() => router.push('/admin/project-managers')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Project managers</Text>
        <Text style={{ opacity: 0.75 }}>
          The admins. They sign in, run this console, and receive QR sheets and delivery notes.
        </Text>
        <Text style={styles.hint}>Add a manager, set a password, or deactivate one.</Text>
      </Card>

      <Card onPress={() => router.push('/admin/users')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>People</Text>
        <Text style={{ opacity: 0.75 }}>
          Technicians, subcontractors and stores managers — everyone else who signs in.
        </Text>
        <Text style={styles.hint}>Add someone, change a role, or deactivate an account.</Text>
      </Card>

      <Card onPress={() => router.push('/admin/drivers')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Drivers</Text>
        <Text style={{ opacity: 0.75 }}>
          The regular collection drivers, picked at sign-off on transfers and returns.
        </Text>
        <Text style={styles.hint}>Add a driver, edit their details, or remove one.</Text>
      </Card>

      <Card onPress={() => router.push('/admin/clients')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Clients and locations</Text>
        <Text style={{ opacity: 0.75 }}>
          Who the depot delivers to, and the sites they take delivery at. The batch form picks from
          this list.
        </Text>
        <Text style={styles.hint}>Add a client location, or remove one.</Text>
      </Card>

      <Card onPress={() => router.push('/admin/projects')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Projects</Text>
        <Text style={{ opacity: 0.75 }}>Every job on record, and its batch count.</Text>
        <Text style={styles.hint}>
          Delete a job and its deliveries. Permanent — the client is left alone.
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
