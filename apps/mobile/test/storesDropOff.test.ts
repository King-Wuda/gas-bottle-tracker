import { describe, it, expect } from 'vitest';
import { cagesPayload, gasesIn } from '../src/stores/dropOff';

const cyl = (serialCode: string, gasTypeId: string, gasTypeName: string) => ({
  serialCode,
  gasTypeId,
  gasTypeName,
});

const batch = [
  cyl('ARG26-001', 'ar', 'Argon'),
  cyl('ARG26-002', 'ar', 'Argon'),
  cyl('NIT26-001', 'n2', 'Nitrogen'),
  cyl('NIT26-002', 'n2', 'Nitrogen'),
];

describe('stores drop-off', () => {
  it('lists the gases among the chosen cylinders only, with counts, by name', () => {
    expect(gasesIn(batch, ['NIT26-002', 'ARG26-001', 'ARG26-002'])).toEqual([
      { gasTypeId: 'ar', gasTypeName: 'Argon', count: 2 },
      { gasTypeId: 'n2', gasTypeName: 'Nitrogen', count: 1 },
    ]);
    expect(gasesIn(batch, [])).toEqual([]);
  });

  it('sends a cage only for the gases in this drop-off', () => {
    // A cage picked earlier for nitrogen, before its cylinders were deselected, is not
    // sent: the server would rightly refuse it at initialization.
    const gases = gasesIn(batch, ['ARG26-001']);
    expect(cagesPayload(gases, { ar: 2, n2: 3 })).toEqual([{ gasTypeId: 'ar', cage: 2 }]);
  });
});
