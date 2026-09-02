import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Card, ScreenScroll } from '../../src/ui/components';

export default function SiteMode() {
  const router = useRouter();
  return (
    <ScreenScroll>
      <Text style={{ fontSize: 15, opacity: 0.7 }}>
        Start a new site and project, add batches to an existing one, or scan in a batch whose QR
        labels have just been stuck on.
      </Text>

      <Card onPress={() => router.push('/new/create-site')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Create new site</Text>
        <Text style={{ opacity: 0.7 }}>
          New project number, project manager, site &amp; location.
        </Text>
      </Card>

      <Card onPress={() => router.push('/new/select-project')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Edit existing site</Text>
        <Text style={{ opacity: 0.7 }}>
          Find a project by number or PM name, then add batches to one of its sites.
        </Text>
      </Card>

      {/* The step between creating a batch and using it. Creating one allocates
          serials and emails a QR sheet; it does not put a sticker on a cylinder.
          Whoever does that — the project manager or a technician — comes back here to
          scan the batch in, which is what makes it transferable. It lives under New
          rather than on the dashboard because it belongs to the batch's creation, not
          to its working life. */}
      <Card onPress={() => router.push('/initialize')}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Initialize a batch</Text>
        <Text style={{ opacity: 0.7 }}>
          First scan after the QR codes are stuck on. Scan every cylinder, photograph the batch
          where it stands, and it becomes ready to transfer.
        </Text>
      </Card>
    </ScreenScroll>
  );
}
