import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Redirect, useFocusEffect } from 'expo-router';
import type { StoresGasSummary, StoresSummaryResponse } from '@gct/shared';
import { ApiError, apiStoresSummary } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import {
  Card,
  ErrorState,
  LoadingState,
  ScreenScroll,
  SecondaryButton,
} from '../src/ui/components';
import { colors, radius, space, type } from '../src/ui/theme';

/**
 * The stores console — what is in the yard, by gas.
 *
 * For each gas: every cylinder still in rotation (in stores, on site or in transit),
 * how many in stores are full and how many came back empty, and which cage they are
 * in. Returned cylinders are not counted: they went back to the supplier.
 *
 * Read-only, and online-only on purpose. It is a live count of shared state, and a
 * cached copy shown with no signal would be a confident wrong answer.
 */
export default function StoresConsole() {
  const { user } = useAuth();
  const [data, setData] = useState<StoresSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiStoresSummary());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the stores count.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Every time the screen is shown, not only the first: a transfer just recorded on
  // this phone should be in the count when the operator comes back to look.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!user) return <Redirect href="/login" />;
  if (user.role !== 'STORES_MANAGER' && user.role !== 'PROJECT_MANAGER') {
    return <Redirect href="/" />;
  }
  if (loading && !data) return <LoadingState label="Counting cylinders…" />;
  if (error && !data) {
    return (
      <ScreenScroll>
        <ErrorState message={error} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }
  if (!data) return null;

  const t = data.totals;
  return (
    <ScreenScroll>
      <Card>
        <Text style={type.overline}>All gases</Text>
        <View style={s.stats}>
          <Stat label="In rotation" value={t.total} />
          <Stat label="Full in stores" value={t.inStores.full} />
          <Stat label="Empty in stores" value={t.inStores.empty} />
          <Stat label="On site" value={t.onSite} />
        </View>
        {t.inTransit > 0 ? <Text style={type.caption}>{t.inTransit} in transit.</Text> : null}
      </Card>

      {data.gases.map((g) => (
        <GasCard key={g.gasTypeId} gas={g} />
      ))}

      {data.gases.length === 0 ? <Text style={type.caption}>No gases are set up yet.</Text> : null}

      <SecondaryButton title={loading ? 'Refreshing…' : 'Refresh'} onPress={() => void load()} />
    </ScreenScroll>
  );
}

function GasCard({ gas }: { gas: StoresGasSummary }) {
  const showNoCage = gas.noCage.full + gas.noCage.empty > 0;
  return (
    <Card>
      <View style={s.gasHeader}>
        <Text style={type.title}>{gas.gasTypeName}</Text>
        <Text style={type.bodyStrong}>{gas.total} in rotation</Text>
      </View>
      <View style={s.stats}>
        <Stat label="Full in stores" value={gas.inStores.full} />
        <Stat label="Empty in stores" value={gas.inStores.empty} />
        <Stat label="On site" value={gas.onSite} />
      </View>

      <View style={s.table}>
        <View style={[s.tr, s.thead]}>
          <Text style={[type.overline, s.cellName]}>Cage</Text>
          <Text style={[type.overline, s.cellNum]}>Full</Text>
          <Text style={[type.overline, s.cellNum]}>Empty</Text>
        </View>
        {gas.cages.map((c) => (
          <View key={c.cage} style={s.tr}>
            <Text style={[type.bodyStrong, s.cellName]}>Cage {c.cage}</Text>
            <Text style={[type.body, s.cellNum, c.full === 0 && s.zero]}>{c.full}</Text>
            <Text style={[type.body, s.cellNum, c.empty === 0 && s.zero]}>{c.empty}</Text>
          </View>
        ))}
        {/* Cylinders in stores with no cage chosen yet — a cage is optional when they
            come in, and a stores manager sets it later from the batch page. Shown only
            when there are some, and labelled for what it is rather than folded into a
            cage. */}
        {showNoCage ? (
          <View style={s.tr}>
            <Text style={[type.body, s.cellName]}>No cage yet</Text>
            <Text style={[type.body, s.cellNum]}>{gas.noCage.full}</Text>
            <Text style={[type.body, s.cellNum]}>{gas.noCage.empty}</Text>
          </View>
        ) : null}
      </View>
      {gas.inTransit > 0 ? <Text style={type.caption}>{gas.inTransit} in transit.</Text> : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.stat}>
      <Text style={type.display}>{value}</Text>
      <Text style={type.caption}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  stat: {
    flexGrow: 1,
    flexBasis: 90,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.sunken,
  },
  gasHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  table: {
    marginTop: space.sm,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  thead: { paddingVertical: space.xs },
  tr: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  cellName: { flex: 2 },
  cellNum: { flex: 1, textAlign: 'right' },
  zero: { color: colors.inkFaint },
});
