import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { CreateTransferResponse, ScanRejection } from '@gct/shared';
import { getStore, type OutboxRecord } from '../../src/db';
import { useSync } from '../../src/sync/SyncContext';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import {
  Card,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';
import { colors } from '../../src/ui/theme';

interface RejectionEnvelope {
  status: number;
  code: string;
  message: string;
  details?: { rejected?: ScanRejection[] };
}

export default function TransferResult() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { sync, syncing, online } = useSync();
  const { reset } = useScanFlow();

  const [row, setRow] = useState<OutboxRecord | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    const store = await getStore();
    setRow(await store.getOutbox(id));
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, syncing]);

  const done = () => {
    router.replace('/');
    reset();
  };

  if (loading)
    return (
      <ScreenScroll>
        <ActivityIndicator />
      </ScreenScroll>
    );
  if (!row) {
    return (
      <ScreenScroll>
        <Text>This transfer is no longer in the queue.</Text>
        <PrimaryButton title="Back to dashboard" onPress={done} />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      {row.status === 'done' ? <Accepted result={row.result} /> : null}
      {row.status === 'pending' ? (
        <Queued row={row} online={online} onRetry={() => void sync()} busy={syncing} />
      ) : null}
      {row.status === 'rejected' ? <Refused result={row.result} /> : null}

      <PrimaryButton title="Back to dashboard" onPress={done} />
    </ScreenScroll>
  );
}

function Accepted({ result }: { result: string | null }) {
  const body = result ? (JSON.parse(result) as CreateTransferResponse) : null;
  if (!body) return <Text>Transfer accepted.</Text>;

  const { transfer, rejected } = body;
  return (
    <>
      <Text style={{ fontSize: 17, fontWeight: '700' }}>
        {transfer.movedSerials.length} cylinder(s) moved
      </Text>
      <Text style={{ opacity: 0.7 }}>
        Destination: {transfer.destinationSiteName ?? 'Stores'}. The movement is recorded in the
        audit log.
      </Text>

      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {transfer.movedSerials.map((s) => (
            <Text key={s} style={chip}>
              {s}
            </Text>
          ))}
        </View>
      </Card>

      {rejected.length > 0 ? <RejectionList rejected={rejected} /> : null}
    </>
  );
}

function Queued({
  row,
  online,
  onRetry,
  busy,
}: {
  row: OutboxRecord;
  online: boolean;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <>
      <Text style={{ fontSize: 17, fontWeight: '700' }}>Queued for sync</Text>
      <Text style={{ opacity: 0.7 }}>
        {row.label}. {online ? 'Sending…' : 'Waiting for a connection.'} This is saved on the device
        and will be sent automatically — you can close the app.
      </Text>
      {row.lastError ? <Text style={styles.hint}>Last attempt: {row.lastError}</Text> : null}
      {row.attempts > 0 ? <Text style={styles.hint}>{row.attempts} attempt(s) so far.</Text> : null}
      <SecondaryButton title={busy ? 'Retrying…' : 'Retry now'} onPress={onRetry} disabled={busy} />
    </>
  );
}

function Refused({ result }: { result: string | null }) {
  const body = result ? (JSON.parse(result) as RejectionEnvelope) : null;
  const rejected = body?.details?.rejected ?? [];
  return (
    <>
      <Text style={{ fontSize: 17, fontWeight: '700', color: colors.danger }}>
        Transfer not accepted
      </Text>
      <Text style={{ opacity: 0.7 }}>
        {body?.message ?? 'The server refused this transfer.'} Nothing was moved — re-scan to see
        where these cylinders are now.
      </Text>
      {rejected.length > 0 ? <RejectionList rejected={rejected} /> : null}
    </>
  );
}

function RejectionList({ rejected }: { rejected: ScanRejection[] }) {
  return (
    <Card>
      <Text style={{ fontWeight: '700' }}>{rejected.length} scan(s) not accepted</Text>
      {rejected.map((r) => (
        <View key={`${r.serialCode}-${r.code}`} style={{ marginTop: 6 }}>
          <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.serialCode}</Text>
          <Text style={{ opacity: 0.75, fontSize: 13 }}>{r.message}</Text>
        </View>
      ))}
    </Card>
  );
}

const chip = {
  fontFamily: 'monospace' as const,
  fontSize: 12,
  paddingHorizontal: 6,
  paddingVertical: 3,
  borderRadius: 6,
  backgroundColor: colors.sunken,
};
