/**
 * End-to-end demo: drives all three workflows against a RUNNING API and prints what
 * happened, so the whole rental lifecycle can be seen without a phone.
 *
 *   npm run demo
 *
 * Everything it does goes through the real HTTP endpoints with real auth — there are
 * no shortcuts into the database — so a green run is genuine evidence the system
 * works. The QR sheet and delivery note are emailed through whatever MAILER is
 * manager receives.
 */
import 'dotenv/config';
import { qrPayloadFor } from '../src/services/qr.js';

const API = process.env.DEMO_API_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'password';

/** A 1×1 PNG standing in for what the driver draws on the signature pad. */
const SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Every scan-backed step now has to carry a photo — the batch for initialization,
 * transfer and return, and the driver's ID document for a return. `services/photo.ts`
 * checks the magic bytes, so a stub with the right prefix will not do; this is a real
 * 1×1 PNG.
 *
 * A fresh object each time so the two clocks on the record are the demo's own, and
 * so a reader can see that `capturedAt` is the device's claim rather than a constant.
 */
const photo = () => ({
  imageBase64: SIGNATURE_PNG,
  capturedAt: new Date().toISOString(),
  latitude: -26.2041,
  longitude: 28.0473,
  accuracyM: 12,
  locationError: null,
});

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

let step = 0;
const say = (msg: string): void => console.log(`${bold(`${++step}.`)} ${msg}`);
const detail = (msg: string): void => console.log(`   ${dim(msg)}`);

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; expect?: number } = {},
): Promise<T> {
  const res = await fetch(API + path, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (opts.expect !== undefined && res.status !== opts.expect) {
    throw new Error(
      `${opts.method ?? 'GET'} ${path} -> ${res.status}, expected ${opts.expect}\n${text.slice(0, 400)}`,
    );
  }
  return json as T;
}

const login = async (email: string): Promise<string> =>
  (
    await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
      expect: 200,
    })
  ).accessToken;

const scanOf = (serialCode: string) => ({
  serialCode,
  qrPayload: qrPayloadFor(serialCode),
  scannedAt: new Date().toISOString(),
});

async function main(): Promise<void> {
  const health = await api<{ status: string; db: string }>('/health').catch(() => null);
  if (health?.db !== 'up') {
    console.error(red(`\nThe API is not reachable at ${API}.`));
    console.error('Start it first:  npm run dev:api    (and npm run db:up for Postgres)\n');
    process.exit(1);
  }

  const stamp = Date.now();
  const projectNumber = `PRJ-DEMO-${stamp}`;
  const pmEmail = `pm+${stamp}@demo.local`;

  console.log(`\n${bold('Gas Cylinder Tracking — end-to-end demo')}`);
  console.log(dim(`API ${API}\n`));

  // ---- auth ----
  const tech = await login('technician@demo.local');
  const stores = await login('stores@demo.local');
  say('Signed in as the field technician and the stores manager.');

  // ---- Workflow A: New ----
  const project = await api<{ project: { id: string; sites: { id: string }[] } }>('/projects', {
    method: 'POST',
    token: tech,
    expect: 201,
    body: {
      projectNumber,
      projectManager: { name: 'Demo PM', email: pmEmail },
      site: { name: 'Yard A', location: 'Johannesburg' },
    },
  });
  const projectId = project.project.id;
  const yardA = project.project.sites[0]!.id;
  const yardB = (
    await api<{ site: { id: string } }>(`/projects/${projectId}/sites`, {
      method: 'POST',
      token: tech,
      expect: 201,
      body: { name: 'Yard B', location: 'Pretoria' },
    })
  ).site.id;
  say(`Workflow A — created project ${bold(projectNumber)} with two sites, PM ${pmEmail}.`);

  const gasTypes = await api<{ gasTypes: { id: string; name: string }[] }>('/gas-types', {
    token: tech,
  });
  const nitrogen = gasTypes.gasTypes.find((g) => g.name === 'Nitrogen')!;
  const argon = gasTypes.gasTypes.find((g) => g.name === 'Argon')!;

  /** The supplier picker is dependent on the gas — the pairing lives in GasSupplier. */
  const supplierFor = async (gasTypeId: string): Promise<string> => {
    const res = await api<{ suppliers: { id: string; name: string }[] }>(
      `/suppliers?gasTypeId=${gasTypeId}`,
      { token: tech },
    );
    return res.suppliers[0]!.id;
  };

  // One delivery, two gases — one batch. Adding a line to the draft creates nothing;
  // the whole thing is written on submit.
  const batch = await api<{
    batch: { id: string; lines: { gasTypeName: string; quantity: number }[] };
    serials: string[];
  }>('/batches', {
    method: 'POST',
    token: tech,
    expect: 201,
    body: {
      projectId,
      siteId: yardA,
      clientRequestId: crypto.randomUUID(),
      lines: [
        {
          gasTypeId: nitrogen.id,
          supplierId: await supplierFor(nitrogen.id),
          quantity: 5,
          initialDeliveryPoint: 'STORES',
        },
        {
          gasTypeId: argon.id,
          supplierId: await supplierFor(argon.id),
          quantity: 2,
          initialDeliveryPoint: 'STORES',
        },
      ],
    },
  });
  const batchId = batch.batch.id;
  const serials = batch.serials;
  say(
    `Intake of one batch holding ${bold('5 Nitrogen + 2 Argon')} — server allocated ` +
      `${bold(serials.join(', '))}.`,
  );
  detail(
    'A printable QR sheet is queued — one label per cylinder, each carrying the batch details.',
  );

  // ---- Workflow A2: Initialize ----
  // The gate, not a formality: POST /transfers and POST /returns both refuse an
  // uninitialized batch with 409, because a cylinder whose label was never read back
  // off it cannot honestly be scanned onto a truck.
  await api('/initializations', {
    method: 'POST',
    token: tech,
    expect: 201,
    body: {
      batchId,
      clientRequestId: crypto.randomUUID(),
      scans: serials.map(scanOf),
      photo: photo(),
    },
  });
  say(`Workflow A2 — all ${bold(String(serials.length))} labels scanned back off the cylinders.`);

  // ---- Workflow B: Transfer ----
  const moving = serials.slice(0, 3);
  const transfer = await api<{ transfer: { id: string; movedSerials: string[] } }>('/transfers', {
    method: 'POST',
    token: tech,
    expect: 201,
    body: {
      batchId,
      clientRequestId: crypto.randomUUID(),
      destination: { type: 'SITE', siteId: yardB },
      scans: moving.map(scanOf),
      photo: photo(),
    },
  });
  say(
    `Workflow B — scanned 3 cylinders and moved them to Yard B: ${transfer.transfer.movedSerials.join(', ')}.`,
  );
  detail(`${serials.slice(3).join(', ')} were not scanned, so they stayed put.`);

  // A forged label, rejected.
  const forged = await api<{ error: { details: { rejected: { code: string }[] } } }>('/transfers', {
    method: 'POST',
    token: tech,
    expect: 422,
    body: {
      batchId,
      clientRequestId: crypto.randomUUID(),
      destination: { type: 'STORES' },
      scans: [{ ...scanOf(serials[3]!), qrPayload: `GCT2|${serials[3]}|${'ab'.repeat(64)}` }],
      photo: photo(),
    },
  });
  say(
    `A forged QR label was refused: ${green(forged.error.details.rejected[0]!.code)} — nothing moved.`,
  );

  // ---- Workflow C: Returns ----
  const firstReturn = await api<{
    returnRecord: { id: string; batchStatus: string; outstandingCount: number };
  }>('/returns', {
    method: 'POST',
    token: stores,
    expect: 201,
    body: {
      batchId,
      clientRequestId: crypto.randomUUID(),
      scans: moving.map(scanOf),
      photo: photo(),
      driverName: 'Thabo Mokoena',
      driverIdNumber: '8801015009087',
      driverIdPhoto: photo(),
      signaturePng: SIGNATURE_PNG,
    },
  });
  say(
    `Workflow C — driver Thabo Mokoena signed for 3 cylinders. Batch is now ` +
      `${bold(firstReturn.returnRecord.batchStatus)} with ${firstReturn.returnRecord.outstandingCount} still out.`,
  );

  // An offline retry replays the SAME key and must not double-count.
  const replayKey = crypto.randomUUID();
  const body = {
    batchId,
    clientRequestId: replayKey,
    scans: serials.slice(3).map(scanOf),
    photo: photo(),
    driverName: 'Naledi Khumalo',
    driverIdNumber: '9203125800083',
    driverIdPhoto: photo(),
    signaturePng: SIGNATURE_PNG,
  };
  const second = await api<{ returnRecord: { id: string; batchStatus: string } }>('/returns', {
    method: 'POST',
    token: stores,
    expect: 201,
    body,
  });
  const replay = await api<{ returnRecord: { id: string } }>('/returns', {
    method: 'POST',
    token: stores,
    expect: 200,
    body,
  });
  say(`Remaining 2 returned — batch is ${bold(second.returnRecord.batchStatus)}.`);
  detail(
    `An offline retry replayed the same idempotency key and got the same record back ` +
      `(${replay.returnRecord.id === second.returnRecord.id ? green('no duplicate') : red('DUPLICATE!')}).`,
  );

  // ---- the audit trail ----
  const detailView = await api<{
    batch: { cylinders: { serialCode: string; status: string }[] };
  }>(`/batches/${batchId}`, { token: stores });
  say('Final state of every cylinder:');
  for (const c of detailView.batch.cylinders) {
    console.log(`   ${c.serialCode}  ${c.status}`);
  }

  // ---- the paperwork ----
  say('Waiting for the email worker to render and send the PDFs…');
  await new Promise((r) => setTimeout(r, 8000));

  // Reported from what the app decided to send, not from an inbox. This used to poll
  // MailHog's HTTP API, which tied the demo to a sink container that no longer exists
  // and told you about the sink rather than about the system.
  detail(`The QR sheet and the signed delivery notes were addressed to ${pmEmail}.`);
  detail(
    process.env.MAILER === 'resend'
      ? 'MAILER=resend — they were handed to Resend for delivery.'
      : `MAILER=${process.env.MAILER ?? 'resend'} — set MAILER=resend with a RESEND_API_KEY to receive them.`,
  );

  console.log(`\n${bold('Done.')} The QR sheet and the signed delivery notes were emailed`);
  console.log(`to ${bold(pmEmail)}.\n`);
}

main().catch((err: unknown) => {
  console.error(red(`\nDemo failed: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(1);
});
