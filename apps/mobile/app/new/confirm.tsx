import { Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import {
  formatBatchDate,
  INITIAL_DELIVERY_POINT_LABELS,
  type InitialDeliveryPoint,
} from '@gct/shared';
import { useNewFlow } from '../../src/new/NewFlowContext';
import { ResendEmailButton } from '../../src/batches/ResendEmailButton';
import {
  Card,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';

export default function Confirm() {
  const router = useRouter();
  const { result, projectNumber, siteName, reset } = useNewFlow();

  if (!result) return <Redirect href="/new" />;

  const { batch, serials } = result;

  const done = () => {
    // Navigate first: reset() clears `result`, and if this screen renders once more
    // before the /new stack unmounts, the guard above would redirect back to /new.
    router.replace('/');
    reset();
  };

  return (
    <ScreenScroll>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>Batch created</Text>
      <Text style={{ opacity: 0.7 }}>
        {projectNumber ?? batch.projectNumber} · {siteName ?? batch.siteName}. One printable QR
        sheet covering all {batch.quantity} cylinder(s) has been emailed to the project manager.
      </Text>

      <Card>
        <Text style={{ fontWeight: '700' }}>
          {batch.quantity} cylinder(s) across {batch.lines.length} line
          {batch.lines.length === 1 ? '' : 's'}
        </Text>
        <Text style={styles.label}>Created {formatBatchDate(batch.createdAt)}</Text>

        <View style={{ gap: 4, marginTop: 8 }}>
          {batch.lines.map((l) => (
            <Text key={l.id}>
              <Text style={{ fontWeight: '700' }}>
                {l.quantity} × {l.gasTypeName}
              </Text>
              <Text style={{ opacity: 0.7 }}>
                {'  '}
                {l.supplierName} · to{' '}
                {INITIAL_DELIVERY_POINT_LABELS[l.initialDeliveryPoint as InitialDeliveryPoint] ??
                  l.initialDeliveryPoint}
              </Text>
            </Text>
          ))}
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {serials.map((s) => (
            <Text
              key={s}
              style={{
                fontFamily: 'monospace',
                fontSize: 12,
                paddingHorizontal: 6,
                paddingVertical: 3,
                borderRadius: 6,
                backgroundColor: 'rgba(127,127,127,0.15)',
              }}
            >
              {s}
            </Text>
          ))}
        </View>

        <View style={{ marginTop: 10, gap: 6 }}>
          <Text style={styles.label}>Sent to {batch.projectManagerEmail}</Text>
          <ResendEmailButton
            batchId={batch.id}
            lastEmailSentAt={batch.lastEmailSentAt}
            resendCount={batch.resendCount}
            recipient={batch.projectManagerEmail}
          />
          {/* This screen lives in memory, so a browser refresh loses it. The batch
              detail view is addressable by id, re-reads lastEmailSentAt from the
              server, and resumes the same countdown — so the resend is never
              stranded behind a refresh. */}
          <SecondaryButton
            title="Open batch details"
            onPress={() =>
              router.push({ pathname: '/history/batch/[id]', params: { id: batch.id } })
            }
          />
        </View>
      </Card>

      {/* The next physical step, offered where the operator already is. Nothing in
          this batch can move until it has been done — a transfer or return of an
          uninitialized batch is refused — so burying it would leave a batch created
          and then stuck. */}
      <PrimaryButton
        title="Initialize this batch now"
        onPress={() => {
          router.replace('/initialize');
          reset();
        }}
      />
      <Text style={[styles.label, { textAlign: 'center' }]}>
        Each label on the sheet is printed with this batch&apos;s details. Tag every cylinder, then
        scan them all back in — this batch cannot be transferred or returned until you have.
      </Text>

      <SecondaryButton title="Done — initialize later" onPress={done} />
    </ScreenScroll>
  );
}
