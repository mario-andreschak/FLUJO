/**
 * Regression test for issue #126: path traversal in conversation persistence.
 *
 * POST /v1/chat/conversations took `payload.id` (validated only as a non-empty
 * string) and joined it straight into a filesystem path via the single-file
 * storage API, so an id like "../encryption_key" escaped db/conversations/ and
 * overwrote an arbitrary .json file (e.g. the DEK metadata → every stored
 * secret becomes undecryptable).
 *
 * The fix validates the id (assertSafeCollectionId, ^[A-Za-z0-9_-]{1,64}$) and
 * returns 400 for anything else, and writes via the collection API which
 * resolves to the identical on-disk path for valid ids.
 *
 * Drives the real route handler against a throwaway temp data dir (via
 * FLUJO_DATA_DIR + jest.resetModules()), so the on-disk effect is real.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { makeLocalRequest } from '../utils/localRequest';

// The route is gated behind assertUnlocked; make it a pass-through so the lock
// gate doesn't short-circuit the request.
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));

let mockPersonaDeleted = false;
const mockGetPersona = jest.fn(async (_personaId: string) => ({
  id: 'persona-target',
  provisioningState: 'ready',
  lifecycleState: 'idle',
}));
const mockGetPersonaDeletionTombstone = jest.fn(async (_personaId: string) =>
  mockPersonaDeleted ? { status: 'completed' } : null);
jest.mock('@/backend/services/enduringAgents', () => ({
  getPersona: (personaId: string) => mockGetPersona(personaId),
  getPersonaDeletionTombstone: (personaId: string) =>
    mockGetPersonaDeletionTombstone(personaId),
}));

// The route imports a frontend component module only for a type; stub it so the
// test doesn't pull the React tree into a node test.
jest.mock('@/frontend/components/Chat', () => ({}));

type Route = typeof import('@/app/v1/chat/conversations/route');

let tmpDir: string;
let dbDir: string;
let POST: Route['POST'];
let withConversationExecutionLock:
  typeof import('@/backend/execution/flow/conversationExecutionLock').withConversationExecutionLock;

const exists = async (p: string) => {
  try { await fs.access(p); return true; } catch { return false; }
};

const makeReq = (body: unknown) => makeLocalRequest({ body });

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-conv-'));
  dbDir = path.join(tmpDir, 'workspaces', 'default-workspace', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  process.env.FLUJO_DATA_DIR = tmpDir;
  // STORAGE_DIR / data dir are resolved at module load, so re-import fresh.
  jest.resetModules();
  ({ POST } = await import('@/app/v1/chat/conversations/route'));
  ({ withConversationExecutionLock } = await import(
    '@/backend/execution/flow/conversationExecutionLock'
  ));
  mockPersonaDeleted = false;
  mockGetPersona.mockClear();
  mockGetPersonaDeletionTombstone.mockClear();
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('POST /v1/chat/conversations path-traversal guard (issue #126)', () => {
  it.each(['../encryption_key', '../models', 'a/../../x', '..', 'a/b', 'has space'])(
    'rejects malicious id %j with 400 and writes nothing outside db/conversations',
    async (badId) => {
      const res = await POST(makeReq({
        id: badId, title: 'x', flowId: 'flow-1', createdAt: 1, updatedAt: 1,
      }));
      expect(res.status).toBe(400);

      // No traversed file was created anywhere under db/.
      expect(await exists(path.join(dbDir, 'encryption_key.json'))).toBe(false);
      expect(await exists(path.join(dbDir, 'models.json'))).toBe(false);
      expect(await exists(path.join(dbDir, 'mcp_servers.json'))).toBe(false);
    });

  it('creates exactly the default workspace db/conversations/<id>.json for a valid uuid id (201)', async () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const res = await POST(makeReq({
      id, title: 'Hello', flowId: 'flow-1', createdAt: 1, updatedAt: 1,
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).source).toBe('chat');
    const conversationPath = path.join(dbDir, 'conversations', `${id}.json`);
    expect(await exists(conversationPath)).toBe(true);
    const stored = JSON.parse(await fs.readFile(conversationPath, 'utf-8'));
    expect(stored.source).toBe('chat');
    // And nothing leaked to the db root.
    expect(await exists(path.join(dbDir, 'encryption_key.json'))).toBe(false);
  });

  it('cannot overwrite an existing Persona conversation and strip its attribution', async () => {
    const id = 'persona-conversation';
    const conversationDir = path.join(dbDir, 'conversations');
    await fs.mkdir(conversationDir, { recursive: true });
    const original = {
      conversationId: id,
      title: 'Persona work',
      flowId: 'pinned-flow',
      messages: [],
      trackingInfo: { executionId: 'persona-run', startTime: 1, nodeExecutionTracker: [] },
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const conversationPath = path.join(conversationDir, `${id}.json`);
    await fs.writeFile(conversationPath, JSON.stringify(original), 'utf-8');

    const response = await POST(makeReq({
      id,
      title: 'Overwrite',
      flowId: 'mutable-flow',
      createdAt: 2,
      updatedAt: 2,
    }));

    expect(response.status).toBe(409);
    expect(JSON.parse(await fs.readFile(conversationPath, 'utf-8'))).toEqual(original);
  });

  it('waits for anonymization and cannot erase personaArchived with a stale legacy create', async () => {
    const id = 'conversation-create-archive-race';
    const conversationDir = path.join(dbDir, 'conversations');
    await fs.mkdir(conversationDir, { recursive: true });
    const conversationPath = path.join(conversationDir, `${id}.json`);
    await fs.writeFile(conversationPath, JSON.stringify({
      conversationId: id,
      title: 'Persona draft',
      flowId: '',
      personaTargetId: 'persona-target',
      messages: [],
      trackingInfo: { executionId: 'persona-run', startTime: 1, nodeExecutionTracker: [] },
      createdAt: 1,
      updatedAt: 1,
    }), 'utf-8');

    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const anonymization = withConversationExecutionLock(id, async () => {
      entered();
      await gate;
      const archived = JSON.parse(await fs.readFile(conversationPath, 'utf-8'));
      delete archived.personaTargetId;
      archived.personaArchived = true;
      await fs.writeFile(conversationPath, JSON.stringify(archived), 'utf-8');
    });
    await enteredLock;

    const create = POST(makeReq({
      id,
      title: 'Stale legacy overwrite',
      flowId: 'legacy-flow',
      createdAt: 2,
      updatedAt: 2,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await anonymization;

    const response = await create;
    expect(response.status).toBe(409);
    const durable = JSON.parse(await fs.readFile(conversationPath, 'utf-8'));
    expect(durable).toMatchObject({ personaArchived: true, title: 'Persona draft' });
    expect(durable).not.toHaveProperty('personaTargetId');
  });

  it('revalidates a Persona tombstone after waiting and never recreates its draft', async () => {
    const id = 'conversation-create-deleted-persona';
    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deletion = withConversationExecutionLock(id, async () => {
      entered();
      await gate;
    });
    await enteredLock;

    const create = POST(makeReq({
      id,
      title: 'Deleted Persona draft',
      flowId: null,
      personaTargetId: 'persona-target',
      createdAt: 1,
      updatedAt: 1,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    mockPersonaDeleted = true;
    release();
    await deletion;

    const response = await create;
    expect(response.status).toBe(409);
    expect(await exists(path.join(dbDir, 'conversations', `${id}.json`))).toBe(false);
  });

  it('rolls a Persona draft into a nonidentifying archive if deletion starts during save', async () => {
    const id = 'conversation-create-delete-after-validation';
    mockGetPersonaDeletionTombstone
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'deleting' });

    const response = await POST(makeReq({
      id,
      title: 'Racing Persona draft',
      flowId: null,
      personaTargetId: 'persona-target',
      createdAt: 1,
      updatedAt: 1,
    }));

    expect(response.status).toBe(409);
    const durable = JSON.parse(await fs.readFile(
      path.join(dbDir, 'conversations', `${id}.json`),
      'utf-8',
    ));
    expect(durable).toMatchObject({ personaArchived: true });
    expect(durable).not.toHaveProperty('personaTargetId');
  });
});
