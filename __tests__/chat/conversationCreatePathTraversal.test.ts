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

// The route imports a frontend component module only for a type; stub it so the
// test doesn't pull the React tree into a node test.
jest.mock('@/frontend/components/Chat', () => ({}));

type Route = typeof import('@/app/v1/chat/conversations/route');

let tmpDir: string;
let dbDir: string;
let POST: Route['POST'];

const exists = async (p: string) => {
  try { await fs.access(p); return true; } catch { return false; }
};

const makeReq = (body: unknown) => makeLocalRequest({ body });

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-conv-'));
  dbDir = path.join(tmpDir, 'db');
  process.env.FLUJO_DATA_DIR = tmpDir;
  // STORAGE_DIR / data dir are resolved at module load, so re-import fresh.
  jest.resetModules();
  ({ POST } = await import('@/app/v1/chat/conversations/route'));
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

  it('creates exactly db/conversations/<id>.json for a valid uuid id (201)', async () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const res = await POST(makeReq({
      id, title: 'Hello', flowId: 'flow-1', createdAt: 1, updatedAt: 1,
    }));
    expect(res.status).toBe(201);
    expect(await exists(path.join(dbDir, 'conversations', `${id}.json`))).toBe(true);
    // And nothing leaked to the db root.
    expect(await exists(path.join(dbDir, 'encryption_key.json'))).toBe(false);
  });
});
