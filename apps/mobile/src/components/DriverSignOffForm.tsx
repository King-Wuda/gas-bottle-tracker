import { Text, View } from 'react-native';
import type { DriverSignOff } from '../driver/useDriverSignOff';
import { SignaturePad } from './SignaturePad';
import { Card, Checkbox, Field, styles } from '../ui/components';
import { Select } from '../ui/controls';
import { type } from '../ui/theme';

/**
 * The driver sign-off form, shared by transfer and return.
 *
 * The first option is the regular drivers: pick one and their name, email and phone
 * come from their profile. For anyone else, tick "Driver not registered" and type
 * those three in. Then the driver signs. All on ONE screen, because it is one
 * conversation at the gate.
 *
 * Purely presentational — every piece of state lives in `useDriverSignOff`, so the
 * two screens that use this cannot drift apart in what they collect or when they
 * consider it complete.
 */
export function DriverSignOffForm({
  driver,
  submitting,
}: {
  driver: DriverSignOff;
  submitting: boolean;
}) {
  const options = driver.profiles.map((d) => ({ value: d.id, label: d.fullName }));
  const noProfiles = driver.profilesLoaded && driver.profiles.length === 0;

  return (
    <>
      <Card>
        <Text style={type.heading}>Collection driver</Text>
        <Select
          label="Registered driver"
          placeholder="Choose the driver"
          options={options}
          value={driver.unregistered ? null : driver.selectedId}
          onChange={driver.select}
          disabled={submitting || driver.unregistered}
          disabledHint={
            driver.unregistered ? 'Untick “Driver not registered” to choose one.' : undefined
          }
          footer={
            !driver.unregistered && driver.selected ? (
              <Text style={styles.hint}>
                {driver.selected.phone} · {driver.selected.email}
              </Text>
            ) : noProfiles && !driver.unregistered ? (
              <Text style={styles.hint}>
                No drivers are registered yet. A project manager adds them under Admin console →
                Drivers.
              </Text>
            ) : null
          }
        />
        <Checkbox
          label="Driver not registered"
          hint="Enter their name, email and phone number instead."
          value={driver.unregistered}
          onChange={driver.setUnregistered}
          disabled={submitting}
        />
        {driver.unregistered ? (
          <View>
            <Field
              label="Name and surname"
              value={driver.driverName}
              onChangeText={driver.setDriverName}
              autoCapitalize="words"
              placeholder="e.g. Bongani Zulu"
              editable={!submitting}
            />
            <Field
              label="Email address"
              value={driver.driverEmail}
              onChangeText={driver.setDriverEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              placeholder="e.g. bongani@example.com"
              editable={!submitting}
              error={driver.driverEmailInvalid ? 'That does not look like an email address.' : null}
            />
            <Field
              label="Phone number"
              value={driver.driverPhone}
              onChangeText={driver.setDriverPhone}
              keyboardType="phone-pad"
              autoComplete="tel"
              autoCorrect={false}
              placeholder="e.g. 082 555 0199"
              editable={!submitting}
              error={driver.driverPhoneInvalid ? 'That does not look like a phone number.' : null}
            />
          </View>
        ) : null}
      </Card>

      <View style={{ gap: 6 }}>
        <Text style={styles.label}>Driver signature</Text>
        <SignaturePad onChange={driver.onSign} />
      </View>
    </>
  );
}
