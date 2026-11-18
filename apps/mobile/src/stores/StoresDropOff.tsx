import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CAGES } from '@gct/shared';
import type { CachedCylinder } from '../db';
import type { GasInDropOff } from './dropOff';

export { allCaged, cagesPayload, gasesIn, type GasInDropOff } from './dropOff';
import { Card } from '../ui/components';
import { SegmentedToggle } from '../ui/controls';
import { colors, radius, space, type } from '../ui/theme';

/**
 * Putting cylinders into stores — the two questions a drop-off asks.
 *
 * 1. **Which cage?** One per gas: every argon cylinder in this drop-off goes into the
 *    cage chosen for argon. Asked at initialization (for the gases delivered to
 *    stores) and on every transfer back to stores.
 * 2. **Which came back empty?** Only on a transfer back to stores. Everything is booked
 *    in full, so this is the moment a cylinder's contents change; untouched rows are
 *    recorded as full.
 *
 * Shared by both flows so the question reads the same wherever it is asked. Neither
 * piece uses the green/amber/red of the scan step: full and empty are facts about the
 * gas, not about how well the cylinder was evidenced.
 */

const CAGE_OPTIONS = CAGES.map((c) => ({ value: String(c), label: `Cage ${c}` }));

export function CageChooser({
  gases,
  cages,
  onChange,
  disabled = false,
}: {
  gases: readonly GasInDropOff[];
  cages: Record<string, number>;
  onChange: (gasTypeId: string, cage: number) => void;
  disabled?: boolean;
}) {
  if (gases.length === 0) return null;
  return (
    <Card>
      <Text style={type.heading}>Which cage?</Text>
      <Text style={type.caption}>Every cylinder of a gas goes into the same cage.</Text>
      {gases.map((g) => (
        <SegmentedToggle
          key={g.gasTypeId}
          label={`${g.gasTypeName} · ${g.count} cylinder${g.count === 1 ? '' : 's'}`}
          options={CAGE_OPTIONS}
          value={cages[g.gasTypeId] !== undefined ? String(cages[g.gasTypeId]) : null}
          onChange={(v) => onChange(g.gasTypeId, Number(v))}
          disabled={disabled}
        />
      ))}
    </Card>
  );
}

export function EmptyMarker({
  cylinders,
  serials,
  empties,
  onToggle,
  disabled = false,
}: {
  cylinders: readonly CachedCylinder[];
  serials: readonly string[];
  empties: readonly string[];
  onToggle: (serialCode: string) => void;
  disabled?: boolean;
}) {
  const wanted = new Set(serials);
  const rows = cylinders.filter((c) => wanted.has(c.serialCode));
  const emptyCount = rows.filter((c) => empties.includes(c.serialCode)).length;

  return (
    <Card>
      <Text style={type.heading}>Which came back empty?</Text>
      <Text style={type.caption}>
        Tap a cylinder to mark it empty. The rest are recorded as full.
      </Text>
      <Text style={type.bodyStrong}>
        {rows.length - emptyCount} full · {emptyCount} empty
      </Text>
      <View style={s.list}>
        {rows.map((c) => {
          const empty = empties.includes(c.serialCode);
          return (
            <Pressable
              key={c.serialCode}
              role="checkbox"
              aria-checked={empty}
              accessibilityState={{ checked: empty, disabled }}
              disabled={disabled}
              onPress={() => onToggle(c.serialCode)}
              style={({ pressed }) => [s.row, empty && s.rowEmpty, pressed && s.pressed]}
            >
              <Text style={type.mono}>{c.serialCode}</Text>
              <Text style={[type.caption, s.gas]}>{c.gasTypeName}</Text>
              <Text style={empty ? s.stateEmpty : s.stateFull}>{empty ? 'Empty' : 'Full'}</Text>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  list: { gap: space.xs, marginTop: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowEmpty: { backgroundColor: colors.sunken, borderColor: colors.borderStrong },
  pressed: { opacity: 0.7 },
  gas: { flex: 1 },
  stateFull: { ...StyleSheet.flatten(type.caption) },
  stateEmpty: { ...StyleSheet.flatten(type.bodyStrong) },
});
