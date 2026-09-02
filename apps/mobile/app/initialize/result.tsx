import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { CreateInitializationResponse, ScanRejection } from '@gct/shared';
import { getStore, type OutboxRecord } from '../../src/db';
import { useScanFlow } from '../../src/scanning/ScanFlowContext';
import { useSync } from '../../src/sync/SyncContext';
import {
  Card,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';

interface RejectionEnvelope {
  status: number;
  code: string;
  message: string;
  details?: { rejected?: ScanRejection[]; missingSerials?: string[] };
}

export default function InitializeResult() {
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
        <Text>This initialization is no longer in the queue.</Text>
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
  const body = result ? (JSON.parse(result) as CreateInitializationResponse) : null;
  if (!body) return <Text>Initialization accepted.</Text>;

  const { initialization } = body;
  return (
    <>
      <Text style={{ fontSize: 17, fontWeight: '700' }}>
        {initialization.initializedSerials.length} cylinder(s) scanned in
      </Text>
      <Text style={{ opacity: 0.7 }}>
        This batch can now be transferred and returned. The scan, and the photo that went with it,
        are on the audit trail.
      </Text>

      {initialization.photoOverridden ? (
        <Text style={{ color: '#b8860b', fontWeight: '600' }}>
          Recorded without a photo, by admin override.
        </Text>
      ) : null}
      {initialization.overriddenSerials.length > 0 ? (
        <Text style={{ color: '#b8860b', fontWeight: '600' }}>
          {initialization.overriddenSerials.length} cylinder(s) were selected without a scan and are
          recorded as an override.
        </Text>
      ) : null}

      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {initialization.initializedSerials.map((s) => (
            <Text key={s} style={chip}>
              {s}
            </Text>
          ))}
        </View>
      </Card>
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
        — photo included — and will be sent automatically. You can close the app.
      </Text>
      {row.lastError ? <Text style={styles.label}>Last attempt: {row.lastError}</Text> : null}
      {row.attempts > 0 ? (
        <Text style={styles.label}>{row.attempts} attempt(s) so far.</Text>
      ) : null}
      <SecondaryButton title={busy ? 'Retrying…' : 'Retry now'} onPress={onRetry} disabled={busy} />
    </>
  );
}

function Refused({ result }: { result: string | null }) {
  const body = result ? (JSON.parse(result) as RejectionEnvelope) : null;
  const missing = body?.details?.missingSerials ?? [];
  const rejected = body?.details?.rejected ?? [];

  return (
    <>
      <Text style={{ fontSize: 17, fontWeight: '700', color: '#c0392b' }}>
        Initialization not accepted
      </Text>
      <Text style={{ opacity: 0.7 }}>
        {body?.message ?? 'The server refused this initialization.'} Nothing was recorded — the
        batch is still waiting to be scanned in.
      </Text>

      {missing.length > 0 ? (
        <Card>
          <Text style={{ fontWeight: '700' }}>{missing.length} cylinder(s) were not scanned</Text>
          <Text style={styles.label}>
            Initialization has to cover the whole batch. Go back and scan these, then submit again.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {missing.map((s) => (
              <Text key={s} style={chip}>
                {s}
              </Text>
            ))}
          </View>
        </Card>
      ) : null}

      {rejected.length > 0 ? (
        <Card>
          <Text style={{ fontWeight: '700' }}>{rejected.length} scan(s) not accepted</Text>
          {rejected.map((r) => (
            <View key={`${r.serialCode}-${r.code}`} style={{ marginTop: 6 }}>
              <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.serialCode}</Text>
              <Text style={{ opacity: 0.75, fontSize: 13 }}>{r.message}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );
}

const chip = {
  fontFamily: 'monospace' as const,
  fontSize: 12,
  paddingHorizontal: 6,
  paddingVertical: 3,
  borderRadius: 6,
  backgroundColor: 'rgba(127,127,127,0.15)',
};
