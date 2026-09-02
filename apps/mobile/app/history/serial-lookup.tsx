import { useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Scanner, type ScanOutcome } from '../../src/components/Scanner';
import { verifyScannedCode, qrVerificationConfigured } from '../../src/qr/verify';
import {
  ErrorText,
  Field,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';

/**
 * M5 audit lookup — "where has this cylinder been?"
 *
 * Reached from the History tab's batch list. The list answers "what happened to this
 * batch"; this answers the narrower question someone asks with a cylinder in hand.
 *
 * Unlike Workflow B and C, scanning is a convenience here, not enforcement: this is a
 * read-only question about a cylinder that may be lost, mislabelled, or in someone
 * else's yard, so a typed serial is a legitimate way to ask it. The scanner is offered
 * because reading `NIT26-014` off a scuffed sticker is the part people get wrong.
 */
export default function SerialLookup() {
  const router = useRouter();
  const [serial, setSerial] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (code: string): void => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) {
      setError('Enter or scan a cylinder serial.');
      return;
    }
    setError(null);
    setScanning(false);
    // Object form, not a template string: expo-router's typed routes want the route
    // pattern plus params, and it handles the escaping.
    router.push({ pathname: '/history/[serial]', params: { serial: trimmed } });
  };

  const onScan = (raw: string): ScanOutcome => {
    // An unverifiable code still identifies a cylinder well enough to look up, so
    // read the serial out of it either way and let the server be the authority.
    try {
      const result = verifyScannedCode(raw);
      if (result.ok) {
        open(result.serialCode);
        return { kind: 'accepted', serialCode: result.serialCode, payload: raw };
      }
      return { kind: 'invalid', reason: result.reason };
    } catch (err) {
      return { kind: 'invalid', reason: err instanceof Error ? err.message : String(err) };
    }
  };

  if (scanning) {
    return (
      <Scanner
        onScan={onScan}
        footer={
          <SecondaryButton title="Type the serial instead" onPress={() => setScanning(false)} />
        }
      />
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        Look up every recorded movement of one cylinder — who moved it, when, and where it is now.
      </Text>

      <Field
        label="Cylinder serial"
        value={serial}
        onChangeText={setSerial}
        placeholder="NIT26-001"
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => open(serial)}
      />
      <ErrorText>{error}</ErrorText>

      <PrimaryButton title="Show history" onPress={() => open(serial)} />

      {qrVerificationConfigured ? (
        <SecondaryButton title="Scan the label instead" onPress={() => setScanning(true)} />
      ) : (
        <Text style={styles.label}>
          Scanning is unavailable — this build has no QR verification key.
        </Text>
      )}
    </ScreenScroll>
  );
}
