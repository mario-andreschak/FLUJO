import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCodexToolBridge } from '@/backend/services/model/adapters/codexToolBridge';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import { _setNativeToolJournalRootForTests, prepareNativeInvocation, submitNativeInvocation } from '@/backend/execution/flow/handlers/nativeToolJournal';
import { createNativeBrokerAuthority, createNativeToolPort, nativeToolInventoryDigest } from '@/backend/execution/flow/handlers/nativeToolBroker';

describe('Codex tool bridge', () => {
  it('advertises host instructions during MCP initialization', async () => {
    const bridge = await startCodexToolBridge([], 'Use FLUJO tools as the filesystem authority.');
    const client = new Client({ name: 'codex-bridge-test', version: '1.0.0' });

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
      expect(client.getInstructions()).toBe('Use FLUJO tools as the filesystem authority.');
    } finally {
      await client.close().catch(() => undefined);
      await bridge.close();
    }
  });

  it('does not invent read-only annotations for tools with unknown side effects', async () => {
    const bridge = await startCodexToolBridge([{
      name: 'test__lookup',
      description: 'Looks something up',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }]);
    const client = new Client({ name: 'codex-bridge-test', version: '1.0.0' });

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
      const result = await client.listTools();

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].annotations).toBeUndefined();
    } finally {
      await client.close().catch(() => undefined);
      await bridge.close();
    }
  });

  it('preserves real annotations when the caller provides them', async () => {
    const annotations = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
    const bridge = await startCodexToolBridge([{
      name: 'test__delete',
      description: 'Deletes something',
      inputSchema: { type: 'object', properties: {} },
      annotations,
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }]);
    const client = new Client({ name: 'codex-bridge-test', version: '1.0.0' });

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
      const result = await client.listTools();

      expect(result.tools[0].annotations).toEqual(annotations);
    } finally {
      await client.close().catch(() => undefined);
      await bridge.close();
    }
  });

  it('uses pinned Codex model call metadata rather than the JSON-RPC transport ID', async () => {
    const identities: Array<string | undefined> = [];
    const bridge = await startCodexToolBridge([{
      name: 'worker_search', description: 'Search', inputSchema: { type: 'object', properties: {} },
      handler: async (_args, identity) => {
        identities.push(identity);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }], undefined, true);
    const post = async (rpcId: number, meta?: Record<string, string>) => {
      const response = await fetch(bridge.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call',
          params: { name: 'worker_search', arguments: {}, ...(meta ? { _meta: meta } : {}) } }),
      });
      expect(response.ok).toBe(true);
    };
    try {
      bridge.bindNativeThread('thread-1');
      expect(()=>bridge.bindNativeThread('thread-2')).toThrow();
      await post(0, { threadId: 'thread-2', callId: 'untrusted-first-call' });
      await post(1, { threadId: 'thread-1', callId: 'model-call-1' });
      await post(2, { threadId: 'thread-1', callId: 'model-call-1' });
      await post(1, { threadId: 'thread-1', callId: 'model-call-2' });
      await post(4, { threadId: 'thread-2', callId: 'model-call-1' });
      await post(3);
      expect(identities).toEqual([
        undefined, 'model-call-1', 'model-call-1', 'model-call-2', undefined, undefined,
      ]);
    } finally {
      await bridge.close();
    }
  });

  it('deduplicates one model call across RPC ids while allowing distinct model calls with a reused RPC id', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-rpc-identity-'));
    _setNativeToolJournalRootForTests(directory);
    let bridge: Awaited<ReturnType<typeof startCodexToolBridge>> | undefined;
    try {
      const tools: OpenAI.ChatCompletionFunctionTool[] = [{ type: 'function', function: {
        name: 'worker_search', description: 'Search', parameters: { type: 'object', properties: {} },
      } }];
      const executor = jest.fn(async () => ({ ok: true }));
      const executors = { worker_search: executor };
      const receipt = await prepareNativeInvocation({ conversationId: 'rpc-identity', runId: 'run', nodeId: 'node',
        modelId: 'model', leaseEpoch: 'lease', inputDigest: 'input', attemptOrdinal: 1,
        inventoryDigest: nativeToolInventoryDigest(tools, undefined, executors) });
      await submitNativeInvocation(receipt);
      const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
        service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
        authority: createNativeBrokerAuthority('lease', async () => undefined),
        signal: new AbortController().signal });
      bridge = await startCodexToolBridge([{ name: 'worker_search', description: 'Search',
        inputSchema: { type: 'object', properties: {} },
        handler: async (args, id) => {
          if (!id) throw new Error('missing model call ID');
          return (await port.dispatch({ toolInvocationId: id, name: 'worker_search', args,
            signal: new AbortController().signal })).result;
        },
      }], undefined, true);
      const post = async (rpcId: number, callId?: string, threadId = 'thread-1') => fetch(bridge!.url, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: {
          name: 'worker_search', arguments: { q: 'same' },
          ...(callId ? { _meta: { threadId, callId } } : {}),
        } }),
      });
      expect((await post(1, 'model-call-1')).ok).toBe(true);
      expect((await post(2, 'model-call-1')).ok).toBe(true);
      expect(executor).toHaveBeenCalledTimes(1);
      expect((await post(1, 'model-call-2')).ok).toBe(true);
      expect(executor).toHaveBeenCalledTimes(2);
      expect((await post(4, 'model-call-1', 'thread-2')).ok).toBe(true);
      expect(executor).toHaveBeenCalledTimes(2);
      expect((await post(3)).ok).toBe(true);
      expect(executor).toHaveBeenCalledTimes(2);
    } finally {
      await bridge?.close();
      _setNativeToolJournalRootForTests(undefined);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
