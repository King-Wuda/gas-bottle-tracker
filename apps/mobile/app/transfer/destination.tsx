import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import type { ProjectManagerDto } from '@gct/shared';
import { apiProjectManagers } from '../../src/api/client';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { useSync } from '../../src/sync/SyncContext';
import {
  Card,
  ErrorText,
  Notice,
  PrimaryButton,
  ScreenScroll,
  styles,
} from '../../src/ui/components';
import { Select } from '../../src/ui/controls';
import { colors } from '../../src/ui/theme';

type Choice = { kind: 'site'; id: string; name: string } | { kind: 'stores' };

/** Workflow B4 — New Site or Back to Stores, then B5, the sync. */
export default function Destination() {
  const router = useRouter();
  const { batch, scans, overrides, sites, photo, photoOverride } = useScanFlow();
  const { online } = useSync();

  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Who the batch is handed to. Prefilled with whoever holds it now, so leaving this
  // alone is the normal case and changing it is a deliberate act.
  const [managers, setManagers] = useState<ProjectManagerDto[]>([]);
  const [managerId, setManagerId] = useState<string | null>(batch?.projectManagerId ?? null);

  useEffect(() => {
    // Best effort, and deliberately not blocking: this screen must still submit a
    // transfer with no signal, and the manager list is the one part of it that needs
    // the network. With no list, the batch simply keeps the manager it has.
    apiProjectManagers()
      .then((r) => setManagers(r.projectManagers))
      .catch(() => setManagers([]));
  }, []);

  if (!batch || scans.length + overrides.length === 0) return <Redirect href="/transfer" />;
  // The photo step sets one of these two. Arriving here without either means the flow
  // was deep-linked past it, and the server would refuse the submission anyway — so
  // send the operator back to take it rather than letting them pick a destination for
  // a transfer that cannot be accepted.
  if (!photo && !photoOverride) return <Redirect href="/transfer/photo" />;

  const selectedCount = scans.length + overrides.length;

  // A cylinder cannot be transferred to where it already is, so the batch's own
  // site is still offered — some of the scanned cylinders may have moved away from
  // it — but the server rejects any individual no-op per serial.
  const destinations: Choice[] = [
    ...sites.map((s) => ({ kind: 'site' as const, id: s.id, name: s.name })),
    { kind: 'stores' as const },
  ];

  /** The manager the batch already has is not "deactivated" just because it is missing
   *  from the active list — it may simply not have loaded. Only offer a handover when
   *  there is a list to choose from. */
  const managerChanged = !!managerId && managerId !== batch.projectManagerId;
  const currentManagerListed = managers.some((m) => m.id === batch.projectManagerId);
  const mustReassign = managers.length > 0 && !currentManagerListed;

  /**
   * Hand off to the sign-off step rather than submitting here.
   *
   * The destination is the last thing the OPERATOR decides; the driver's details are
   * the last thing the DRIVER provides, and they happen at the gate with the phone
   * changing hands. Keeping them as two screens keeps the submission at the end of
   * the second one, where the signature is — a transfer that submitted here would
   * have to be amended afterwards to attach the person who took the cylinders.
   */
  const toSignOff = () => {
    if (!choice) return;
    if (mustReassign && !managerChanged) {
      setError(
        `${batch.projectManagerName} has been deactivated and can no longer receive this ` +
          `batch's paperwork. Choose a project manager to hand it to.`,
      );
      return;
    }
    setError(null);
    // Carried as params rather than on the scan flow: they are this screen's answer
    // and nothing before it needs them, so widening the shared context that three
    // flows use would be paying for one screen's convenience everywhere.
    router.push({
      pathname: '/transfer/sign',
      params: {
        destination: choice.kind === 'site' ? 'SITE' : 'STORES',
        ...(choice.kind === 'site' ? { siteId: choice.id, siteName: choice.name } : {}),
        ...(managerChanged ? { projectManagerId: managerId! } : {}),
      },
    });
  };

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        Move {selectedCount} cylinder(s) from {batch.projectNumber}
      </Text>
      {overrides.length > 0 ? (
        <Notice tone="warning" title={`${overrides.length} were not scanned`}>
          They will be recorded as an admin override on the audit trail.
        </Notice>
      ) : null}
      {photoOverride ? (
        <Notice tone="warning" title="No photo of the batch">
          This transfer will be recorded as an admin camera override.
        </Notice>
      ) : null}
      {!online ? (
        <Notice tone="neutral" title="Offline">
          Offline — this transfer will be queued and sent automatically when signal returns.
        </Notice>
      ) : null}

      {destinations.map((d) => {
        const selected =
          d.kind === 'stores'
            ? choice?.kind === 'stores'
            : choice?.kind === 'site' && choice.id === d.id;
        return (
          <Card key={d.kind === 'site' ? d.id : 'stores'} onPress={() => setChoice(d)}>
            <Text style={{ fontWeight: '700', color: selected ? colors.brand : undefined }}>
              {selected ? '● ' : '○ '}
              {d.kind === 'site' ? d.name : 'Back to Stores'}
            </Text>
            <Text style={{ opacity: 0.7 }}>
              {d.kind === 'site'
                ? sites.find((s) => s.id === d.id)?.location
                : 'Cylinders return to the depot and leave every site.'}
            </Text>
          </Card>
        );
      })}

      {/* Handing the batch over. A batch outlives the manager who booked it in, and a
          move is the natural moment for it to change hands — so the same picker the
          creation flow uses is offered here, prefilled with whoever holds it now. */}
      {managers.length > 0 ? (
        <Card>
          <Select
            label="Project manager"
            placeholder="Choose a project manager"
            value={managerId}
            onChange={setManagerId}
            options={managers.map((m) => ({ value: m.id, label: m.name, hint: m.email }))}
          />
          <Text style={styles.hint}>
            {mustReassign
              ? `${batch.projectManagerName} has been deactivated — choose who takes this batch on.`
              : managerChanged
                ? 'This transfer will hand the batch over. Future paperwork goes to the new manager.'
                : `Currently ${batch.projectManagerName}. Leave as is unless the batch is changing hands.`}
          </Text>
        </Card>
      ) : null}

      <ErrorText>{error}</ErrorText>

      <View style={{ marginTop: 8 }}>
        <PrimaryButton
          title={choice ? 'Driver sign-off' : 'Choose a destination'}
          onPress={toSignOff}
          disabled={!choice}
        />
      </View>
    </ScreenScroll>
  );
}
