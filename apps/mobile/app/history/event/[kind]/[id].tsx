import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  BATCH_EVENT_LABELS,
  formatBatchDate,
  type BatchEventDetail,
  type BatchEventKind,
  type BatchPhotoDto,
} from '@gct/shared';
import { ApiError, apiBatchPhoto, apiHistoryEvent } from '../../../../src/api/client';
import {
  Card,
  ErrorState,
  LoadingState,
  ScreenScroll,
  SecondaryButton,
  styles as base,
} from '../../../../src/ui/components';
import { colors } from '../../../../src/ui/theme';

/**
 * One change, in full — read-only, like everything reached from History.
 *
 * The serials and the photo live here rather than on the feed row because a batch can
 * hold 500 cylinders: carrying every serial of every event into the list would be
 * megabytes to render rows most of which nobody scrolls to.
 */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'space-between' }}>
      <Text style={[base.hint, { flexShrink: 0 }]}>{label}</Text>
      <Text style={{ flexShrink: 1, textAlign: 'right' }}>{value}</Text>
    </View>
  );
}

export default function EventDetail() {
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  const router = useRouter();

  const [event, setEvent] = useState<BatchEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!kind || !id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiHistoryEvent(kind, id);
      setEvent(res.event);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this event.');
    } finally {
      setLoading(false);
    }
  }, [kind, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !event) return <LoadingState label="Loading event…" />;
  if (error && !event) {
    return (
      <ScreenScroll>
        <ErrorState message={error} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }
  if (!event) return null;

  return (
    <ScreenScroll>
      <Text style={styles.kind}>
        {BATCH_EVENT_LABELS[event.kind as BatchEventKind]?.toUpperCase() ?? event.kind}
      </Text>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>{event.headline}</Text>
      <Text style={{ opacity: 0.75 }}>{event.detail}</Text>

      <Card>
        <Row label="When" value={formatBatchDate(event.at)} />
        <Row label="By" value={event.userName} />
        <Row label="Project" value={event.projectNumber} />
        <Row label="Site" value={event.siteName} />
        <Row label="Batch holds" value={event.contents} />
        {event.destinationName ? <Row label="Destination" value={event.destinationName} /> : null}
        {event.driverName ? <Row label="Collected by" value={event.driverName} /> : null}
        {event.driverIdNumber ? <Row label="Driver ID" value={event.driverIdNumber} /> : null}
      </Card>

      {event.photo ? (
        <PhotoCard photo={event.photo} />
      ) : event.photoOverridden ? (
        <Card>
          <Text style={{ fontWeight: '700', color: colors.warning }}>
            No photo — admin override
          </Text>
          <Text style={base.hint}>
            An admin recorded this without a photo. That is a named person&apos;s assertion, not
            evidence that the batch was seen — which is exactly why it is shown as its own thing
            rather than left blank.
          </Text>
        </Card>
      ) : null}

      {event.changes.length > 0 ? (
        <Card>
          <Text style={{ fontWeight: '700' }}>What was corrected</Text>
          <View style={{ gap: 6, marginTop: 6 }}>
            {event.changes.map((c, i) => (
              <View key={`${c.field}-${i}`}>
                <Text style={base.hint}>{c.field}</Text>
                <Text>
                  {c.from ?? '—'} → {c.to ?? '—'}
                </Text>
              </View>
            ))}
          </View>
          {event.reason ? (
            <Text style={[base.hint, { marginTop: 8 }]}>Reason given: {event.reason}</Text>
          ) : null}
        </Card>
      ) : null}

      {event.serials.length > 0 ? (
        <Card>
          <Text style={{ fontWeight: '700' }}>
            {event.serials.length} cylinder{event.serials.length === 1 ? '' : 's'}
            {event.overriddenSerials.length > 0
              ? ` · ${event.overriddenSerials.length} without a scan`
              : ''}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {event.serials.map((s) => {
              const unscanned = event.overriddenSerials.includes(s);
              return (
                <Text
                  key={s}
                  onPress={() =>
                    router.push({ pathname: '/history/[serial]', params: { serial: s } })
                  }
                  style={[styles.serial, unscanned && styles.serialUnscanned]}
                >
                  {s}
                </Text>
              );
            })}
          </View>
          <Text style={base.hint}>
            Tap a serial for its full movement history.
            {event.overriddenSerials.length > 0
              ? ' Amber cylinders were selected without a scan.'
              : ''}
          </Text>
        </Card>
      ) : null}

      <SecondaryButton
        title="Open this batch"
        onPress={() =>
          router.push({ pathname: '/history/batch/[id]', params: { id: event.batchId } })
        }
      />
      <SecondaryButton
        title="This batch's full history"
        onPress={() => router.push({ pathname: '/history', params: {} })}
      />
    </ScreenScroll>
  );
}

/**
 * The photo, fetched on demand.
 *
 * Not an `<Image>` pointing at the API: every call needs an `Authorization` header,
 * and on react-native-web an `<Image>` is a plain `<img src>` that cannot send one. So
 * the bytes come back base64 through the ordinary authenticated fetch and are rendered
 * from a data URL — which behaves identically on device and in the browser.
 */
function PhotoCard({ photo }: { photo: BatchPhotoDto }) {
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchImage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiBatchPhoto(photo.id);
      setUri(`data:${res.mimeType};base64,${res.imageBase64}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the photo.');
    } finally {
      setLoading(false);
    }
  }, [photo.id]);

  const hasFix = photo.latitude !== null && photo.longitude !== null;
  // A queued submission can sit in the outbox overnight, so the two clocks genuinely
  // differ. Surface the gap rather than picking one and implying they agree.
  const delayed = new Date(photo.serverAt).getTime() - new Date(photo.capturedAt).getTime();
  const delayedHours = Math.round(delayed / 3_600_000);

  return (
    <Card>
      <Text style={{ fontWeight: '700' }}>Photo of the batch</Text>

      {uri ? (
        <Image
          source={{ uri }}
          style={styles.photo}
          resizeMode="cover"
          accessibilityLabel="Photo taken of this batch at the time of the event"
        />
      ) : (
        <Pressable role="button" onPress={() => void fetchImage()} style={styles.photoPlaceholder}>
          {loading ? (
            <ActivityIndicator />
          ) : (
            <Text style={{ color: colors.brand, fontWeight: '600' }}>Tap to load the photo</Text>
          )}
        </Pressable>
      )}
      {error ? <Text style={base.error}>{error}</Text> : null}

      <View style={{ gap: 2, marginTop: 8 }}>
        <Row label="Taken" value={formatBatchDate(photo.capturedAt)} />
        <Row label="By" value={photo.userName} />
        <Row
          label="Location"
          value={
            hasFix
              ? `${photo.latitude!.toFixed(5)}, ${photo.longitude!.toFixed(5)}` +
                (photo.accuracyM === null ? '' : ` (±${Math.round(photo.accuracyM)} m)`)
              : (photo.locationError ?? 'Not recorded')
          }
        />
        {delayedHours >= 1 ? (
          <Text style={base.hint}>
            Reached the server {delayedHours} hour{delayedHours === 1 ? '' : 's'} after it was taken
            — it was captured offline and synced later.
          </Text>
        ) : null}
      </View>

      {!hasFix ? (
        <Text style={base.hint}>
          No position was recorded. The photo and its timestamp still stand; only the location is
          missing, and the reason is above.
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  kind: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, opacity: 0.6 },
  photo: { height: 260, borderRadius: 10, backgroundColor: '#000', marginTop: 8 },
  photoPlaceholder: {
    height: 120,
    borderRadius: 10,
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.sunken,
  },
  serial: {
    fontFamily: 'monospace',
    fontSize: 12,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: colors.sunken,
  },
  serialUnscanned: { backgroundColor: colors.warningTint },
});
