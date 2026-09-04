import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { CylinderHistoryResponse, MovementEventDto } from '@gct/shared';
import { ApiError, apiCylinderHistory } from '../../src/api/client';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  ScreenScroll,
  styles,
} from '../../src/ui/components';
import { colors } from '../../src/ui/theme';

/**
 * One cylinder's chain, oldest hop first — the evidence the narrative's mandatory
 * scanning exists to produce. Read straight from the server: an audit trail served
 * from the device's own cache would be worth nothing as evidence.
 */

const TYPE_LABEL: Record<MovementEventDto['type'], string> = {
  INTAKE: 'Logged in',
  // "Scanned in", not "Initialized": from this cylinder's point of view the event is
  // that somebody read its label back off it, which moved it nowhere.
  INITIALIZE: 'Scanned in',
  TRANSFER: 'Transferred',
  RETURN: 'Returned',
};

const stamp = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Hours between capture and sync — worth showing, since offline work backdates. */
const syncLag = (e: MovementEventDto): string | null => {
  const gapMs = new Date(e.serverAt).getTime() - new Date(e.deviceAt).getTime();
  if (gapMs < 5 * 60_000) return null;
  const hours = Math.round(gapMs / 3_600_000);
  return hours >= 1 ? `synced ${hours}h later` : `synced ${Math.round(gapMs / 60_000)}m later`;
};

export default function CylinderHistory() {
  const { serial } = useLocalSearchParams<{ serial: string }>();
  const [data, setData] = useState<CylinderHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!serial) return;
    setLoading(true);
    setError(null);
    try {
      setData(await apiCylinderHistory(serial));
    } catch (err) {
      setData(null);
      setError(
        err instanceof ApiError && err.status === 404
          ? `No cylinder with serial ${serial}. Check the code and try again.`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setLoading(false);
    }
  }, [serial]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ScreenScroll>
      <Stack.Screen options={{ title: serial ?? 'History' }} />

      {loading ? <LoadingState label={`Loading ${serial ?? 'history'}…`} /> : null}

      {!loading && error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {!loading && data ? (
        <>
          <Card>
            <Text style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: '700' }}>
              {data.cylinder.serialCode}
            </Text>
            <Text style={{ fontSize: 15 }}>Now at: {data.cylinder.currentLocation}</Text>
            <Text style={styles.hint}>
              {data.batch.contents} · project {data.batch.projectNumber}
            </Text>
          </Card>

          {data.events.length === 0 ? (
            // Not reachable today — intake always writes one event — but a cylinder
            // with no history must read as "nothing recorded", never as a blank screen.
            <EmptyState
              title="No movements recorded"
              hint="This cylinder has no entries in the movement log."
            />
          ) : (
            <>
              <Text style={{ fontSize: 17, fontWeight: '700', marginTop: 4 }}>
                {data.events.length} movement(s)
              </Text>
              {data.events.map((e, i) => (
                <Hop key={e.id} event={e} index={i} last={i === data.events.length - 1} />
              ))}
            </>
          )}
        </>
      ) : null}
    </ScreenScroll>
  );
}

function Hop({ event, index, last }: { event: MovementEventDto; index: number; last: boolean }) {
  const lag = syncLag(event);
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View style={{ alignItems: 'center', width: 14 }}>
        <View style={[dot, last && dotLast]} />
        {!last ? <View style={line} /> : null}
      </View>

      <View style={{ flex: 1, paddingBottom: 18 }}>
        <Text style={{ fontWeight: '600' }}>
          {index + 1}. {TYPE_LABEL[event.type]}
        </Text>
        <Text style={{ fontSize: 15 }}>
          {event.type === 'INTAKE' ? event.toName : `${event.fromName} → ${event.toName}`}
        </Text>
        <Text style={styles.hint}>
          {stamp(event.deviceAt)} · {event.userName}
          {lag ? ` · ${lag}` : ''}
        </Text>
      </View>
    </View>
  );
}

const dot = {
  width: 10,
  height: 10,
  borderRadius: 5,
  marginTop: 5,
  backgroundColor: colors.brand,
};
const dotLast = { backgroundColor: colors.success };
const line = { flex: 1, width: 2, backgroundColor: colors.border, marginTop: 2 };
