import { Text } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { PhotoCapture } from '../../src/components/PhotoCapture';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { ScreenScroll } from '../../src/ui/components';

/**
 * Workflow C3½ — photograph the batch, between the scan and the driver's signature.
 *
 * Before the signature, deliberately: the driver is signing for what is in the photo,
 * so the photo has to exist by the time the pen goes on the screen.
 */
export default function ReturnsPhoto() {
  const router = useRouter();
  const { batch, scans, overrides, setPhoto, overridePhoto } = useScanFlow();
  const { user } = useAuth();

  if (!batch || scans.length + overrides.length === 0) return <Redirect href="/returns" />;
  const selectedCount = scans.length + overrides.length;

  const next = () => router.push('/returns/sign');

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        {batch.projectNumber} · {selectedCount} cylinder(s) going back
      </Text>

      <PhotoCapture
        title="Photograph the cylinders going back"
        hint="Get them in frame together, as the driver is collecting them. The photo is stamped with the time and, where the phone can get a fix, the location."
        ctaLabel="Driver sign-off"
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
