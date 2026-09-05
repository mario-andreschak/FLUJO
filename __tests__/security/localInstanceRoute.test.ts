import { createHmac } from 'node:crypto';
import { GET } from '@/app/api/cloud/instance/route';

const token = 'synthetic-local-instance-proof-token-0123456789';
const instanceId = 'f3d2b631-9ab3-4c34-a16d-d352f0274034';
const origin = 'http://127.0.0.1:4200';
const nonce = 'a'.repeat(64);
const request = (headers: Record<string, string> = {}, challenge = nonce) => new Request(`${origin}/api/cloud/instance?nonce=${challenge}`, {
  headers: { host: '127.0.0.1:4200', ...headers },
});
beforeEach(() => {
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  process.env.FLUJO_LOCAL_INSTANCE_ID = instanceId;
  process.env.FLUJO_LOCAL_INSTANCE_ORIGIN = origin;
  process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = token;
  delete process.env.FLUJO_WORKER_MODE;
  delete process.env.FLUJO_CONTAINER;
});
afterEach(() => {
  for (const name of ['FLUJO_EXPOSURE_MODE', 'FLUJO_LOCAL_INSTANCE_ID', 'FLUJO_LOCAL_INSTANCE_ORIGIN', 'FLUJO_SNAPSHOT_CONTROL_TOKEN', 'FLUJO_WORKER_MODE', 'FLUJO_CONTAINER']) delete process.env[name];
});

it('returns only a bound HMAC proof without an unlock, migration, or workspace dependency', async () => {
  const response = GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body).toEqual({ format: 'flujo-local-instance-proof', version: 1, instanceId, origin, nonce,
    proof: createHmac('sha256', token).update(`flujo-local-instance:v1\n${nonce}\n${instanceId}\n${origin}`).digest('base64url') });
  expect(JSON.stringify(body)).not.toContain(token);
});

it.each<Record<string, string>>([
  { origin: 'https://example.invalid' }, { host: 'example.invalid' }, { 'x-forwarded-for': '10.0.0.1' },
])('rejects cross-origin, rebinding, and forwarded requests %j', async (headers) => {
  expect(GET(request(headers)).status).toBe(403);
});

it('rejects network exposure, malformed challenges, and unregistered runtimes', () => {
  process.env.FLUJO_EXPOSURE_MODE = 'network';
  expect(GET(request()).status).toBe(403);
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  expect(GET(request({}, 'bad')).status).toBe(400);
  delete process.env.FLUJO_LOCAL_INSTANCE_ID;
  expect(GET(request()).status).toBe(503);
});
