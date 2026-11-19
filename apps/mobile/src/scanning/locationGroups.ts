import type { CachedCylinder, CachedSite } from '../db';

/**
 * The scan checklist, split by where each cylinder is right now.
 *
 * A transfer or a return picks from a batch that can be half in stores and half on
 * site, and the two are physically different piles in different places — mixing their
 * serials in one list made it easy to scan the stores pile and not notice the site
 * pile was still to come, or to select an on-site cylinder for a move that was really
 * about stores. So each location gets its own line: stores first, then each site.
 */
export interface LocationGroup {
  /** `'stores'`, or the site id. */
  key: string;
  label: string;
  cylinders: CachedCylinder[];
}

export function groupByLocation(
  cylinders: readonly CachedCylinder[],
  sites: readonly Pick<CachedSite, 'id' | 'location'>[],
): LocationGroup[] {
  const siteName = new Map(sites.map((s) => [s.id, s.location]));
  const stores: LocationGroup = { key: 'stores', label: 'In stores', cylinders: [] };
  const bySite = new Map<string, LocationGroup>();

  for (const c of cylinders) {
    if (!c.currentSiteId) {
      stores.cylinders.push(c);
      continue;
    }
    let g = bySite.get(c.currentSiteId);
    if (!g) {
      // A site the cache does not know (renamed or moved off this client since) still
      // gets its own line — merging it into another would be the very mix-up this
      // split exists to prevent.
      g = {
        key: c.currentSiteId,
        label: `On site · ${siteName.get(c.currentSiteId) ?? 'another site'}`,
        cylinders: [],
      };
      bySite.set(c.currentSiteId, g);
    }
    g.cylinders.push(c);
  }

  const sitesSorted = [...bySite.values()].sort((a, b) => a.label.localeCompare(b.label));
  return [...(stores.cylinders.length > 0 ? [stores] : []), ...sitesSorted];
}
