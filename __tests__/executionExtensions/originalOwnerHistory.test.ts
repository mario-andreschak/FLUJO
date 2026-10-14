import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installOwnerFixture } from '../utils/ownerFixture';
import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';
import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { createOwnerSession } from '@/backend/services/security/ownerSession';
import { issueOwnerCredential, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { withOriginalOwnerHistoryAccess, assertOriginalOwnerHistoryAccess } from '@/backend/services/originalOwner/history';
import { readOriginalOwnerBook } from '@/backend/services/originalOwner/store';
import { ownerDigest, type OriginalOwnerBook } from '@/backend/services/originalOwner/types';
import { assertExecutionStateAccess, assertExecutionExtensionCurrent, executionExtensionSinglePhysicalAttempt } from '@/backend/execution/extensions';

jest.mock('@/backend/services/originalOwner/store', () => ({ readOriginalOwnerBook: jest.fn() }));

let directory: string;
let owner: Awaited<ReturnType<typeof installOwnerFixture>>;
let book: OriginalOwnerBook;
let state: {
  conversationId: string; logicalRunId: string; executionExtensionOwned: boolean; flowId: string;
  flowSnapshot: { id: string }; personaAttribution: { personaId: string; activityId: string; behaviorRevisionId: string };
};
let previousWorker: string | undefined;
let previousOrigin: string | undefined;
const origin = 'http://localhost:4200';
const conversationId = 'original-history-conversation';
const request = (method = 'GET', headers: Record<string, string> = owner.headers) => new Request(
  `${origin}/v1/chat/conversations/${conversationId}/model-turns`,
  { method, headers: { host: 'localhost:4200', origin, ...headers } },
);
const inspect = () => assertOriginalOwnerHistoryAccess(state, conversationId);
const policyFile = () => path.join(directory, 'test-owner-policy.json');
async function changePolicy(task: (policy: OwnerPolicy) => void) {
  const policy = JSON.parse(await fs.readFile(policyFile(), 'utf8')) as OwnerPolicy;
  task(policy);
  await fs.writeFile(policyFile(), JSON.stringify(policy), { mode: 0o600 });
}

beforeEach(async () => {
  previousWorker = process.env.FLUJO_WORKER_MODE;
  previousOrigin = process.env.FLUJO_OWNER_BROWSER_ORIGIN;
  delete process.env.FLUJO_WORKER_MODE;
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = origin;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-original-owner-history-'));
  owner = await installOwnerFixture(directory);
  const approval = { ownerId: 'fixture-owner', credentialId: 'historical-owner-credential', policyRevision: ownerDigest('old policy') };
  book = { version: 1, accounts: [{ id: 'account', ownerId: 'fixture-owner', modelId: 'model',
    kind: 'openai', modelDigest: ownerDigest('model'), credential: 'encrypted:private-history-fixture',
    routingHeaders: {}, state: 'revoked', approval, createdAt: 1, updatedAt: 2 }],
  enrollments: [{ id: 'enrollment', workspace: getCurrentWorkspace(), ownerId: 'fixture-owner', personaId: 'persona', taskId: 'task',
    accountId: 'account', modelId: 'model', workerAuthorizationDigest: ownerDigest('old worker'),
    budget: { maxModelSteps: null, maxOutputTokens: null }, approval, allowedTools: [], commands: [],
    state: 'revoked', createdAt: 1, updatedAt: 2 }], steps: [],
  runs: [{ id: ownerDigest('genuine original run'), enrollmentId: 'enrollment', ownerId: 'fixture-owner',
    workspace: getCurrentWorkspace(), personaId: 'persona', taskId: 'task', activityId: 'activity', dispatchId: 'dispatch',
    revisionId: 'revision', conversationId, runId: 'run', modelId: 'model', modelDigest: ownerDigest('model'),
    flowId: 'flow', planDigest: ownerDigest('frozen flow'), createdAt: 1 }] };
  state = { conversationId, logicalRunId: 'run', executionExtensionOwned: true, flowId: 'flow', flowSnapshot: { id: 'flow' },
    personaAttribution: { personaId: 'persona', activityId: 'activity', behaviorRevisionId: 'revision' } };
  jest.mocked(readOriginalOwnerBook).mockReset().mockImplementation(async () => book);
});
afterEach(async () => {
  await owner.restore();
  if (previousWorker === undefined) delete process.env.FLUJO_WORKER_MODE;
  else process.env.FLUJO_WORKER_MODE = previousWorker;
  if (previousOrigin === undefined) delete process.env.FLUJO_OWNER_BROWSER_ORIGIN;
  else process.env.FLUJO_OWNER_BROWSER_ORIGIN = previousOrigin;
  await fs.rm(directory, { recursive: true, force: true });
});

it('reads genuine Original history with a current owner after account and enrollment revocation', async () => {
  await expect(inspect()).resolves.toBe(false);
  await withOriginalOwnerHistoryAccess(request(), async () => {
    await expect(inspect()).resolves.toBe(true);
    await expect(assertExecutionStateAccess(state, conversationId)).resolves.toBeUndefined();
    expect(state).not.toHaveProperty('executionAuthority');
    expect(state).not.toHaveProperty('executionExtensionContext');
  });
  await expect(inspect()).resolves.toBe(false);
});

it('accepts a real current owner browser cookie as well as a bearer', async () => {
  const resolved = resolveOwnerRequest(request(), ['control:admin', 'secrets:read'], { requireBearer: true });
  if (!resolved.ok) throw new Error('Fixture owner authorization failed');
  const cookie = createOwnerSession(request('POST'), resolved.authorization.principal).split(';')[0];
  await withOriginalOwnerHistoryAccess(request('GET', { cookie }), async () => {
    await expect(assertExecutionStateAccess(state, conversationId)).resolves.toBeUndefined();
  });
});

it('refuses forged owner identity headers, an invalid bearer, and insufficient scopes', async () => {
  const limited = issueOwnerCredential(['openai:read'], Date.now() + 60_000);
  await changePolicy(policy => { policy.credentials.push(limited.record); });
  const invalid: Record<string, string>[] = [
    { authorization: 'Bearer forged', 'x-flujo-owner': 'fixture-owner' },
    { authorization: `Bearer ${limited.token}` },
  ];
  for (const headers of invalid) {
    await withOriginalOwnerHistoryAccess(request('GET', headers), async () => {
      await expect(assertExecutionStateAccess(state, conversationId))
        .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    });
  }
  expect(readOriginalOwnerBook).not.toHaveBeenCalled();
});

it('does not grant Controller or Worker DTO history without a private genuine run claim', async () => {
  const privateRun = book.runs![0];
  book.runs = undefined;
  const dto = { ...state, originalOwnerRun: privateRun, ownerId: 'fixture-owner' };
  await withOriginalOwnerHistoryAccess(request(), async () => {
    await expect(assertExecutionStateAccess(dto, conversationId))
      .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
  });
  book.runs = [privateRun];
  process.env.FLUJO_WORKER_MODE = '1';
  await withOriginalOwnerHistoryAccess(request(), async () => { await expect(inspect()).resolves.toBe(false); });
});

it.each(['owner', 'enrollment-owner', 'account-owner', 'workspace', 'persona', 'activity', 'revision', 'run', 'flow', 'model'] as const)
  ('refuses a mismatched %s in the private run and saved state join', async mismatch => {
    if (mismatch === 'owner') book.runs![0].ownerId = 'another-owner';
    if (mismatch === 'enrollment-owner') book.enrollments[0].ownerId = 'another-owner';
    if (mismatch === 'account-owner') book.accounts[0].ownerId = 'another-owner';
    if (mismatch === 'workspace') book.runs![0].workspace = 'another-workspace';
    if (mismatch === 'persona') state.personaAttribution.personaId = 'another-persona';
    if (mismatch === 'activity') state.personaAttribution.activityId = 'another-activity';
    if (mismatch === 'revision') state.personaAttribution.behaviorRevisionId = 'another-revision';
    if (mismatch === 'run') state.logicalRunId = 'another-run';
    if (mismatch === 'flow') state.flowSnapshot.id = 'another-flow';
    if (mismatch === 'model') book.accounts[0].modelDigest = ownerDigest('another-model');
    await withOriginalOwnerHistoryAccess(request(), async () => { await expect(inspect()).resolves.toBe(false); });
  });

it('rejects a freshly authenticated different owner and a workspace switch inside a read scope', async () => {
  await changePolicy(policy => { policy.ownerId = 'another-owner'; });
  await withOriginalOwnerHistoryAccess(request(), async () => { await expect(inspect()).resolves.toBe(false); });
  await changePolicy(policy => { policy.ownerId = 'fixture-owner'; });
  await withOriginalOwnerHistoryAccess(request(), async () => {
    await runWithWorkspace('another-workspace', async () => { await expect(inspect()).resolves.toBe(false); });
  });
});

it('rechecks current authorization on every read and after the private book read', async () => {
  await withOriginalOwnerHistoryAccess(request(), async () => {
    await expect(inspect()).resolves.toBe(true);
    await changePolicy(policy => { policy.credentials[0].revokedAt = Date.now(); });
    await expect(inspect()).resolves.toBe(false);
  });
  expect(readOriginalOwnerBook).toHaveBeenCalledTimes(1);
  await changePolicy(policy => { policy.credentials[0].revokedAt = null; });
  jest.mocked(readOriginalOwnerBook).mockImplementationOnce(async () => {
    await changePolicy(policy => { policy.credentials[0].revokedAt = Date.now(); });
    return book;
  });
  await withOriginalOwnerHistoryAccess(request(), async () => { await expect(inspect()).resolves.toBe(false); });
});

it('cannot turn history access into a POST scope or runtime/model authority', async () => {
  await withOriginalOwnerHistoryAccess(request(), async () => {
    await expect(inspect()).resolves.toBe(true);
    await withOriginalOwnerHistoryAccess(request('POST'), async () => { await expect(inspect()).resolves.toBe(false); });
    await expect(assertExecutionExtensionCurrent(undefined)).rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    await expect(executionExtensionSinglePhysicalAttempt(undefined, { id: 'model', name: 'fixture', adapter: 'openai',
      provider: 'openai', ApiKey: '', ownerCredentialBinding: { ownerId: 'fixture-owner', credentialId: 'account' } }))
      .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
  });
});

it('does not inspect an Original book for ordinary conversation state', async () => {
  await withOriginalOwnerHistoryAccess(request(), async () => {
    await expect(assertExecutionStateAccess({ conversationId: 'ordinary' }, 'ordinary')).resolves.toBeUndefined();
  });
  expect(readOriginalOwnerBook).not.toHaveBeenCalled();
});
