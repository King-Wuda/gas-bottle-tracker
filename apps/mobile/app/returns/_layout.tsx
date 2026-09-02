import { Stack } from 'expo-router';
import { ScanFlowProvider } from '../../src/scanning/ScanFlowContext';

export default function ReturnsLayout() {
  return (
    <ScanFlowProvider>
      <Stack screenOptions={{ headerTitleStyle: { fontWeight: '600' } }}>
        <Stack.Screen name="index" options={{ title: 'Returns — find batch' }} />
        <Stack.Screen name="scan" options={{ title: 'Verify cylinders' }} />
        <Stack.Screen name="photo" options={{ title: 'Photo of the batch' }} />
        <Stack.Screen name="sign" options={{ title: 'Driver sign-off' }} />
        <Stack.Screen name="result" options={{ title: 'Return submitted' }} />
      </Stack>
    </ScanFlowProvider>
  );
}
