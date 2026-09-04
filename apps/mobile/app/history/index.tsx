import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  BATCH_EVENT_LABELS,
  formatBatchDate,
  type BatchEventKind,
  type BatchEventSummary,
} from '@gct/shared';
import { ApiError, apiHistoryFeed } from '../../src/api/client';
import {
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  ScreenScroll,
  SecondaryButton,
  styles as base,
} from '../../src/ui/components';
import { colors } from '../../src/ui/theme';

/**
 * Section 10 — History.
 *
 * ## What changed, and why
 *
 * This used to be the batch list with nothing hidden — the same component Transfer and
 * Returns use, pointed at every batch. That made it a fourth picker rather than a
 * record: a batch that was created, initialized, transferred twice and half-returned
 * showed up as ONE row saying where it currently is, which is the one question the
 * other three tabs already answer.
 *
 * History is now a feed of **events**. Every change a batch undergoes — created,
 * initialized, transferred, returned, corrected by an admin — is its own row, newest
 * first, and tapping one shows exactly what that change consisted of.
 *
 * ## Read-only, and not by convention
 *
 * There is nothing to tap here that changes anything, because there is no endpoint
 * behind this screen that could: `GET /history` and `GET /history/events/...` are the
 * whole surface. Corrections live in the admin console, and each one writes an
 * amendment that appears here as an `AMENDED` row — so the section that exists to say
 * what happened is not also the place a change could hide.
 */

const KINDS: BatchEventKind[] = ['CREATED', 'INITIALIZED', 'TRANSFER', 'RETURN', 'AMENDED'];

/** The left-hand rail colour, so a kind is recognisable before the text is read. */
const KIND_COLOUR: Record<BatchEventKind, string> = {
  CREATED: colors.brand,
  INITIALIZED: colors.success,
  TRANSFER: colors.warning,
  RETURN: colors.brandLight,
  AMENDED: colors.danger,
};

const SEARCH_DEBOUNCE_MS = 200;

export default function HistoryFeed() {
  const router = useRouter();

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [kind, setKind] = useState<BatchEventKind | null>(null);

  const [events, setEvents] = useState<BatchEventSummary[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // Filtering happens on the SERVER. The feed is capped, so filtering a page already
  // fetched would search only the newest 100 events and quietly report "nothing" for a
  // transfer that happened last month.
  const request = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiHistoryFeed({
        ...(debouncedQ ? { q: debouncedQ } : {}),
        ...(kind ? { kind } : {}),
      });
      // A slow first request must not overwrite a fast second one.
      if (ticket !== request.current) return;
      setEvents(res.events);
      setTruncated(res.truncated);
    } catch (e) {
      if (ticket !== request.current) return;
      setError(e instanceof ApiError ? e.message : 'Could not load the history feed.');
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [debouncedQ, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => groupByDay(events), [events]);

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        Every change to every batch, newest first. This is a record — nothing here can be edited.
      </Text>

      <Field
        label="Search by project number or project manager"
        value={q}
        onChangeText={setQ}
        placeholder="123456-789-1-23"
        autoCorrect={false}
      />

      <View style={styles.filterRow}>
        <FilterPill label="All" active={kind === null} onPress={() => setKind(null)} />
        {KINDS.map((k) => (
          <FilterPill
            key={k}
            label={BATCH_EVENT_LABELS[k]}
            active={kind === k}
            colour={KIND_COLOUR[k]}
            onPress={() => setKind(kind === k ? null : k)}
          />
        ))}
      </View>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && events.length === 0 ? (
        <LoadingState label="Loading history…" />
      ) : events.length === 0 ? (
        <EmptyState
          title={debouncedQ || kind ? 'Nothing matches' : 'Nothing has happened yet'}
          hint={
            debouncedQ || kind
              ? 'Try a different search, or clear the filter.'
              : 'Create a batch and its first event will appear here.'
          }
        />
      ) : (
        <>
          <Text style={base.hint}>
            {events.length} event{events.length === 1 ? '' : 's'}
            {truncated ? ' · showing the most recent only' : ''}
          </Text>

          {grouped.map(([day, rows]) => (
            <View key={day} style={{ gap: 10 }}>
              <Text style={styles.day}>{day}</Text>
              {rows.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  onPress={() =>
                    router.push({
                      pathname: '/history/event/[kind]/[id]',
                      params: { kind: e.kind, id: e.recordId },
                    })
                  }
                />
              ))}
            </View>
          ))}
        </>
      )}

      {/* The batch list answers "what happened to this order"; the serial lookup
          answers "where has this one cylinder been", which is a different question
          asked with a scuffed sticker in hand. */}
      <SecondaryButton
        title="Look up a cylinder serial"
        onPress={() => router.push('/history/serial-lookup')}
      />
      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}

function EventRow({ event, onPress }: { event: BatchEventSummary; onPress: () => void }) {
  return (
    <Card onPress={onPress}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={[styles.rail, { backgroundColor: KIND_COLOUR[event.kind] }]} />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={styles.headRow}>
            <Text style={[styles.kind, { color: KIND_COLOUR[event.kind] }]}>
              {BATCH_EVENT_LABELS[event.kind].toUpperCase()}
            </Text>
            <Text style={styles.time}>{formatBatchDate(event.at)}</Text>
          </View>

          <Text style={styles.headline}>{event.headline}</Text>
          <Text style={styles.detail}>{event.detail}</Text>
          <Text style={styles.meta}>
            {event.projectNumber} · {event.siteName} · {event.contents}
          </Text>
          <Text style={styles.meta}>by {event.userName}</Text>

          <View style={styles.tagRow}>
            {event.hasPhoto ? <Tag label="Photo" tone="ok" /> : null}
            {event.photoOverridden ? <Tag label="No photo — admin override" tone="warn" /> : null}
            {event.overriddenCount > 0 ? (
              <Tag label={`${event.overriddenCount} unscanned`} tone="warn" />
            ) : null}
          </View>
        </View>
      </View>
    </Card>
  );
}

function Tag({ label, tone }: { label: string; tone: 'ok' | 'warn' }) {
  return (
    <View style={[styles.tag, tone === 'ok' ? styles.tagOk : styles.tagWarn]}>
      <Text style={[styles.tagText, tone === 'warn' && { color: colors.warning }]}>{label}</Text>
    </View>
  );
}

function FilterPill({
  label,
  active,
  colour = colors.brand,
  onPress,
}: {
  label: string;
  active: boolean;
  colour?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      aria-pressed={active}
      onPress={onPress}
      style={[styles.pill, active && { backgroundColor: colour, borderColor: colour }]}
    >
      <Text style={[styles.pillText, active && { color: '#fff', fontWeight: '700' }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Day headers, so a long feed reads as a chronology rather than a wall.
 *
 * Grouped from the already-sorted list rather than by a second sort: the server
 * decided the order (including the tie-break that keeps it stable across refreshes),
 * and re-sorting here would be a second opinion about it.
 */
function groupByDay(events: BatchEventSummary[]): [string, BatchEventSummary[]][] {
  const out: [string, BatchEventSummary[]][] = [];
  for (const e of events) {
    const day = new Date(e.at).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(e);
    else out.push([day, [e]]);
  }
  return out;
}

const styles = StyleSheet.create({
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillText: { fontSize: 13, fontWeight: '600' },
  day: { fontSize: 13, fontWeight: '700', opacity: 0.55, marginTop: 6 },
  rail: { width: 4, borderRadius: 2 },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  kind: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  time: { fontSize: 12, opacity: 0.6 },
  headline: { fontSize: 15, fontWeight: '700' },
  detail: { fontSize: 14, opacity: 0.8 },
  meta: { fontSize: 12, opacity: 0.6 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  tag: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  tagOk: { backgroundColor: colors.successTint },
  tagWarn: { backgroundColor: colors.warningTint },
  tagText: { fontSize: 11, fontWeight: '700' },
});
