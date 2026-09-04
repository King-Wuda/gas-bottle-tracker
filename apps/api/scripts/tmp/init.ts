import 'dotenv/config';
import { qrPayloadFor } from '../../src/services/qr.js';
const API = 'http://localhost:3000';
const args = process.argv.slice(2);
const batchId = args[0]!;
const serials = args.slice(1);
const login = (await (
  await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.local', password: 'password' }),
  })
).json()) as { accessToken: string };
const photo = () => ({
  imageBase64:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  capturedAt: new Date().toISOString(),
  latitude: -26.2041,
  longitude: 28.0473,
  accuracyM: 12,
  locationError: null,
});
const res = await fetch(`${API}/initializations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify({
    batchId,
    clientRequestId: crypto.randomUUID(),
    scans: serials.map((s) => ({
      serialCode: s,
      qrPayload: qrPayloadFor(s),
      scannedAt: new Date().toISOString(),
    })),
    photo: photo(),
  }),
});
console.log('init ->', res.status);
