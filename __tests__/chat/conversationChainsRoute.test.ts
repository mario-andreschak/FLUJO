/**
 * Tests for the read-only chain projection (issue #405).
 *
 * GET /v1/chat/conversation-chains returns, for every ACTIVE conversation, its
 * chain topology plus ONE bounded plain-text preview of the latest displayable
 * message. It must never return histories, tool payloads or model context, and
 * it must terminate on corrupt (self-linked / cyclic) parent data.
 *
 * Drives the real route handler against a throwaway temp data dir (via
 * FLUJO_DATA_DIR + jest.resetModules()), mirroring conversationContentSearch.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { makeLocalRequest } from '../utils/localRequest';

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));
// Type-only frontend import somewhere in the backend graph; stub it so the
// React tree never enters this node test.
jest.mock('@/frontend/components/Chat', () => ({}));

type Route = typeof import('@/app/v1/chat/conversation-chains/route');

let tmpDir: string;
let convDir: string;
let GET: Route['GET'];

const writeConv = async (id: string, obj: Record<string, unknown>) => {
  await fs.writeFile(
    path.join(convDir, `${id}.json`),
    JSON.stringify({
      conversationId: id,
      title: id,
      flowId: 'flow-1',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      ...obj,
    }),
    'utf-8',
  );
};

const getJson = async (query = '') => {
  const res = await GET(
    makeLocalRequest({ url: `http://localhost:4200/v1/chat/conversation-chains${query}` }),
  );
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-chain-chat-'));
  convDir = path.join(tmpDir, 'db', 'conversations');
  await fs.mkdir(convDir, { recursive: true });
  process.env.FLUJO_DATA_DIR = tmpDir;
  jest.resetModules();
  ({ GET } = await import('@/app/v1/chat/conversation-chains/route'));
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /v1/chat/conversation-chains (issue #405)', () => {
  it('returns an empty projection before any conversation exists', async () => {
    await fs.rm(convDir, { recursive: true, force: true });

    const { status, body } = await getJson();
    expect(status).toBe(200);
    expect(body.chains).toEqual([]);
    expect(body.totalChains).toBe(0);
    expect(body.truncated).toBe(false);
    expect(body.activeStatuses).toEqual(['running', 'awaiting_tool_approval', 'paused_debug']);
  });

  it('projects active nodes grouped by root, including their inactive ancestors', async () => {
    await writeConv('root', { title: 'Root', status: 'completed', updatedAt: 5 });
    await writeConv('child', {
      title: 'Child',
      status: 'awaiting_tool_approval',
      updatedAt: 9,
      createdAt: 2,
      parentConversationId: 'root',
      rootConversationId: 'root',
    });
    await writeConv('unrelated', { title: 'Unrelated', status: 'completed', updatedAt: 20 });

    const { status, body } = await getJson();
    expect(status).toBe(200);
    expect(body.chains).toHaveLength(1);

    const chain = body.chains[0];
    expect(chain.rootId).toBe('root');
    expect(chain.activeNodeCount).toBe(1);
    expect(chain.nodes.map((n: any) => n.id)).toEqual(['root', 'child']);
    expect(chain.nodes.map((n: any) => n.active)).toEqual([false, true]);
    expect(chain.truncated).toBe(false);
  });

  it('excludes terminal statuses from the active allowlist', async () => {
    await writeConv('done', { status: 'completed' });
    await writeConv('failed', { status: 'error' });
    await writeConv('capped', { status: 'capped' });

    const { body } = await getJson();
    expect(body.chains).toEqual([]);
  });

  it('treats a persisted running conversation with no live event channel as interrupted', async () => {
    // Same projection the conversation list applies after a restart: a
    // `running` record with no live event stream is really an error, so it is
    // NOT active.
    await writeConv('ghost', { status: 'running' });

    const { body } = await getJson();
    expect(body.chains).toEqual([]);
  });

  it('previews only the latest user/assistant message and never the history', async () => {
    await writeConv('active', {
      status: 'paused_debug',
      messages: [
        { role: 'system', content: 'you are a secret system prompt' },
        { role: 'user', content: 'first user question' },
        { role: 'assistant', content: [{ type: 'text', text: 'the   visible answer' }] },
        { role: 'tool', content: 'raw tool payload' },
      ],
    });

    const { body } = await getJson();
    const node = body.chains[0].nodes[0];
    expect(node.lastMessage).toMatchObject({ role: 'assistant', text: 'the visible answer', truncated: false });
    expect('messages' in node).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret system prompt');
    expect(serialized).not.toContain('raw tool payload');
    expect(serialized).not.toContain('first user question');
  });

  it('bounds the preview and falls back when there is nothing displayable', async () => {
    await writeConv('long', {
      status: 'paused_debug',
      messages: [{ role: 'user', content: 'x'.repeat(1000) }],
    });
    await writeConv('silent', {
      status: 'paused_debug',
      messages: [{ role: 'system', content: 'system only' }],
    });

    const { body } = await getJson();
    const nodes = body.chains.flatMap((chain: any) => chain.nodes);
    const long = nodes.find((n: any) => n.id === 'long');
    const silent = nodes.find((n: any) => n.id === 'silent');

    expect(long.lastMessage.truncated).toBe(true);
    expect(long.lastMessage.text.length).toBeLessThanOrEqual(241);
    expect(silent.lastMessage).toBeNull();
  });

  it('terminates safely on self-links and cyclic parent data', async () => {
    await writeConv('selfie', { status: 'paused_debug', parentConversationId: 'selfie' });
    await writeConv('a', { status: 'paused_debug', parentConversationId: 'b', rootConversationId: 'b' });
    await writeConv('b', { status: 'paused_debug', parentConversationId: 'a', rootConversationId: 'a' });

    const { status, body } = await getJson();
    expect(status).toBe(200);
    const ids = body.chains.flatMap((chain: any) => chain.nodes.map((n: any) => n.id)).sort();
    expect(ids).toEqual(['a', 'b', 'selfie']);
  });

  it('narrows to a single chain by root without confirming unknown ids', async () => {
    await writeConv('r1', { status: 'paused_debug', updatedAt: 10 });
    await writeConv('r2', { status: 'paused_debug', updatedAt: 20 });

    const filtered = await getJson('?root=r1');
    expect(filtered.body.chains.map((c: any) => c.rootId)).toEqual(['r1']);

    const missing = await getJson('?root=does-not-exist');
    expect(missing.status).toBe(200);
    expect(missing.body.chains).toEqual([]);
  });

  it('sorts chains by recency and reports truncation against the chain limit', async () => {
    await writeConv('older', { status: 'paused_debug', updatedAt: 10 });
    await writeConv('newer', { status: 'paused_debug', updatedAt: 30 });

    const { body } = await getJson('?limit=1');
    expect(body.chains.map((c: any) => c.rootId)).toEqual(['newer']);
    expect(body.totalChains).toBe(2);
    expect(body.truncated).toBe(true);
  });

  it('rejects an invalid root id or limit with 400', async () => {
    await expect(getJson('?root=../escape')).resolves.toMatchObject({ status: 400 });
    await expect(getJson('?limit=0')).resolves.toMatchObject({ status: 400 });
    await expect(getJson('?limit=999')).resolves.toMatchObject({ status: 400 });
  });
});
