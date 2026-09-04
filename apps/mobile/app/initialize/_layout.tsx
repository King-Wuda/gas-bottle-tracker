import { Stack } from 'expo-router';
import { ScanFlowProvider } from '../../src/scanning/ScanFlowContext';
import { stackScreenOptions } from '../../src/ui/chrome';

/**
 * Workflow A2 — Initialize a batch.
 *
 * Its own `ScanFlowProvider`, like Transfer and Returns, so a half-finished
 * initialization and a half-finished transfer never see each other's scans.
 */
export default function InitializeLayout() {
  return (
    <ScanFlowProvider>
      <Stack screenOptions={stackScreenOptions}>
        <Stack.Screen name="index" options={{ title: 'Initialize — find batch' }} />
        <Stack.Screen name="scan" options={{ title: 'Scan every cylinder' }} />
        <Stack.Screen name="photo" options={{ title: 'Photo of the batch' }} />
        <Stack.Screen
          name="result"
          options={{ title: 'Batch initialized', headerBackVisible: false }}
        />
      </Stack>
    </ScanFlowProvider>
  );
}
