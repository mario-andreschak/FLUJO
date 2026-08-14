/**
 * Tests for the read-only chain projection (issue #405).
 *
 * GET /v1/chat/conversation-chains returns recent persisted conversation-chain
 * topology plus ONE bounded plain-text preview of the latest user, assistant,
 * or tool activity. It must never return histories, unbounded payloads or model
 * context, and it must terminate on corrupt parent data.
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
let FlowExecutor: typeof import('@/backend/execution/flow/FlowExecutor').FlowExecutor;

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
  convDir = path.join(tmpDir, 'workspaces', 'default-workspace', 'db', 'conversations');
  await fs.mkdir(convDir, { recursive: true });
  process.env.FLUJO_DATA_DIR = tmpDir;
  jest.resetModules();
  ({ GET } = await import('@/app/v1/chat/conversation-chains/route'));
  ({ FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor'));
});

afterEach(async () => {
  FlowExecutor.conversationStates.clear();
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

  it('projects persisted chains while retaining active-node metadata', async () => {
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
    expect(body.chains).toHaveLength(2);

    const chain = body.chains.find((candidate: any) => candidate.rootId === 'root');
    expect(chain).toBeDefined();
    expect(chain.rootId).toBe('root');
    expect(chain.activeNodeCount).toBe(1);
    expect(chain.nodes.map((n: any) => n.id)).toEqual(['root', 'child']);
    expect(chain.nodes.map((n: any) => n.active)).toEqual([false, true]);
    expect(chain.truncated).toBe(false);
    expect(body.chains.find((candidate: any) => candidate.rootId === 'unrelated')?.activeNodeCount).toBe(0);
  });

  it('keeps terminal chains visible instead of returning an empty history', async () => {
    await writeConv('done', { status: 'completed' });
    await writeConv('failed', { status: 'error' });
    await writeConv('capped', { status: 'capped' });

    const { body } = await getJson();
    const nodes = body.chains.flatMap((chain: any) => chain.nodes);
    expect(nodes.map((node: any) => node.id).sort()).toEqual(['capped', 'done', 'failed']);
    expect(nodes.every((node: any) => node.active === false)).toBe(true);
  });

  it('keeps an interrupted persisted run visible with its corrected status', async () => {
    // Same projection the conversation list applies after a restart: a
    // `running` record with no live event stream is really an error, so it is
    // NOT active.
    await writeConv('ghost', { status: 'running' });

    const { body } = await getJson();
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0].nodes[0]).toMatchObject({
      id: 'ghost',
      status: 'error',
      active: false,
    });
  });

  it('does not downgrade a live run before its first event is emitted', async () => {
    await writeConv('live', { status: 'completed', updatedAt: 2 });
    FlowExecutor.conversationStates.set('live', {
      conversationId: 'live',
      title: 'Live conversation',
      status: 'running',
      createdAt: 1,
      updatedAt: 3,
      messages: [],
    } as any);

    const { body } = await getJson();
    expect(body.chains[0].activeNodeCount).toBe(1);
    expect(body.chains[0].nodes[0]).toMatchObject({
      id: 'live',
      status: 'running',
      active: true,
    });
  });

  it('previews the latest tool activity with its name and never returns the history', async () => {
    await writeConv('active', {
      status: 'paused_debug',
      messages: [
        { role: 'system', content: 'you are a secret system prompt' },
        { role: 'user', content: 'first user question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'the   older answer' }],
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"private":"tool arguments"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'bounded tool result' },
      ],
    });

    const { body } = await getJson();
    const node = body.chains[0].nodes[0];
    expect(node.lastMessage).toMatchObject({
      role: 'tool',
      text: 'read_file',
      toolName: 'read_file',
      toolKind: 'result',
      truncated: false,
    });
    expect('messages' in node).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret system prompt');
    expect(serialized).not.toContain('first user question');
    expect(serialized).not.toContain('the older answer');
    expect(serialized).not.toContain('tool arguments');
    expect(serialized).not.toContain('bounded tool result');
  });

  it('projects the persisted execution identity without loading every saved flow', async () => {
    await writeConv('archived', {
      flowId: 'deleted-flow',
      flowSnapshot: { id: 'deleted-flow', name: 'Archived research flow' },
      statisticsFlowName: 'Older statistics name',
      messages: [{ role: 'assistant', content: 'Done' }],
    });
    await writeConv('quick', {
      flowId: 'quickchat-quick',
      messages: [{ role: 'assistant', content: 'Ready' }],
    });

    const { body } = await getJson();
    const nodes = body.chains.flatMap((chain: any) => chain.nodes);
    expect(nodes.find((node: any) => node.id === 'archived')?.flowName).toBe('Archived research flow');
    expect(nodes.find((node: any) => node.id === 'quick')?.flowName).toBe('Quick Chat');
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

  it('keeps the true root and loaded ancestor path when a large chain is capped', async () => {
    await writeConv('root', {
      title: 'Old root',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
    });
    await Promise.all(Array.from({ length: 60 }, (_, index) => {
      const id = `child-${String(index).padStart(2, '0')}`;
      return writeConv(id, {
        status: 'completed',
        createdAt: index + 2,
        updatedAt: 100 + index,
        parentConversationId: 'root',
        rootConversationId: 'root',
      });
    }));

    const { status, body } = await getJson('?root=root');
    const chain = body.chains[0];

    expect(status).toBe(200);
    expect(chain).toMatchObject({ rootId: 'root', totalNodeCount: 61, truncated: true });
    expect(chain.nodes).toHaveLength(60);
    expect(chain.nodes[0].id).toBe('root');
    expect(chain.nodes.some((candidate: any) => candidate.id === 'root')).toBe(true);
    expect(
      chain.nodes
        .filter((candidate: any) => candidate.id !== 'root')
        .every((candidate: any) => candidate.parentConversationId === 'root'),
    ).toBe(true);
  });

  it('rejects an invalid root id or limit with 400', async () => {
    await expect(getJson('?root=../escape')).resolves.toMatchObject({ status: 400 });
    await expect(getJson('?limit=0')).resolves.toMatchObject({ status: 400 });
    await expect(getJson('?limit=999')).resolves.toMatchObject({ status: 400 });
  });
});
