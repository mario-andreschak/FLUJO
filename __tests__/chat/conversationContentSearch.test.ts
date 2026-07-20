/**
 * Tests for the conversation-list content search + chain projection (issue #182).
 *
 * GET /v1/chat/conversations gained:
 *  - `?dimension=content&search=<term>`: a server-side scan of message BODIES
 *    (which aren't all resident on the client), returning only the id/metadata
 *    of matching conversations — never the matched text itself.
 *  - `parentConversationId` / `rootConversationId` on each list item, so the
 *    sidebar can render Flow->Subflow->... chains.
 *
 * Drives the real route handler against a throwaway temp data dir (via
 * FLUJO_DATA_DIR + jest.resetModules()), mirroring conversationCreatePathTraversal.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { makeLocalRequest } from '../utils/localRequest';

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));
// The route imports a frontend component module only for a type; stub it so the
// test doesn't pull the React tree into a node test.
jest.mock('@/frontend/components/Chat', () => ({}));

type Route = typeof import('@/app/v1/chat/conversations/route');

let tmpDir: string;
let convDir: string;
let GET: Route['GET'];

const writeConv = async (id: string, obj: Record<string, unknown>) => {
  await fs.writeFile(
    path.join(convDir, `${id}.json`),
    JSON.stringify({ conversationId: id, status: 'completed', flowId: 'flow-1', createdAt: 1, updatedAt: 1, ...obj }),
    'utf-8',
  );
};

const getJson = async (query = '') => {
  const res = await GET(makeLocalRequest({ url: `http://localhost:4200/v1/chat/conversations${query}` }));
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-conv-search-'));
  convDir = path.join(tmpDir, 'db', 'conversations');
  await fs.mkdir(convDir, { recursive: true });
  process.env.FLUJO_DATA_DIR = tmpDir;
  jest.resetModules();
  ({ GET } = await import('@/app/v1/chat/conversations/route'));
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /v1/chat/conversations content search (issue #182)', () => {
  it('matches against message content and returns only matching ids', async () => {
    await writeConv('hit', { title: 'Alpha', messages: [{ role: 'user', content: 'a needle in the haystack' }] });
    await writeConv('miss', { title: 'Beta', messages: [{ role: 'user', content: 'nothing relevant here' }] });

    const { status, body } = await getJson('?search=needle&dimension=content');
    expect(status).toBe(200);
    expect(body.map((c: any) => c.id)).toEqual(['hit']);
  });

  it('is case-insensitive and matches multimodal (array) content', async () => {
    await writeConv('multi', {
      title: 'Gamma',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'The SECRET password' }] }],
    });
    const { body } = await getJson('?search=secret&dimension=content');
    expect(body.map((c: any) => c.id)).toEqual(['multi']);
  });

  it('never leaks message bodies in the response', async () => {
    await writeConv('hit', { title: 'Alpha', messages: [{ role: 'user', content: 'a needle here' }] });
    const { body } = await getJson('?search=needle&dimension=content');
    expect(body).toHaveLength(1);
    expect('messages' in body[0]).toBe(false);
    expect(JSON.stringify(body[0])).not.toContain('needle');
  });

  it('does NOT scan content for the default (title) dimension — returns all items', async () => {
    await writeConv('a', { title: 'Alpha', messages: [{ role: 'user', content: 'needle' }] });
    await writeConv('b', { title: 'Beta', messages: [{ role: 'user', content: 'plain' }] });
    // dimension defaults to title; the backend returns the full list and the
    // client does title filtering itself.
    const { body } = await getJson('?search=needle');
    expect(body.map((c: any) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('rejects an over-long search term with 400', async () => {
    const term = 'x'.repeat(300);
    const { status } = await getJson(`?search=${term}&dimension=content`);
    expect(status).toBe(400);
  });

  it('projects parentConversationId / rootConversationId for chain rendering', async () => {
    await writeConv('root', { title: 'Root', messages: [] });
    await writeConv('child', {
      title: 'Child',
      messages: [],
      parentConversationId: 'root',
      rootConversationId: 'root',
    });
    const { body } = await getJson();
    const child = body.find((c: any) => c.id === 'child');
    const root = body.find((c: any) => c.id === 'root');
    expect(child.parentConversationId).toBe('root');
    expect(child.rootConversationId).toBe('root');
    // A top-level conversation has no parent link.
    expect(root.parentConversationId).toBeNull();
  });
});
