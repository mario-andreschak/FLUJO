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
import { NextRequest } from 'next/server';
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
let DELETE: Route['DELETE'];
const originalExposureMode = process.env.FLUJO_EXPOSURE_MODE;

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
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-conv-search-'));
  convDir = path.join(tmpDir, 'workspaces', 'default-workspace', 'db', 'conversations');
  await fs.mkdir(convDir, { recursive: true });
  process.env.FLUJO_DATA_DIR = tmpDir;
  delete (global as any).__flujo_flowsCache;
  jest.resetModules();
  ({ DELETE, GET } = await import('@/app/v1/chat/conversations/route'));
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalExposureMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
  else process.env.FLUJO_EXPOSURE_MODE = originalExposureMode;
});

describe('GET /v1/chat/conversations content search (issue #182)', () => {
  it('returns a lightweight presence count without parsing conversation bodies', async () => {
    await fs.writeFile(path.join(convDir, 'one.json'), '{not valid json', 'utf-8');
    await fs.writeFile(path.join(convDir, 'ignore.txt'), 'not a conversation', 'utf-8');

    const { status, body } = await getJson('?presence=1');
    expect(status).toBe(200);
    expect(body).toEqual({ count: 1 });
  });

  it('preserves the paged and presence response shapes before the data directory exists', async () => {
    await fs.rm(convDir, { recursive: true, force: true });

    await expect(getJson('?paged=1')).resolves.toMatchObject({
      status: 200,
      body: { items: [], total: 0, hasMore: false },
    });
    await expect(getJson('?presence=1')).resolves.toMatchObject({
      status: 200,
      body: { count: 0 },
    });
  });

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

  it('returns stable cursor-paged lightweight summaries for the sidebar', async () => {
    await writeConv('old', {
      title: 'Old', source: 'chat', updatedAt: 10, lastUserMessageAt: 10, messages: [],
    });
    await writeConv('middle', {
      title: 'Middle', source: 'subflow', updatedAt: 20, lastUserMessageAt: 20, messages: [],
    });
    await writeConv('new', {
      title: 'New', source: 'schedule', updatedAt: 30, lastUserMessageAt: 30, messages: [],
    });

    const first = await getJson('?paged=1&limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items.map((c: any) => c.id)).toEqual(['new', 'middle']);
    expect(first.body).toMatchObject({ total: 3, hasMore: true });
    expect(first.body.items.map((c: any) => c.source)).toEqual(['schedule', 'subflow']);

    const second = await getJson(`?paged=1&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items.map((c: any) => c.id)).toEqual(['old']);
    expect(second.body).toMatchObject({ total: 3, hasMore: false });
  });

  it('filters paged title searches on the server by title, origin, and agent name', async () => {
    const flowDir = path.join(tmpDir, 'workspaces', 'default-workspace', 'db', 'flows');
    await fs.mkdir(flowDir, { recursive: true });
    await fs.writeFile(
      path.join(flowDir, 'invoice-agent.json'),
      JSON.stringify({ id: 'invoice-agent', name: 'Invoice Assistant', nodes: [], edges: [] }),
      'utf-8',
    );
    await writeConv('invoice-run', {
      title: 'Quarterly reconciliation',
      flowId: 'invoice-agent',
      source: 'schedule',
      updatedAt: 30,
      messages: [],
    });
    await writeConv('other', {
      title: 'Unrelated chat',
      flowId: 'flow-2',
      source: 'chat',
      updatedAt: 20,
      messages: [],
    });

    const byTitle = await getJson('?paged=1&limit=50&search=reconciliation&dimension=title');
    expect(byTitle.body.items.map((c: any) => c.id)).toEqual(['invoice-run']);

    const byOrigin = await getJson('?paged=1&limit=50&search=automation&dimension=title');
    expect(byOrigin.body.items.map((c: any) => c.id)).toEqual(['invoice-run']);

    const byAgent = await getJson('?paged=1&limit=50&search=assistant&dimension=title');
    expect(byAgent.body.items.map((c: any) => c.id)).toEqual(['invoice-run']);

    const originFilter = await getJson('?paged=1&limit=50&origin=schedule');
    expect(originFilter.body.items.map((c: any) => c.id)).toEqual(['invoice-run']);
  });

  it('returns only transitive descendants for delete-family checks', async () => {
    await writeConv('root', { title: 'Root', messages: [], updatedAt: 40 });
    await writeConv('child', {
      title: 'Child', messages: [], parentConversationId: 'root', rootConversationId: 'root', updatedAt: 30,
    });
    await writeConv('grandchild', {
      title: 'Grandchild', messages: [], parentConversationId: 'child', rootConversationId: 'root', updatedAt: 20,
    });
    await writeConv('other', { title: 'Other', messages: [], updatedAt: 10 });

    const { status, body } = await getJson('?paged=1&limit=50&descendantsOf=root');
    expect(status).toBe(200);
    expect(body.items.map((c: any) => c.id)).toEqual(['child', 'grandchild']);
    expect(body).toMatchObject({ total: 2, hasMore: false });
  });

  it('returns 400 for an invalid paging cursor or limit', async () => {
    await writeConv('a', { title: 'A', messages: [] });
    await expect(getJson('?paged=1&limit=0')).resolves.toMatchObject({ status: 400 });
    await expect(getJson('?paged=1&cursor=broken')).resolves.toMatchObject({ status: 400 });
    await expect(getJson('?paged=1&origin=invalid')).resolves.toMatchObject({ status: 400 });
    await expect(getJson('?paged=1&descendantsOf=../escape')).resolves.toMatchObject({ status: 400 });
  });

  it('rejects an over-long search term with 400', async () => {
    const term = 'x'.repeat(300);
    const { status } = await getJson(`?search=${term}&dimension=content`);
    expect(status).toBe(400);
  });

  it('projects chain and invocation-origin metadata for sidebar rendering', async () => {
    await writeConv('root', { title: 'Root', messages: [], source: 'chat' });
    await writeConv('child', {
      title: 'Child',
      messages: [],
      source: 'subflow',
      parentConversationId: 'root',
      rootConversationId: 'root',
    });
    const { body } = await getJson();
    const child = body.find((c: any) => c.id === 'child');
    const root = body.find((c: any) => c.id === 'root');
    expect(child.source).toBe('subflow');
    expect(child.parentConversationId).toBe('root');
    expect(child.rootConversationId).toBe('root');
    expect(root.source).toBe('chat');
    // A top-level conversation has no parent link.
    expect(root.parentConversationId).toBeNull();
  });

  it('omits Persona-owned conversations from every public-mode list projection', async () => {
    await writeConv('legacy', { title: 'Legacy', messages: [{ role: 'user', content: 'visible' }] });
    await writeConv('persona', {
      title: 'Persona private',
      messages: [{ role: 'user', content: 'private needle' }],
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    });
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    const remote = async (query = '') => {
      const response = await GET(new NextRequest(
        `https://flujo.example.com/v1/chat/conversations${query}`,
        { headers: { host: 'flujo.example.com' } },
      ));
      return response.json();
    };

    expect((await remote()).map((item: any) => item.id)).toEqual(['legacy']);
    expect((await remote('?paged=1&limit=50')).items.map((item: any) => item.id))
      .toEqual(['legacy']);
    expect(await remote('?presence=1')).toEqual({ count: 1 });
    expect(await remote('?search=needle&dimension=content')).toEqual([]);
  });

  it('bulk deletion leaves Persona-owned conversations intact', async () => {
    await writeConv('legacy', { title: 'Legacy', messages: [] });
    await writeConv('persona', {
      title: 'Persona private',
      messages: [],
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    });

    const response = await DELETE(makeLocalRequest({
      body: { ids: ['legacy', 'persona'] },
      url: 'http://localhost:4200/v1/chat/conversations',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1, errors: 1 });
    await expect(fs.access(path.join(convDir, 'legacy.json'))).rejects.toThrow();
    await expect(fs.access(path.join(convDir, 'persona.json'))).resolves.toBeUndefined();
  });
});
