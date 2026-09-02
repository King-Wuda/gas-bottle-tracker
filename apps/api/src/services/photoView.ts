/**
 * How a `BatchPhoto` row becomes a DTO. One definition, because initializations,
 * transfers, returns and the history feed all render the same stamp and must not
 * drift into four slightly different readings of the same evidence.
 */
import type { BatchPhotoDto } from '@gct/shared';

export type PhotoRow = {
  id: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locationError: string | null;
  capturedAt: Date;
  serverAt: Date;
  userId: string;
  user: { name: string };
};

/** The relation shape every caller must include to build the DTO. */
export const photoInclude = { include: { user: { select: { name: true } } } } as const;

export const toPhotoDto = (p: PhotoRow): BatchPhotoDto => ({
  id: p.id,
  latitude: p.latitude,
  longitude: p.longitude,
  accuracyM: p.accuracyM,
  locationError: p.locationError,
  capturedAt: p.capturedAt.toISOString(),
  serverAt: p.serverAt.toISOString(),
  userId: p.userId,
  userName: p.user.name,
});
