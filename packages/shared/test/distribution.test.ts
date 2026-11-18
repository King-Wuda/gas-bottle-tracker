import { describe, it, expect } from 'vitest';
import { distributionLines, summariseDistribution } from '../src/schemas/batch';

const entries = [
  {
    gasTypeId: 'ar',
    gasTypeName: 'Argon',
    kind: 'SITE' as const,
    siteId: 's',
    locationName: 'Durban',
    count: 2,
  },
  {
    gasTypeId: 'ar',
    gasTypeName: 'Argon',
    kind: 'RETURNED' as const,
    siteId: null,
    locationName: 'Returned',
    count: 1,
  },
  {
    gasTypeId: 'ar',
    gasTypeName: 'Argon',
    kind: 'STORES' as const,
    siteId: null,
    locationName: 'Stores',
    count: 3,
  },
  {
    gasTypeId: 'ar',
    gasTypeName: 'Argon',
    kind: 'SITE' as const,
    siteId: 's',
    locationName: 'Cape Town',
    count: 4,
  },
];

describe('where a gas is', () => {
  it('one line per location: stores, then each site, then returned', () => {
    expect(distributionLines(entries)).toEqual([
      '3 in stores',
      '4 on site at Cape Town',
      '2 on site at Durban',
      '1 returned to supplier',
    ]);
  });

  it('the one-line summary says the same, joined', () => {
    expect(summariseDistribution(entries)).toBe(distributionLines(entries).join(' · '));
  });
});
