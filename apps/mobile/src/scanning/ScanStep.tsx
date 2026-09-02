import { useCallback, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Redirect, Stack, useRouter, type Href } from 'expo-router';
import { useScanFlow } from './ScanFlowContext';
import { useAuth } from '../auth/AuthContext';
import { verifyScannedCode, qrVerificationConfigured } from '../qr/verify';
import { Scanner, type ScanOutcome } from '../components/Scanner';
import { ErrorText, PrimaryButton, ScreenScroll, styles } from '../ui/components';

/**
 * The mandatory physical scan, shared by Workflow B3 and C3. The spec marks this
 * CRITICAL ENFORCEMENT, so for every ordinary user there is deliberately no way to
 * type a serial in — the only route into the submission is through the camera.
 *
 * Every check here runs against the local mirror and the QR public key, so it behaves
 * identically with no signal.
 *
 * ## The admin override
 *
 * An ADMIN gets one extra affordance: a button that selects the batch's cylinders
 * without scanning them. It exists because the camera is not always the constraint
 * that matters — a peeled label, a cylinder already on a truck, a phone that will not
 * focus in the dark. The alternative to giving admins a way past is not "everything
 * gets scanned"; it is stock quietly going untracked, which is worse.
 *
 * It is deliberately NOT a way to skip this screen. Overridden serials are held apart
 * from scanned ones all the way to the server, which records them as `overridden` on
 * the movement event and prints them as "no scan" on the delivery note. The override
 * is visible in the evidence, because an override that looked like a scan would
 * quietly devalue every real scan in the system.
 */
export function ScanStep({
  next,
  home,
  ctaLabel,
  requireAll = false,
  incompleteLabel,
}: {
  next: Href;
  home: Href;
  /** e.g. `(n) => \`Choose destination (${n})\`` */
  ctaLabel: (count: number) => string;
  /**
   * Every cylinder in the batch must be selected before the step can be completed.
   *
   * True only for initialization, which is a claim about the batch as a UNIT — "every
   * label is on" — and which the server refuses as INCOMPLETE_INITIALIZATION
   * otherwise. Transfers and returns are legitimately partial: 3 of 7 cylinders really
   * can move while 4 stay behind, so forcing a full set there would make the app
   * unable to record what actually happened.
   */
  requireAll?: boolean;
  /** Shown on the disabled CTA while `requireAll` is unmet, e.g. `(n) => `${n} left``. */
  incompleteLabel?: (remaining: number) => string;
}) {
  const router = useRouter();
  const { batch, cylinders, scans, overrides, addScan, deselect, clearScans, overrideAll } =
    useScanFlow();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const expected = useMemo(() => new Set(cylinders.map((c) => c.serialCode)), [cylinders]);
  const scanned = useMemo(() => new Set(scans.map((s) => s.serialCode)), [scans]);
  const overridden = useMemo(() => new Set(overrides), [overrides]);
  const selectedCount = scanned.size + overridden.size;
  const remaining = cylinders.length - selectedCount;
  const complete = !requireAll || remaining <= 0;

  const onScan = useCallback(
    (raw: string): ScanOutcome => {
      let verified;
      try {
        verified = verifyScannedCode(raw);
      } catch (e) {
        return { kind: 'invalid', reason: e instanceof Error ? e.message : 'Cannot verify code' };
      }

      // Rejected offline, on the spot — a photocopied or hand-made label never makes
      // it into the submission in the first place.
      if (!verified.ok) {
        return {
          kind: 'invalid',
          reason:
            verified.reason === 'signature'
              ? 'This QR code was not issued by this system.'
              : 'Not a cylinder QR code.',
        };
      }

      const { serialCode } = verified;
      if (scanned.has(serialCode)) return { kind: 'duplicate', serialCode };
      if (!expected.has(serialCode)) return { kind: 'foreign', serialCode };

      addScan({ serialCode, qrPayload: raw, scannedAt: new Date().toISOString() });
      return { kind: 'accepted', serialCode, payload: raw };
    },
    [addScan, expected, scanned],
  );

  if (!batch) return <Redirect href={home} />;

  // The override does not need a QR key — that is the point of it — so an admin can
  // still work on a build whose scanner is disabled.
  if (!qrVerificationConfigured && !isAdmin) {
    return (
      <ScreenScroll>
        <ErrorText>
          This build has no QR verification key (EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY), so scans cannot
          be trusted. Scanning is disabled.
        </ErrorText>
      </ScreenScroll>
    );
  }

  const checklist = (
    <View style={{ gap: 10 }}>
      <Text style={{ fontWeight: '700' }}>
        {selectedCount} of {cylinders.length} selected
        {overridden.size > 0 ? ` · ${overridden.size} without a scan` : ''}
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {cylinders.map((c) => {
          const isScanned = scanned.has(c.serialCode);
          const isOverridden = overridden.has(c.serialCode);
          const selected = isScanned || isOverridden;
          return (
            <Pressable
              key={c.serialCode}
              onPress={() => selected && deselect(c.serialCode)}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                // Green = physically scanned. Amber = an admin's assertion. The
                // distinction is the whole point of the override, so the screen must
                // not blur it into one "selected" colour.
                backgroundColor: isScanned
                  ? '#1e7e34'
                  : isOverridden
                    ? '#b8860b'
                    : 'rgba(127,127,127,0.15)',
              }}
            >
              <Text
                style={{
                  fontFamily: 'monospace',
                  fontSize: 12,
                  color: selected ? '#fff' : undefined,
                }}
              >
                {c.serialCode}
                {c.gasTypeName ? ` · ${c.gasTypeName}` : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.label}>
        Tap a selected serial to remove it. Only selected cylinders are submitted.
        {overridden.size > 0
          ? ' Amber cylinders were not scanned — they are recorded as an override.'
          : ''}
      </Text>
    </View>
  );

  return (
    <ScreenScroll>
      {isAdmin ? (
        <Stack.Screen
          options={{
            headerRight: () => (
              <Pressable onPress={overrideAll} hitSlop={12}>
                <Text style={{ color: '#b8860b', fontSize: 15, fontWeight: '700' }}>
                  Override scan
                </Text>
              </Pressable>
            ),
          }}
        />
      ) : null}

      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        {batch.projectNumber} · {batch.contents}
      </Text>

      {isAdmin ? (
        <Text style={styles.label}>
          Admin: &quot;Override scan&quot; selects every cylinder without scanning. Tap any you are
          not moving to remove it. Overrides are recorded as unscanned on the audit trail.
        </Text>
      ) : null}

      {qrVerificationConfigured ? (
        <Scanner onScan={onScan} footer={checklist} />
      ) : (
        // Admin-only path: no QR key in this build, so there is no camera step to
        // offer — only the override list.
        <View style={{ gap: 10 }}>
          <ErrorText>
            This build has no QR verification key, so the camera is disabled. Only the admin
            override is available.
          </ErrorText>
          {checklist}
        </View>
      )}

      {requireAll ? (
        <Text style={styles.label}>
          Every cylinder in this batch has to be scanned before it can be initialized — that is what
          &quot;the labels are all on&quot; means. A partial scan is refused.
        </Text>
      ) : null}

      <PrimaryButton
        title={
          selectedCount === 0
            ? 'Select at least one cylinder'
            : complete
              ? ctaLabel(selectedCount)
              : (incompleteLabel?.(remaining) ?? `${remaining} still to scan`)
        }
        onPress={() => router.push(next)}
        disabled={selectedCount === 0 || !complete}
      />
      {selectedCount > 0 ? (
        <Pressable onPress={clearScans} style={{ paddingVertical: 10 }}>
          <Text style={{ color: '#c0392b', fontWeight: '600', textAlign: 'center' }}>
            Clear all selections
          </Text>
        </Pressable>
      ) : null}
    </ScreenScroll>
  );
}
