import { Text, View } from 'react-native';
import type { DriverSignOff } from '../driver/useDriverSignOff';
import { IdCapture } from './IdCapture';
import { SignaturePad } from './SignaturePad';
import { Card, Field, SecondaryButton, styles } from '../ui/components';

/**
 * The driver sign-off form, shared by transfer and return.
 *
 * All four things on ONE screen because they are one conversation at the gate: the
 * driver hands over their ID, the operator reads the number off it, photographs it,
 * and hands the phone across to sign. Splitting them across steps would turn a single
 * exchange into four.
 *
 * Purely presentational — every piece of state lives in `useDriverSignOff`, so the
 * two screens that use this cannot drift apart in what they collect or when they
 * consider it complete.
 */
export function DriverSignOffForm({
  driver,
  isAdmin,
  online,
  submitting,
}: {
  driver: DriverSignOff;
  isAdmin: boolean;
  online: boolean;
  submitting: boolean;
}) {
  const { reading } = driver;

  return (
    <>
      <Card>
        <Field
          label="Collection driver name"
          value={driver.driverName}
          onChangeText={driver.setDriverName}
          autoCapitalize="words"
          placeholder="As it appears on their ID"
          editable={!submitting}
        />
        <Field
          label="Driver ID number"
          value={driver.driverIdNumber}
          onChangeText={driver.setDriverIdNumber}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="ID, passport or licence number"
          editable={!submitting}
        />
        <Text style={styles.hint}>
          Whatever document they are carrying — an ID card, a passport, a foreign licence. Type it
          exactly as printed.
        </Text>
      </Card>

      <Card>
        <IdCapture
          photo={driver.driverIdPhoto}
          onCaptured={driver.captureId}
          onClear={driver.clearId}
          overridden={driver.driverIdOverride}
          isAdmin={isAdmin}
          onOverride={driver.overrideId}
          disabled={submitting}
        />

        {/* What the server made of the photograph. Always a suggestion: the operator
            is holding the document, and the app is not. */}
        {reading.state === 'busy' ? (
          <Text style={styles.hint}>Reading the number off the photo…</Text>
        ) : null}
        {reading.state === 'read' ? (
          <View style={{ gap: 6 }}>
            <Text style={{ fontWeight: '700' }}>Read from the photo</Text>
            <Text style={{ fontFamily: 'monospace' }}>{reading.description}</Text>
            <Text style={styles.hint}>
              Check it against the card before you use it. The checksum on the number is valid,
              which is not the same as it being this driver&apos;s.
            </Text>
            <SecondaryButton
              title={
                driver.driverIdNumber.trim().length === 0
                  ? 'Use this number'
                  : 'Replace what I typed with this'
              }
              onPress={() => driver.acceptReading(reading.idNumber)}
              disabled={submitting}
            />
          </View>
        ) : null}
        {reading.state === 'none' ? <Text style={styles.hint}>{reading.reason}</Text> : null}
        {!online && driver.driverIdPhoto ? (
          <Text style={styles.hint}>
            Offline — the number cannot be read off the photo from here. Type it in; the photo is
            queued with the submission either way.
          </Text>
        ) : null}
      </Card>

      <View style={{ gap: 6 }}>
        <Text style={styles.label}>Driver signature</Text>
        <SignaturePad onChange={driver.onSign} />
      </View>
    </>
  );
}
