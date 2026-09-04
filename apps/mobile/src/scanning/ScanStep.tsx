import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack, useRouter, type Href } from 'expo-router';
import { useScanFlow } from './ScanFlowContext';
import { useAuth } from '../auth/AuthContext';
import { verifyScannedCode, qrVerificationConfigured } from '../qr/verify';
import { Scanner, type ScanOutcome } from '../components/Scanner';
import { HeaderLogo } from '../ui/GeaLogo';
import { RocketFlyby } from '../ui/RocketFlyby';
import { ErrorText, Notice, PrimaryButton, ScreenScroll } from '../ui/components';
import { CheckIcon } from '../ui/icons';
import { colors, radius, space, type } from '../ui/theme';

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
  /** The flyby plays over this screen and navigation waits for it, so that leaving
   *  the scan step is the thing being celebrated rather than an animation the next
   *  screen cuts off half a second in. */
  const [flyby, setFlyby] = useState(false);

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
    <View style={step.checklist}>
      {/* A progress bar, because "17 of 40" is a number you have to read and a bar is
          something you can see from arm's length with a cylinder in the other hand. */}
      <View style={step.progressHead}>
        <Text style={step.progressCount}>
          {selectedCount} <Text style={step.progressTotal}>of {cylinders.length} selected</Text>
        </Text>
        {overridden.size > 0 ? (
          <Text style={step.progressOverride}>{overridden.size} without a scan</Text>
        ) : null}
        {/* Only when everything here was genuinely scanned. A tick beside a set of
            overrides would say "proved" about the one case that is not, which is the
            distinction this whole screen exists to keep. */}
        {complete && selectedCount > 0 && overridden.size === 0 ? <CheckIcon size={20} /> : null}
      </View>
      <View style={step.progressTrack}>
        <View
          style={[
            step.progressFill,
            {
              width: `${cylinders.length ? (selectedCount / cylinders.length) * 100 : 0}%`,
              // Amber while any of the progress is asserted rather than scanned, so
              // the bar never reads as "all proved" when part of it was waved through.
              backgroundColor: overridden.size > 0 ? colors.warning : colors.success,
            },
          ]}
        />
      </View>

      <View style={step.chips}>
        {cylinders.map((c) => {
          const isScanned = scanned.has(c.serialCode);
          const isOverridden = overridden.has(c.serialCode);
          const selected = isScanned || isOverridden;
          return (
            <Pressable
              key={c.serialCode}
              role="button"
              aria-label={`${c.serialCode}${selected ? ', selected — tap to remove' : ', not scanned'}`}
              onPress={() => selected && deselect(c.serialCode)}
              style={[
                step.chip,
                // Green = physically scanned. Amber = an admin's assertion. The
                // distinction is the whole point of the override, so the screen must
                // not blur it into one "selected" colour.
                isScanned ? step.chipScanned : isOverridden ? step.chipOverridden : step.chipIdle,
              ]}
            >
              <Text style={[step.chipText, selected && step.chipTextOn]}>
                {c.serialCode}
                {c.gasTypeName ? ` · ${c.gasTypeName}` : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={step.hint}>
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
            // Replaces the shared header from `ui/chrome`, so the logo is re-rendered
            // here rather than silently dropped on the one screen an operator spends
            // the longest on.
            headerRight: () => (
              <View style={step.headerRight}>
                <Pressable role="button" onPress={overrideAll} hitSlop={12}>
                  <Text style={step.overrideAction}>Override scan</Text>
                </Pressable>
                <HeaderLogo />
              </View>
            ),
          }}
        />
      ) : null}

      <View>
        <Text style={type.title}>{batch.projectNumber}</Text>
        <Text style={step.contents}>{batch.contents}</Text>
      </View>

      {isAdmin ? (
        <Notice tone="warning" title="Admin override available">
          &quot;Override scan&quot; selects every cylinder without scanning. Tap any you are not
          moving to remove it. Overrides are recorded as unscanned on the audit trail.
        </Notice>
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
        <Text style={step.rule}>
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
        onPress={() => setFlyby(true)}
        disabled={selectedCount === 0 || !complete || flyby}
      />
      {selectedCount > 0 ? (
        <Pressable role="button" onPress={clearScans} style={step.clear}>
          <Text style={step.clearText}>Clear all selections</Text>
        </Pressable>
      ) : null}

      {/* The scanning is done. `onDone` fires whether the flight finished or the
          screen went away underneath it, so the flow cannot get stuck behind it. */}
      <RocketFlyby playing={flyby} onDone={() => router.push(next)} />
    </ScreenScroll>
  );
}

const step = StyleSheet.create({
  contents: { ...type.caption, fontSize: 14, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  overrideAction: { color: colors.warning, fontSize: 15, fontWeight: '700' },

  checklist: { gap: space.md },
  progressHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  progressCount: { fontSize: 17, fontWeight: '800', color: colors.ink },
  progressTotal: { fontSize: 14, fontWeight: '600', color: colors.inkMuted },
  progressOverride: {
    marginLeft: 'auto',
    fontSize: 12,
    fontWeight: '700',
    color: colors.warning,
  },
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.sunken,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: radius.pill },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm - 2 },
  chip: {
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  chipIdle: { backgroundColor: colors.sunken, borderColor: colors.border },
  chipScanned: { backgroundColor: colors.success, borderColor: colors.success },
  chipOverridden: { backgroundColor: colors.warning, borderColor: colors.warning },
  chipText: { fontFamily: 'monospace', fontSize: 12, color: colors.inkMuted },
  chipTextOn: { color: colors.onBrand, fontWeight: '700' },

  hint: type.caption,
  rule: { ...type.caption, fontStyle: 'italic' },
  clear: { paddingVertical: space.md },
  clearText: { color: colors.danger, fontWeight: '700', textAlign: 'center', fontSize: 14 },
});
