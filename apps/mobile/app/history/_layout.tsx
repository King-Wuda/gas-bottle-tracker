import { Stack } from 'expo-router';

export default function HistoryLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: '600' } }}>
      <Stack.Screen name="index" options={{ title: 'History' }} />
      <Stack.Screen name="serial-lookup" options={{ title: 'Cylinder lookup' }} />
      <Stack.Screen name="event/[kind]/[id]" options={{ title: 'Event detail' }} />
      <Stack.Screen name="batch/[id]" options={{ title: 'Batch detail' }} />
      <Stack.Screen name="[serial]" options={{ title: 'Cylinder history' }} />
    </Stack>
  );
}
