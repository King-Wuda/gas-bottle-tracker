import type { FastifyInstance } from 'fastify';
import { batchEventKindSchema, historyFeedQuerySchema, summariseLines } from '@gct/shared';
import type {
  BatchEventDetailResponse,
  BatchHistoryResponse,
  BatchPhotoImageResponse,
  CylinderHistoryResponse,
  HistoryBatchRef,
  HistoryFeedResponse,
  MovementEventDto,
} from '@gct/shared';
import { prisma } from '../db.js';
import { historyEvent, historyFeed } from '../services/historyFeed.js';
import { toPhotoDto } from '../services/photoView.js';
import { readFileAt } from '../services/storage.js';

/**
 * The audit trail — every read-only view of what has happened, and nothing that
 * changes it. There is no POST, PATCH or DELETE in this file, by design: History is
 * where you go to find out what occurred, and a section that could also rewrite the
 * record would be a hole in the accountability the whole system exists to provide.
 * Corrections happen in the admin console, and each one writes a `BatchAmendment`
 * that shows up here as another event.
 *
 * Four views, at three different grains:
 *   - `GET /history`            every CHANGE to any batch, newest first — the feed
 *   - `GET /history/events/...` one change, in full, including its photo's stamp
 *   - `GET /cylinders/:s/...`   one cylinder's life, oldest hop first
 *   - `GET /batches/:id/...`    every hop of one batch's cylinders
 *
 * All readable by any authenticated role: a technician who scanned a cylinder
 * yesterday needs to see where it went as much as a stores manager does.
 */

/** A NULL site on either end of a hop means Stores — the only non-Site location. */
const STORES = 'Stores';

type EventRow = {
  id: string;
  type: MovementEventDto['type'];
  cylinderId: string;
  fromSiteId: string | null;
  toSiteId: string | null;
  userId: string;
  transferId: string | null;
  returnRecordId: string | null;
  initializationId: string | null;
  deviceAt: Date;
  serverAt: Date;
  cylinder: { serialCode: string };
  user: { name: string };
  fromSite: { name: string } | null;
  toSite: { name: string } | null;
};

const eventInclude = {
  cylinder: { select: { serialCode: true } },
  user: { select: { name: true } },
  fromSite: { select: { name: true } },
  toSite: { select: { name: true } },
} as const;

function toEventDto(e: EventRow): MovementEventDto {
  return {
    id: e.id,
    type: e.type,
    cylinderId: e.cylinderId,
    serialCode: e.cylinder.serialCode,
    fromSiteId: e.fromSiteId,
    fromName: e.fromSite?.name ?? STORES,
    toSiteId: e.toSiteId,
    toName: e.toSite?.name ?? STORES,
    userId: e.userId,
    userName: e.user.name,
    transferId: e.transferId,
    returnRecordId: e.returnRecordId,
    initializationId: e.initializationId,
    deviceAt: e.deviceAt.toISOString(),
    serverAt: e.serverAt.toISOString(),
  };
}

type BatchRefRow = {
  id: string;
  projectId: string;
  project: { projectNumber: string };
  lines: { quantity: number; gasType: { name: string } }[];
};

const batchRefSelect = {
  id: true,
  projectId: true,
  project: { select: { projectNumber: true } },
  lines: {
    select: { quantity: true, gasType: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const;

const toBatchRef = (b: BatchRefRow): HistoryBatchRef => ({
  id: b.id,
  projectId: b.projectId,
  projectNumber: b.project.projectNumber,
  contents: summariseLines(
    b.lines.map((l) => ({ quantity: l.quantity, gasTypeName: l.gasType.name })),
  ),
});

/**
 * A batch can hold up to 500 cylinders, each with an INTAKE plus however many hops it
 * made, so the feed is capped. Newest-first ordering means the cap drops the oldest
 * activity, which is the half a "what happened lately" view can afford to lose.
 */
const BATCH_FEED_LIMIT = 500;

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * THE History feed: every change to any batch, newest first.
   *
   * Rows are events, not batches. A batch is a thing; History is about what happened
   * to it, and listing batches here made this a fourth copy of the Transfer/Returns
   * picker that happened to hide nothing. See `services/historyFeed.ts` for why the
   * rows are derived from the underlying records rather than read from a log table.
   */
  app.get('/history', { preHandler: app.authenticate }, async (req) => {
    const query = historyFeedQuerySchema.parse(req.query);
    const { events, truncated } = await historyFeed(query);
    const body: HistoryFeedResponse = { events, returned: events.length, truncated };
    return body;
  });

  /** One event, in full — every serial it touched, and its photo's stamp. */
  app.get('/history/events/:kind/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const params = req.params as { kind: string; id: string };
    const kind = batchEventKindSchema.safeParse(params.kind.toUpperCase());
    if (!kind.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_EVENT_KIND', message: `Unknown event kind ${params.kind}` },
      });
    }

    const event = await historyEvent(kind.data, params.id);
    if (!event) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found' } });
    }
    const body: BatchEventDetailResponse = { event };
    return body;
  });

  /**
   * One batch photo's bytes, base64 in a JSON envelope alongside its stamp.
   *
   * Base64 rather than a raw image response because every request to this API is
   * authenticated by an `Authorization` header, and an `<Image>` tag cannot send one —
   * on react-native-web it becomes a plain `<img src>`. The alternatives were a token
   * in the query string (which lands in access logs and browser history) or a second
   * cookie-based auth path; handing the bytes back through the same authenticated
   * fetch every other call uses is neither. It is one photo per request, loaded when
   * an event is opened, so the size is bounded by what a phone camera produced.
   */
  app.get('/batch-photos/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const photo = await prisma.batchPhoto.findUnique({
      where: { id },
      include: { user: { select: { name: true } } },
    });
    if (!photo) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Photo not found' } });
    }

    let bytes: Buffer;
    try {
      bytes = await readFileAt(photo.path);
    } catch {
      // The row is the record that a photo was taken; the file is a separate artefact
      // that a restore or a bad deploy can lose. Say which one is missing rather than
      // letting a 500 imply the event itself is broken.
      return reply.code(410).send({
        error: {
          code: 'PHOTO_FILE_MISSING',
          message: 'This photo was recorded but its image file is no longer in storage.',
        },
      });
    }

    const body: BatchPhotoImageResponse = {
      photo: toPhotoDto(photo),
      mimeType: photo.mimeType,
      imageBase64: bytes.toString('base64'),
    };
    return body;
  });

  /** One cylinder's life, oldest hop first. Looked up by the serial on its label. */
  app.get(
    '/cylinders/:serialCode/history',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const { serialCode } = req.params as { serialCode: string };

      const cylinder = await prisma.cylinder.findUnique({
        where: { serialCode: serialCode.trim().toUpperCase() },
        include: {
          currentSite: { select: { name: true } },
          batch: { select: batchRefSelect },
        },
      });
      if (!cylinder) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: `No cylinder with serial ${serialCode}` } });
      }

      // `[cylinderId, serverAt]` is indexed, so this is an ordered index scan.
      const events = await prisma.movementEvent.findMany({
        where: { cylinderId: cylinder.id },
        include: eventInclude,
        orderBy: { serverAt: 'asc' },
      });

      const body: CylinderHistoryResponse = {
        cylinder: {
          id: cylinder.id,
          serialCode: cylinder.serialCode,
          status: cylinder.status,
          currentSiteId: cylinder.currentSiteId,
          // A RETURNED cylinder has no site and is not "in stores" either; say so plainly
          // rather than letting the null read as a location it never went back to.
          currentLocation:
            cylinder.status === 'RETURNED'
              ? 'Returned to supplier'
              : (cylinder.currentSite?.name ?? STORES),
        },
        batch: toBatchRef(cylinder.batch),
        events: events.map(toEventDto),
      };
      return body;
    },
  );

  /** Every hop any cylinder in one batch made, newest first — the batch activity feed. */
  app.get('/batches/:id/history', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const batch = await prisma.batch.findUnique({ where: { id }, select: batchRefSelect });
    if (!batch) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
    }

    const events = await prisma.movementEvent.findMany({
      where: { cylinder: { batchId: id } },
      include: eventInclude,
      // serverAt alone is ambiguous within a transaction — every event one transfer
      // wrote shares a timestamp. Serial breaks the tie so the order is stable across
      // requests and the list does not reshuffle on refresh.
      orderBy: [{ serverAt: 'desc' }, { cylinder: { serialCode: 'asc' } }],
      take: BATCH_FEED_LIMIT,
    });

    const body: BatchHistoryResponse = { batch: toBatchRef(batch), events: events.map(toEventDto) };
    return body;
  });
}
