import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import type { CreateTransferRequest, ProjectManagerDto } from '@gct/shared';
import { apiProjectManagers } from '../../src/api/client';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { playCue } from '../../src/sound';
import { useSync } from '../../src/sync/SyncContext';
import { enqueueMutation } from '../../src/sync/worker';
import { Card, ErrorText, PrimaryButton, ScreenScroll, styles } from '../../src/ui/components';
import { Select } from '../../src/ui/controls';

type Choice = { kind: 'site'; id: string; name: string } | { kind: 'stores' };

/** Workflow B4 — New Site or Back to Stores, then B5, the sync. */
export default function Destination() {
  const router = useRouter();
  const { batch, scans, overrides, sites, photo, photoOverride } = useScanFlow();
  const { sync, online } = useSync();

  const [choice, setChoice] = useState<Choice | null>(null);
  const [submitting, setSubmitting] = useState(false);
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

  const submit = async () => {
    if (!choice) return;
    if (mustReassign && !managerChanged) {
      setError(
        `${batch.projectManagerName} has been deactivated and can no longer receive this ` +
          `batch's paperwork. Choose a project manager to hand it to.`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    // The submit cue: a struck steel cylinder. It fires on the press rather than on
    // the server's reply, because it is confirming the TAP — and the reply may not
    // come for hours, this being a submission that is durable in the outbox first
    // and sent over the wire second.
    playCue('clang');
    try {
      // The idempotency key is minted HERE, once, as the intent is formed — and it
      // becomes the outbox row's id. Every retry, now or after three days in a dead
      // spot, replays this same key, so the server can recognise it as one transfer.
      const clientRequestId = Crypto.randomUUID();
      const body: CreateTransferRequest = {
        batchId: batch.id,
        clientRequestId,
        destination:
          choice.kind === 'site' ? { type: 'SITE', siteId: choice.id } : { type: 'STORES' },
        scans: scans.map((s) => ({
          serialCode: s.serialCode,
          qrPayload: s.qrPayload,
          scannedAt: s.scannedAt,
        })),
        // Kept separate from `scans` the whole way, so the server can record which
        // cylinders were actually seen and which were asserted.
        overrideSerials: overrides,
        // Held on the flow since the photo step, so choosing a destination — which can
        // take a while with the manager list loading — never costs a retake.
        photo,
        photoOverride,
        ...(managerChanged ? { projectManagerId: managerId! } : {}),
      };

      // Outbox first, network second: if the app dies between these two lines the
      // work is already durable, and if the POST never happens the sync worker
      // picks it up later.
      await enqueueMutation({
        id: clientRequestId,
        kind: 'transfer',
        path: '/transfers',
        body,
        label: `${selectedCount} cylinder(s) → ${choice.kind === 'site' ? choice.name : 'Stores'}`,
      });
      await sync();
      router.replace({ pathname: '/transfer/result', params: { id: clientRequestId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not queue this transfer.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>
        Move {selectedCount} cylinder(s) from {batch.projectNumber}
      </Text>
      {overrides.length > 0 ? (
        <Text style={{ color: '#b8860b', fontWeight: '600' }}>
          {overrides.length} of these were not scanned — they will be recorded as an admin override.
        </Text>
      ) : null}
      {photoOverride ? (
        <Text style={{ color: '#b8860b', fontWeight: '600' }}>
          No photo was taken — this transfer will be recorded as an admin camera override.
        </Text>
      ) : null}
      {!online ? (
        <Text style={styles.label}>
          Offline — this transfer will be queued and sent automatically when signal returns.
        </Text>
      ) : null}

      {destinations.map((d) => {
        const selected =
          d.kind === 'stores'
            ? choice?.kind === 'stores'
            : choice?.kind === 'site' && choice.id === d.id;
        return (
          <Card key={d.kind === 'site' ? d.id : 'stores'} onPress={() => setChoice(d)}>
            <Text style={{ fontWeight: '700', color: selected ? '#1f6feb' : undefined }}>
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
          <Text style={styles.label}>
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
          title={choice ? 'Submit transfer' : 'Choose a destination'}
          onPress={submit}
          disabled={!choice}
          busy={submitting}
        />
      </View>
    </ScreenScroll>
  );
}
