import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { RESEND_LOCKOUT_SECONDS } from '@gct/shared';
import { ApiError, apiResendBatchEmail } from '../api/client';
import { PrimaryButton, SecondaryButton, styles as base } from '../ui/components';

/**
 * "Resend email", locked for 60s after each send.
 *
 * The countdown is DERIVED, every tick, from the server's `lastEmailSentAt` timestamp
 * — never counted down in component state. That distinction is the whole point of the
 * requirement: a local counter restarts at 60 whenever the component remounts, so a
 * page refresh (or navigating away and back) would hand out a fresh window the server
 * has no intention of honouring. Recomputing from a stored instant means a refresh
 * resumes the real remaining time, and the server's own `WHERE lastEmailSentAt <=
 * now() - 60s` claim is the authority either way.
 */

const secondsLeft = (lastSentAt: string | null): number => {
  if (!lastSentAt) return 0;
  const elapsedMs = Date.now() - new Date(lastSentAt).getTime();
  if (Number.isNaN(elapsedMs)) return 0;
  return Math.max(0, Math.ceil((RESEND_LOCKOUT_SECONDS * 1000 - elapsedMs) / 1000));
};

type Feedback = { kind: 'ok' | 'fail'; message: string } | null;

export function ResendEmailButton({
  batchId,
  lastEmailSentAt,
  resendCount = 0,
  recipient,
  /** Set when the create call itself failed to queue mail — see section 7's error rule. */
  sendFailed = false,
}: {
  batchId: string;
  lastEmailSentAt: string | null;
  resendCount?: number;
  recipient?: string;
  sendFailed?: boolean;
}) {
  const [sentAt, setSentAt] = useState<string | null>(lastEmailSentAt);
  const [count, setCount] = useState(resendCount);
  const [remaining, setRemaining] = useState(() => secondsLeft(lastEmailSentAt));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // A prop change (the detail screen refetching) must win over local state.
  useEffect(() => {
    setSentAt(lastEmailSentAt);
    setRemaining(secondsLeft(lastEmailSentAt));
  }, [lastEmailSentAt]);

  useEffect(() => {
    setCount(resendCount);
  }, [resendCount]);

  // If the batch's mail never got queued there is nothing to wait for: section 7 says
  // the failure must leave the control immediately usable, not locked for a minute.
  const locked = !sendFailed && remaining > 0;

  useEffect(() => {
    if (!locked) return;
    const t = setInterval(() => setRemaining(secondsLeft(sentAt)), 1000);
    return () => clearInterval(t);
  }, [locked, sentAt]);

  const resend = useCallback(async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiResendBatchEmail(batchId);
      setSentAt(res.lastEmailSentAt);
      setRemaining(secondsLeft(res.lastEmailSentAt));
      setCount(res.resendCount);
      setFeedback({
        kind: 'ok',
        message: recipient ? `Queued again for ${recipient}.` : 'Queued again.',
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        // The server refused because its own window is still open. Adopt its numbers
        // rather than arguing with them — the device clock is the untrustworthy one.
        const details = e.details as { lastEmailSentAt?: string | null } | undefined;
        if (details?.lastEmailSentAt) {
          setSentAt(details.lastEmailSentAt);
          setRemaining(secondsLeft(details.lastEmailSentAt));
        }
        setFeedback({ kind: 'fail', message: e.message });
      } else {
        setFeedback({
          kind: 'fail',
          message: e instanceof ApiError ? e.message : 'Could not reach the server.',
        });
      }
    } finally {
      setBusy(false);
    }
  }, [batchId, recipient]);

  return (
    <View style={{ gap: 6 }}>
      {locked ? (
        // Disabled, but still rendered as the same control in the same place, so the
        // countdown reads as "not yet" rather than as a button that vanished.
        <PrimaryButton
          title={`Resend available in ${remaining}s`}
          onPress={() => undefined}
          disabled
        />
      ) : (
        <SecondaryButton title="Resend email" onPress={() => void resend()} disabled={busy} />
      )}

      {feedback ? (
        <Text style={feedback.kind === 'ok' ? okStyle : base.error}>{feedback.message}</Text>
      ) : null}

      {count > 0 ? (
        <Text style={base.label}>
          Resent {count} time{count === 1 ? '' : 's'}
        </Text>
      ) : null}
    </View>
  );
}

const okStyle = { color: '#2f7a4d', fontSize: 14 } as const;
