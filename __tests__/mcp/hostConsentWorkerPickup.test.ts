/** #1369: an owner approval on a worker starts that server at once, without a restart. */
import { NextRequest } from 'next/server';

const approve = jest.fn();
const startApproved = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ resolveWorkspace: async () => 'cloud-worker' }));
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  ensureWorkspaceDirs: async () => undefined,
}));
jest.mock('@/backend/execution/extensions', () => ({ authorizeExecutionTransport: () => undefined }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/security/ownerAccess', () => ({
  resolveOwnerRequest: () => ({ ok: true, authorization: { principal: { ownerId: 'owner' }, recheck: () => undefined } }),
}));
jest.mock('@/backend/services/security/bundledMcpConsent', () => ({
  BundledConsentError: class extends Error {},
  approveBundledHostConsent: (...a: unknown[]) => approve(...a),
  previewBundledHostConsent: jest.fn(),
  revokeBundledHostConsent: jest.fn(),
}));
jest.mock('@/backend/services/workspace/workerMcpServers', () => ({
  startApprovedWorkerServer: (...a: unknown[]) => startApproved(...a),
}));

import { POST } from '@/app/api/mcp/servers/[name]/host-consent/route';
import { setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';

const post = () => POST(new NextRequest('http://worker/api/mcp/servers/filesystem/host-consent?workspace=cloud-worker', {
  method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
  body: JSON.stringify({ runtimeHome: 'host', reviewedDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000 }),
}), { params: Promise.resolve({ name: 'filesystem' }) });

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  approve.mockResolvedValue({ policyDigest: 'a'.repeat(64) });
  startApproved.mockResolvedValue({ name: 'filesystem', status: 'ready' });
});
afterEach(() => {
  delete process.env.FLUJO_WORKER_MODE;
  global.__flujo_worker_bootstrap_status = undefined;
});

it('starts the approved server on a worker right after the approval', async () => {
  process.env.FLUJO_WORKER_MODE = '1';
  setWorkerBootstrapStatus({ state: 'ready', workspace: 'cloud-worker' });
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ approved: true, serverName: 'filesystem' });
  await settle();
  expect(startApproved).toHaveBeenCalledWith('filesystem');
});

it('leaves a local installation alone', async () => {
  const response = await post();
  expect(response.status).toBe(200);
  await settle();
  expect(startApproved).not.toHaveBeenCalled();
});

it('does not start anything when the approval is refused', async () => {
  process.env.FLUJO_WORKER_MODE = '1';
  setWorkerBootstrapStatus({ state: 'ready', workspace: 'cloud-worker' });
  approve.mockRejectedValueOnce(new Error('The reviewed proposal changed.'));
  expect((await post()).status).toBe(409);
  await settle();
  expect(startApproved).not.toHaveBeenCalled();
});
