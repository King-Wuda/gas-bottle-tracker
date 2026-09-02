import { Text } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { PhotoCapture } from '../../src/components/PhotoCapture';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { ScreenScroll } from '../../src/ui/components';

/**
 * Workflow B3½ — photograph the batch, between the scan and the destination.
 *
 * Before the destination rather than after it, because the photo is of what is in
 * front of the operator right now. Choosing where the cylinders are going is a
 * decision made at a screen; the photo has to be taken at the cylinders.
 */
export default function TransferPhoto() {
  const router = useRouter();
  const { batch, scans, overrides, setPhoto, overridePhoto } = useScanFlow();
  const { user } = useAuth();

  if (!batch || scans.length + overrides.length === 0) return <Redirect href="/transfer" />;
  const selectedCount = scans.length + overrides.length;

  const next = () => router.push('/transfer/destination');

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        {batch.projectNumber} · {selectedCount} cylinder(s) selected
      </Text>

      <PhotoCapture
        title="Photograph the cylinders you are moving"
        hint="Get them in frame together, before they go on the truck. The photo is stamped with the time and, where the phone can get a fix, the location."
        ctaLabel="Choose destination"
        onDone={(taken) => {
          setPhoto(taken);
          next();
        }}
        isAdmin={user?.role === 'ADMIN'}
        onOverride={() => {
          overridePhoto();
          next();
        }}
      />
    </ScreenScroll>
  );
}
