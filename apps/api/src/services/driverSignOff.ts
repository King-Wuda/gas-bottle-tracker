import { driverFullName } from '@gct/shared';
import { prisma } from '../db.js';
import { decodeSignaturePng, InvalidSignatureError, saveSignature } from './signature.js';

/**
 * The identity half of a movement: who took the cylinders, and their signature.
 *
 * Shared by transfers and returns because both hand physical cylinders to a named
 * person who is not the operator.
 *
 * The driver is either a registered profile (`driverId`) or someone typed in on the
 * spot. For a registered driver the profile is the authority: its name, email and
 * phone are copied onto the record, whatever the client sent, so a stale cache on a
 * phone cannot record an old number. If the profile has gone by the time the
 * submission arrives — an offline outbox row can sit for hours — the details the
 * client sent are recorded as an unregistered driver's rather than refusing a
 * delivery that has already physically happened.
 *
 * Everything here is filesystem (or database) IO, so it is called BEFORE the
 * transaction: holding a row lock across a blob write would widen the contended
 * window for no reason. The signature filename derives from the idempotency key, so a
 * retry overwrites its own file rather than accumulating one per attempt.
 */
export interface DriverDetails {
  driverId: string | null;
  driverName: string;
  driverEmail: string;
  driverPhone: string;
}

export type PreparedDriverSignOff =
  | { ok: true; signaturePath: string; driver: DriverDetails }
  | { ok: false; status: number; code: string; message: string };

export async function prepareDriverSignOff(args: {
  clientRequestId: string;
  signaturePng: string;
  driver: DriverDetails;
}): Promise<PreparedDriverSignOff> {
  let signaturePath: string;
  try {
    signaturePath = await saveSignature(
      args.clientRequestId,
      decodeSignaturePng(args.signaturePng),
    );
  } catch (err) {
    if (err instanceof InvalidSignatureError) {
      return { ok: false, status: 400, code: 'INVALID_SIGNATURE', message: err.message };
    }
    throw err;
  }

  return { ok: true, signaturePath, driver: await resolveDriver(args.driver) };
}

/** The details to record: the profile's when there is one, the typed ones otherwise. */
export async function resolveDriver(sent: DriverDetails): Promise<DriverDetails> {
  if (!sent.driverId) return { ...sent, driverId: null };
  const profile = await prisma.driver.findUnique({ where: { id: sent.driverId } });
  if (!profile) return { ...sent, driverId: null };
  return {
    driverId: profile.id,
    driverName: driverFullName(profile),
    driverEmail: profile.email,
    driverPhone: profile.phone,
  };
}
