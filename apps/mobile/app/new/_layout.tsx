import { Stack } from 'expo-router';
import { NewFlowProvider } from '../../src/new/NewFlowContext';

export default function NewLayout() {
  return (
    <NewFlowProvider>
      <Stack screenOptions={{ headerTitleStyle: { fontWeight: '600' } }}>
        <Stack.Screen name="index" options={{ title: 'New batch' }} />
        <Stack.Screen name="create-site" options={{ title: 'Create new site' }} />
        <Stack.Screen name="select-project" options={{ title: 'Edit existing site' }} />
        <Stack.Screen name="line-items" options={{ title: 'Cylinder line items' }} />
        <Stack.Screen
          name="confirm"
          options={{ title: 'Batch created', headerBackVisible: false }}
        />
      </Stack>
    </NewFlowProvider>
  );
}
