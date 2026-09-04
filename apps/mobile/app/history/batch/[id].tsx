import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  formatBatchDate,
  INITIAL_DELIVERY_POINT_LABELS,
  summariseDistribution,
  type BatchDto,
  type InitialDeliveryPoint,
} from '@gct/shared';
import { ApiError, apiGetBatch } from '../../../src/api/client';
import { useAuth } from '../../../src/auth/AuthContext';
import { ResendEmailButton } from '../../../src/batches/ResendEmailButton';
import {
  Card,
  ErrorState,
  LoadingState,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../../src/ui/components';
import { StatusBadge, type BadgeTone } from '../../../src/ui/controls';
import { colors } from '../../../src/ui/theme';

/**
 * One batch, in full — reached from the History list and from the confirmation screen.
 *
 * Addressable by id, which is what makes the resend countdown genuinely refresh-proof:
 * this screen re-reads `lastEmailSentAt` from the server on every mount, so reloading
 * the page resumes the real remaining lockout instead of granting a fresh 60 seconds.
 */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'space-between' }}>
      <Text style={[styles.label, { flexShrink: 0 }]}>{label}</Text>
      <Text style={{ flexShrink: 1, textAlign: 'right' }}>{value}</Text>
    </View>
  );
}

const badgeFor = (b: BatchDto): { label: string; tone: BadgeTone } => {
  if (b.returnedAt) return { label: 'Returned', tone: 'done' };
  // Ahead of every location badge: an uninitialized batch cannot be transferred or
  // returned at all, so where its cylinders nominally sit is not the useful fact.
  if (!b.initializedAt) return { label: 'Not initialized', tone: 'moved' };
  if (b.status === 'PARTIAL') return { label: 'Partly returned', tone: 'moved' };
  const live = b.distribution.filter((d) => d.kind !== 'RETURNED');
  const atStores = live.some((d) => d.kind === 'STORES');
  const onSite = live.some((d) => d.kind === 'SITE');
  if (atStores && onSite) return { label: 'Split', tone: 'moved' };
  if (onSite) return { label: 'On site', tone: 'moved' };
  return { label: 'At stores', tone: 'neutral' };
};

export default function BatchDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();

  const [batch, setBatch] = useState<BatchDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiGetBatch(id);
      setBatch(res.batch);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this batch.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !batch) return <LoadingState label="Loading batch..." />;
  if (error && !batch) {
    return (
      <ScreenScroll>
        <ErrorState message={error} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }
  if (!batch) return null;

  const badge = badgeFor(batch);
  const outstanding = batch.cylinders.filter((c) => c.status !== 'RETURNED').length;

  return (
    <ScreenScroll>
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <Text style={{ fontSize: 20, fontWeight: '700' }}>{batch.projectNumber}</Text>
        <StatusBadge label={badge.label} tone={badge.tone} />
      </View>

      <Card>
        <Row label="Created" value={formatBatchDate(batch.createdAt)} />
        <Row label="Project manager" value={batch.projectManagerName} />
        <Row label="Manager email" value={batch.projectManagerEmail} />
        <Row label="Site" value={`${batch.siteName} — ${batch.siteLocation}`} />
        <Row label="Quantity" value={`${batch.quantity} cylinder(s)`} />
        <Row label="Still out" value={`${outstanding} of ${batch.cylinders.length}`} />
      </Card>

      <Card>
        <Text style={{ fontWeight: '700' }}>Contents &amp; where they are</Text>
        <View style={{ marginTop: 6, gap: 8 }}>
          {batch.lines.map((l) => (
            <View key={l.id}>
              <Text style={{ fontWeight: '700' }}>
                {l.quantity} × {l.gasTypeName}
              </Text>
              <Text style={{ opacity: 0.7 }}>
                {l.supplierName} · delivered to{' '}
                {INITIAL_DELIVERY_POINT_LABELS[l.initialDeliveryPoint as InitialDeliveryPoint] ??
                  l.initialDeliveryPoint}
              </Text>
              <Text style={styles.hint}>
                {summariseDistribution(
                  batch.distribution.filter((d) => d.gasTypeId === l.gasTypeId),
                ) || 'No cylinders'}
              </Text>
            </View>
          ))}
        </View>
      </Card>

      {!batch.initializedAt ? (
        <Card>
          <Text style={{ fontWeight: '700', color: colors.warning }}>
            Waiting for its first scan
          </Text>
          <Text style={styles.hint}>
            Nothing in this batch can be transferred or returned until every label has been scanned
            back off its cylinder. Start that from New → Initialize a batch.
          </Text>
        </Card>
      ) : null}

      {user?.role === 'ADMIN' ? (
        <SecondaryButton
          title="Correct these details (admin)"
          onPress={() => router.push({ pathname: '/admin/batch/[id]', params: { id: batch.id } })}
        />
      ) : null}

      <Card>
        <Text style={{ fontWeight: '700' }}>Movement</Text>
        <Row
          label="Initialized"
          value={batch.initializedAt ? formatBatchDate(batch.initializedAt) : 'Not yet'}
        />
        <Row
          label="First transferred"
          value={batch.transferredAt ? formatBatchDate(batch.transferredAt) : 'Not yet'}
        />
        <Row
          label="Fully returned"
          value={batch.returnedAt ? formatBatchDate(batch.returnedAt) : 'Not yet'}
        />
      </Card>

      <Card>
        <Text style={{ fontWeight: '700' }}>QR sheet email</Text>
        <Row
          label="First sent"
          value={batch.emailSentAt ? formatBatchDate(batch.emailSentAt) : 'Not sent'}
        />
        <Row
          label="Last sent"
          value={batch.lastEmailSentAt ? formatBatchDate(batch.lastEmailSentAt) : 'Not sent'}
        />
        <View style={{ marginTop: 8 }}>
          <ResendEmailButton
            batchId={batch.id}
            lastEmailSentAt={batch.lastEmailSentAt}
            resendCount={batch.resendCount}
            recipient={batch.projectManagerEmail}
            // Nothing was ever queued for this batch, so there is no window to wait
            // out — the control must be usable immediately.
            sendFailed={batch.emailSentAt === null}
          />
        </View>
      </Card>

      <Card>
        <Text style={{ fontWeight: '700' }}>Serials</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {batch.cylinders.map((c) => (
            <Text
              key={c.id}
              onPress={() =>
                router.push({ pathname: '/history/[serial]', params: { serial: c.serialCode } })
              }
              style={{
                fontFamily: 'monospace',
                fontSize: 12,
                paddingHorizontal: 6,
                paddingVertical: 3,
                borderRadius: 6,
                backgroundColor: c.status === 'RETURNED' ? colors.successTint : colors.sunken,
              }}
            >
              {c.serialCode}
            </Text>
          ))}
        </View>
        <Text style={styles.hint}>Tap a serial for its full movement history.</Text>
      </Card>

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
