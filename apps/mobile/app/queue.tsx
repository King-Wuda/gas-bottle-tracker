import { useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import type { ScanRejection } from '@gct/shared';
import type { OutboxRecord } from '../src/db';
import { useSync } from '../src/sync/SyncContext';
import {
  Card,
  EmptyState,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../src/ui/components';

/**
 * M5 — the sync queue, as a screen you can act on.
 *
 * Until now a refused submission was only visible on the result screen of the flow
 * that created it: navigate away and the work was unreachable, sitting in SQLite with
 * nothing to surface it. The dashboard banner counted those rows but could not open
 * them. This is where a technician sees everything the device is still holding and
 * decides, per row, to resend or to drop it.
 */

interface RefusalEnvelope {
  status: number;
  code: string;
  message: string;
  details?: { rejected?: ScanRejection[] };
}

const KIND_LABEL: Record<OutboxRecord['kind'], string> = {
  transfer: 'Transfer',
  return: 'Return',
  initialize: 'Initialization',
};

const parseRefusal = (result: string | null): RefusalEnvelope | null => {
  if (!result) return null;
  try {
    return JSON.parse(result) as RefusalEnvelope;
  } catch {
    // A row whose stored body is not JSON must still be actionable, not a crash.
    return null;
  }
};

const when = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * `Alert` is a no-op on react-native-web, so a web demo would silently do nothing on
 * Discard. Fall back to the browser's own confirm there.
 */
function confirmDiscard(label: string, onConfirm: () => void): void {
  if (Platform.OS === 'web') {
    if (typeof confirm === 'function' && confirm(`Discard "${label}"? This cannot be undone.`)) {
      onConfirm();
    }
    return;
  }
  Alert.alert('Discard this submission?', `${label}\n\nThis cannot be undone.`, [
    { text: 'Keep', style: 'cancel' },
    { text: 'Discard', style: 'destructive', onPress: onConfirm },
  ]);
}

export default function QueueScreen() {
  const { pending, rejected, online, syncing, sync, retry, discard } = useSync();
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (id: string, fn: (id: string) => Promise<void>): Promise<void> => {
    setBusyId(id);
    try {
      await fn(id);
    } finally {
      setBusyId(null);
    }
  };

  const total = pending.length + rejected.length;

  return (
    <ScreenScroll>
      <Stack.Screen options={{ title: 'Sync queue' }} />

      {total === 0 ? (
        <EmptyState
          title="Everything is synced"
          hint={
            online
              ? 'Nothing is waiting on this device. Transfers and returns you complete will appear here until the server accepts them.'
              : "You're offline, but there is nothing queued."
          }
        />
      ) : (
        <>
          <Text style={styles.label}>
            {online ? 'Online' : 'Offline'} · {pending.length} waiting · {rejected.length} need
            attention
          </Text>

          {pending.length > 0 ? (
            <>
              <Text style={heading}>Waiting to sync</Text>
              <Text style={styles.label}>
                Saved on this device. These send themselves — you can close the app.
              </Text>
              {pending.map((row) => (
                <PendingRow key={row.id} row={row} />
              ))}
              <SecondaryButton
                title={syncing ? 'Syncing…' : 'Sync now'}
                onPress={() => void sync()}
                disabled={syncing || !online}
              />
            </>
          ) : null}

          {rejected.length > 0 ? (
            <>
              <Text style={heading}>Needs attention</Text>
              <Text style={styles.label}>
                The server refused these. Retrying sends the same submission again under its
                original reference, so a resend can never create a duplicate.
              </Text>
              {rejected.map((row) => (
                <RejectedRow
                  key={row.id}
                  row={row}
                  busy={busyId === row.id}
                  onRetry={() => void act(row.id, retry)}
                  onDiscard={() => confirmDiscard(row.label, () => void act(row.id, discard))}
                />
              ))}
            </>
          ) : null}
        </>
      )}
    </ScreenScroll>
  );
}

function PendingRow({ row }: { row: OutboxRecord }) {
  const waiting = row.nextAttemptAt > Date.now();
  return (
    <Card>
      <Text style={rowTitle}>
        {KIND_LABEL[row.kind]} · {row.label}
      </Text>
      <Text style={styles.label}>Captured {when(row.createdAt)}</Text>
      {row.attempts > 0 ? (
        <Text style={styles.label}>
          {row.attempts} failed attempt(s)
          {waiting ? ` · next try ${when(row.nextAttemptAt)}` : ''}
        </Text>
      ) : null}
      {row.lastError ? <Text style={styles.error}>{row.lastError}</Text> : null}
    </Card>
  );
}

function RejectedRow({
  row,
  busy,
  onRetry,
  onDiscard,
}: {
  row: OutboxRecord;
  busy: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const refusal = parseRefusal(row.result);
  const perScan = refusal?.details?.rejected ?? [];

  return (
    <Card>
      <Text style={rowTitle}>
        {KIND_LABEL[row.kind]} · {row.label}
      </Text>
      <Text style={styles.label}>Captured {when(row.createdAt)}</Text>
      <Text style={styles.error}>
        {refusal ? `${refusal.code}: ${refusal.message}` : 'The server refused this submission.'}
      </Text>

      {perScan.length > 0 ? (
        <View style={{ gap: 4, marginTop: 4 }}>
          <Text style={styles.label}>{perScan.length} cylinder(s) rejected</Text>
          {perScan.map((r) => (
            <Text key={`${r.serialCode}-${r.code}`} style={{ fontSize: 13, opacity: 0.8 }}>
              <Text style={{ fontFamily: 'monospace' }}>{r.serialCode}</Text> — {r.message}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={{ gap: 8, marginTop: 10 }}>
        <PrimaryButton title="Retry" onPress={onRetry} busy={busy} />
        <SecondaryButton title="Discard" onPress={onDiscard} disabled={busy} />
      </View>
    </Card>
  );
}

const heading = { fontSize: 17, fontWeight: '700' as const, marginTop: 8 };
const rowTitle = { fontSize: 15, fontWeight: '600' as const };
