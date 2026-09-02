import { Stack } from 'expo-router';
import { ScanFlowProvider } from '../../src/scanning/ScanFlowContext';

export default function TransferLayout() {
  return (
    <ScanFlowProvider>
      <Stack screenOptions={{ headerTitleStyle: { fontWeight: '600' } }}>
        <Stack.Screen name="index" options={{ title: 'Transfer — find batch' }} />
        <Stack.Screen name="scan" options={{ title: 'Scan cylinders' }} />
        <Stack.Screen name="photo" options={{ title: 'Photo of the batch' }} />
        <Stack.Screen name="destination" options={{ title: 'Destination' }} />
        <Stack.Screen name="result" options={{ title: 'Transfer submitted' }} />
      </Stack>
    </ScanFlowProvider>
  );
}
