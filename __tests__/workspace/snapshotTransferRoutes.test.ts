import { createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import type { CapturedWorkspaceSnapshot } from '@/backend/services/workspace/snapshotArchive';

const mockCapture = jest.fn<Promise<CapturedWorkspaceSnapshot>, unknown[]>();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/workspace/snapshotArchive', () => ({
  ...jest.requireActual('@/backend/services/workspace/snapshotArchive'),
  captureWorkspaceSnapshot: (...args: unknown[]) => mockCapture(...args),
}));

import { POST as begin } from '@/app/api/snapshot/begin/route';
import { GET as info } from '@/app/api/snapshot/info/route';
import { GET as download } from '@/app/api/snapshot/download/route';
import { snapshotCoordinator } from '@/backend/services/workspace/snapshotCoordinator';
import { decryptSnapshotEnvelope } from '@/backend/services/workspace/snapshotEnvelope';
import { getCurrentWorkspace } from '@/utils/workspace';

const token = randomBytes(32).toString('hex');
let priorToken: string | undefined;
const request = (body: unknown, supplied = token) => new NextRequest('http://127.0.0.1:4200/api/snapshot/begin', {
  method: 'POST', headers: { host: '127.0.0.1:4200', authorization: `Bearer ${supplied}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  priorToken = process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = token;
  mockCapture.mockReset();
});

afterEach(async () => {
  const workspace = getCurrentWorkspace();
  const active = global.__flujoWorkspaceSnapshotSessions?.get(workspace);
  if (active && active.state !== 'finalized') await snapshotCoordinator.abort(active.sessionId, workspace);
  global.__flujoWorkspaceSnapshotSessions?.clear();
  if (priorToken === undefined) delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  else process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = priorToken;
});

test.each([{}, { recipientKey: 42 }, { recipientKey: 'FLUJO~' }])('recipient preflight #%# refuses before capture and never returns key material', async body => {
  const response = await begin(request(body));
  expect(response.status).toBe(400);
  expect(mockCapture).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain('FLUJO~');
});

test('the existing control bearer remains required before recipient processing', async () => {
  const response = await begin(request({ recipientKey: randomBytes(32).toString('base64') }, 'wrong-token'));
  expect(response.status).toBe(401);
  expect(mockCapture).not.toHaveBeenCalled();
});

test('actual begin, encrypted persistence, download headers and recipient decryption compose', async () => {
  const zip = new JSZip();
  zip.file('db/worker-bootstrap-secrets.json', 'synthetic-private-bootstrap');
  mockCapture.mockResolvedValue({ zip, files: 1, bytes: 27 } as CapturedWorkspaceSnapshot);
  const key = randomBytes(32).toString('base64');
  const advertisement = await info(new NextRequest('http://127.0.0.1:4200/api/snapshot/info', {
    headers: { host: '127.0.0.1:4200', authorization: `Bearer ${token}` },
  }));
  expect(advertisement.status).toBe(200);
  const capability = (await advertisement.json()).workerCompatibility;
  expect(capability.snapshotEncryption).toMatchObject({ writeVersion: 2, recipientKeyRequired: true,
    recipientKeyBytes: 32, cipher: 'aes-256-gcm', v2Digest: 'sha256-encrypted-wire' });
  expect(mockCapture).not.toHaveBeenCalled();
  const response = await begin(request({ recipientKey: key, flowIds: ['selected-flow'] }));
  expect(response.status).toBe(202);
  const initial = await response.json();
  expect(JSON.stringify(initial)).not.toContain(key);
  expect(mockCapture.mock.calls[0][2]).toMatchObject({ flowIds: ['selected-flow'] });
  let status = await snapshotCoordinator.status(initial.sessionId);
  for (let count = 0; status.state !== 'ready' && count < 100; count++) {
    if (status.state === 'failed') throw new Error('Source transfer fixture failed');
    await new Promise(resolve => setTimeout(resolve, 10));
    status = await snapshotCoordinator.status(initial.sessionId);
  }
  expect(status.state).toBe('ready');
  const stagingDir = global.__flujoWorkspaceSnapshotSessions?.get(getCurrentWorkspace())?.stagingDir;
  expect(stagingDir).toBeDefined();
  const result = await download(new NextRequest(`http://127.0.0.1:4200/api/snapshot/download?sessionId=${initial.sessionId}`, {
    headers: { host: '127.0.0.1:4200', authorization: `Bearer ${token}` },
  }));
  expect(result.status).toBe(200);
  expect(result.headers.get('content-type')).toBe('application/vnd.flujo.workspace-snapshot+json');
  expect(result.headers.get('content-disposition')).toContain('.encrypted.json');
  const wire = Buffer.from(await result.arrayBuffer());
  expect(wire.length).toBeLessThanOrEqual(capability.snapshotLimits.maxEncryptedBytes);
  const fields = JSON.parse(wire.toString());
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(fields.iv, 'base64'));
  decipher.setAAD(Buffer.from(capability.snapshotEncryption.v2Aad));
  decipher.setAuthTag(Buffer.from(fields.tag, 'base64'));
  const independent = Buffer.concat([decipher.update(Buffer.from(fields.data, 'base64')), decipher.final()]);
  expect(wire.toString()).not.toContain('synthetic-private-bootstrap');
  const restored = await JSZip.loadAsync(decryptSnapshotEnvelope(wire, key, 1024 * 1024).bytes);
  expect(independent).toEqual(decryptSnapshotEnvelope(wire, key, 1024 * 1024).bytes);
  expect(await restored.file('db/worker-bootstrap-secrets.json')!.async('string')).toBe('synthetic-private-bootstrap');
  await snapshotCoordinator.finalize(initial.sessionId);
  await expect(fs.lstat(stagingDir!)).rejects.toMatchObject({ code: 'ENOENT' });
});
