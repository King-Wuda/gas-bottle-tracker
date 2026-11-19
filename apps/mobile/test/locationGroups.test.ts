import { describe, it, expect } from 'vitest';
import type { CachedCylinder } from '../src/db';
import { groupByLocation } from '../src/scanning/locationGroups';

const cyl = (serialCode: string, currentSiteId: string | null): CachedCylinder => ({
  serialCode,
  batchId: 'b1',
  gasTypeName: 'Argon',
  gasTypeId: 'ar',
  deliveryPoint: 'STORES',
  status: currentSiteId ? 'DEPLOYED' : 'IN_STORES',
  currentSiteId,
});

const sites = [
  { id: 'dbn', location: 'Durban' },
  { id: 'cpt', location: 'Cape Town' },
];

describe('groupByLocation', () => {
  it('puts stores and each site on its own line — stores first, then sites by name', () => {
    const groups = groupByLocation(
      [cyl('A1', 'dbn'), cyl('A2', null), cyl('A3', 'cpt'), cyl('A4', null), cyl('A5', 'dbn')],
      sites,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'In stores',
      'On site · Cape Town',
      'On site · Durban',
    ]);
    expect(groups.map((g) => g.cylinders.map((c) => c.serialCode))).toEqual([
      ['A2', 'A4'],
      ['A3'],
      ['A1', 'A5'],
    ]);
  });

  it('leaves out a location with nothing in it', () => {
    expect(groupByLocation([cyl('A1', 'dbn')], sites).map((g) => g.key)).toEqual(['dbn']);
    expect(groupByLocation([cyl('A1', null)], sites).map((g) => g.key)).toEqual(['stores']);
    expect(groupByLocation([], sites)).toEqual([]);
  });

  it('keeps a site the cache does not know on a line of its own', () => {
    const groups = groupByLocation([cyl('A1', 'gone'), cyl('A2', 'dbn')], sites);
    expect(groups.map((g) => g.label)).toEqual(['On site · another site', 'On site · Durban']);
  });
});
