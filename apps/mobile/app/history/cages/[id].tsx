import { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { BatchGasCagesDto } from '@gct/shared';
import { ApiError, apiBatchCages, apiSetBatchCages } from '../../../src/api/client';
import { CAGE_OPTIONS, NO_CAGE } from '../../../src/stores/StoresDropOff';
import {
  Card,
  EmptyState,
  ErrorState,
  ErrorText,
  Field,
  LoadingState,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../../src/ui/components';
import { SegmentedToggle } from '../../../src/ui/controls';
import { colors, type } from '../../../src/ui/theme';

/**
 * Change cages — the stores manager's one edit to a batch.
 *
 * Choosing a cage is optional when cylinders come into stores, so this is where a gas
 * is put into a cage later, moved to another, or taken out of one. It changes the cage
 * and nothing else: every other correction to a batch is a project manager's, on
 * Correct batch. Only the cylinders physically in stores are listed and moved.
 */
const describeCages = (g: BatchGasCagesDto): string =>
  g.byCage
    .map((c) => `${c.count} ${c.cage === null ? 'in no cage' : `in cage ${c.cage}`}`)
    .join(' · ');

/** The cage every cylinder of the gas shares, or NO_CAGE / null when they differ. */
const currentChoice = (g: BatchGasCagesDto): string | null => {
  if (g.byCage.length !== 1) return null;
  const only = g.byCage[0]!.cage;
  return only === null ? NO_CAGE : String(only);
};

export default function BatchCages() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [projectNumber, setProjectNumber] = useState('');
  const [gases, setGases] = useState<BatchGasCagesDto[]>([]);
  const [choice, setChoice] = useState<Record<string, string | null>>({});
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiBatchCages(id);
      setProjectNumber(res.projectNumber);
      setGases(res.gases);
      setChoice(Object.fromEntries(res.gases.map((g) => [g.gasTypeId, currentChoice(g)])));
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load this batch.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && gases.length === 0 && !loadError) return <LoadingState label="Loading cages…" />;
  if (loadError) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }

  const changed = gases.filter((g) => {
    const c = choice[g.gasTypeId];
    return c !== null && c !== undefined && c !== currentChoice(g);
  });

  const save = async () => {
    if (!id || changed.length === 0) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await apiSetBatchCages(id, {
        cages: changed.map((g) => {
          const c = choice[g.gasTypeId]!;
          return { gasTypeId: g.gasTypeId, cage: c === NO_CAGE ? null : Number(c) };
        }),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setReason('');
      setSaved(true);
      await load();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Could not change the cages.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenScroll>
      <Text style={type.title}>{projectNumber}</Text>
      <Text style={styles.hint}>
        Which cage each gas of this batch is in. Every cylinder of a gas that is in stores moves to
        the cage you choose. The change is recorded on the batch with your name.
      </Text>

      {gases.length === 0 ? (
        <EmptyState
          title="Nothing in stores"
          hint="None of this batch's cylinders are in stores, so there is nothing to put in a cage."
        />
      ) : null}

      {gases.map((g) => (
        <Card key={g.gasTypeId}>
          <Text style={type.heading}>{g.gasTypeName}</Text>
          <Text style={type.caption}>
            {g.inStores} in stores — {describeCages(g)}
          </Text>
          <SegmentedToggle
            label="Move to"
            options={CAGE_OPTIONS}
            value={choice[g.gasTypeId] ?? null}
            onChange={(v) => setChoice((prev) => ({ ...prev, [g.gasTypeId]: v }))}
            disabled={saving}
          />
        </Card>
      ))}

      {gases.length > 0 ? (
        <Field
          label="Why (optional — recorded with the change)"
          value={reason}
          onChangeText={setReason}
          placeholder="e.g. cage 3 is full"
        />
      ) : null}

      <ErrorText>{saveError}</ErrorText>
      {saved && !saveError ? (
        <Text style={{ color: colors.success, fontWeight: '600' }}>Cages saved.</Text>
      ) : null}

      {gases.length > 0 ? (
        <PrimaryButton
          title={changed.length === 0 ? 'Nothing changed yet' : 'Save cages'}
          onPress={() => void save()}
          disabled={changed.length === 0 || saving}
          busy={saving}
        />
      ) : null}
      <SecondaryButton
        title="Back to batch"
        onPress={() => router.replace({ pathname: '/history/batch/[id]', params: { id: id! } })}
      />
    </ScreenScroll>
  );
}
