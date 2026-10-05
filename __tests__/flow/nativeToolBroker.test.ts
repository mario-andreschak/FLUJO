import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import {
  _setNativeToolJournalRootForTests, beginNativeTool, finishNativeInvocation,
  finishNativeTool, markNativeToolEffectMayHaveStarted, nativeInvocationStatus,
  prepareNativeInvocation, submitNativeInvocation, type NativeInvocationOwner,
} from '@/backend/execution/flow/handlers/nativeToolJournal';
import {
  assertNativeToolPort, createNativeBrokerAuthority, createNativeToolPort,
  nativeToolInventoryDigest,
} from '@/backend/execution/flow/handlers/nativeToolBroker';

const tool = (name: string): OpenAI.ChatCompletionFunctionTool => ({
  type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } },
});
const owner = (conversationId: string, inventoryDigest = 'inventory'): NativeInvocationOwner => ({
  conversationId, runId: 'run-a', nodeId: 'node-a', modelId: 'model-a',
  leaseEpoch: 'lease-a', inventoryDigest, inputDigest: 'input-a',
  attemptOrdinal: 1,
});

describe('native broker journal', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-native-broker-'));
    _setNativeToolJournalRootForTests(directory);
  });
  afterEach(async () => {
    _setNativeToolJournalRootForTests(undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('holds a conversation across changed run, node, model and lease after uncertain admission', async () => {
    const first = await prepareNativeInvocation(owner('held'));
    await submitNativeInvocation(first);
    const changed = { ...owner('held'), runId: 'run-b', nodeId: 'node-b', modelId: 'model-b', leaseEpoch: 'lease-b' };
    await expect(prepareNativeInvocation(changed)).rejects.toThrow(/unresolved/);
    expect((await nativeInvocationStatus(first.invocationId, first.owner)).state).toBe('begin-may-have-been-sent');
  });

  it('does not advance admission or release the scope when a journal write fails', async () => {
    const receipt = await prepareNativeInvocation(owner('write-failure'));
    const originalRename = fs.rename.bind(fs);
    const destination = path.join(directory, 'calls', `${receipt.invocationId}.json`);
    const rename = jest.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (String(to) === destination) return Promise.reject(new Error('journal disk fault'));
      return originalRename(from, to);
    });
    try {
      await expect(submitNativeInvocation(receipt)).rejects.toThrow(/journal disk fault/);
    } finally {
      rename.mockRestore();
    }
    expect((await nativeInvocationStatus(receipt.invocationId, receipt.owner)).state).toBe('prepared');
    await expect(prepareNativeInvocation({ ...owner('write-failure'), leaseEpoch: 'new-lease' }))
      .rejects.toThrow(/unresolved/);
  });

  it('deduplicates SDK callback identity and refuses changed arguments or an unresolved effect', async () => {
    const receipt = await prepareNativeInvocation(owner('dedupe'));
    await submitNativeInvocation(receipt);
    const first = await beginNativeTool(receipt, 'sdk-tool-1', 'fingerprint-a');
    expect(first.fresh).toBe(true);
    expect((await beginNativeTool(receipt, 'sdk-tool-1', 'fingerprint-a')).fresh).toBe(false);
    await expect(beginNativeTool(receipt, 'sdk-tool-1', 'fingerprint-b')).rejects.toThrow(/Conflicting/);
    await markNativeToolEffectMayHaveStarted(first.entry);
    await expect(finishNativeInvocation(receipt, 'completed')).rejects.toThrow(/unresolved/);
    await finishNativeTool(first.entry, {
      kind: 'synthetic', transcriptText: 'done', result: { content: [{ type: 'text', text: 'done' }] },
    });
    expect((await beginNativeTool(receipt, 'sdk-tool-1', 'fingerprint-a')).entry.state).toBe('terminal');
    await finishNativeInvocation(receipt, 'completed');
    await expect(beginNativeTool(receipt, 'sdk-tool-2', 'fingerprint-b')).rejects.toThrow(/unresolved/);
  });

  it('dispatches one Worker-owned effect, returns the durable result on duplicate delivery, and rejects JSON ports', async () => {
    const tools = [tool('worker_search')];
    const digest = nativeToolInventoryDigest(tools, undefined, { worker_search: async () => ({ ok: true }) });
    const receipt = await prepareNativeInvocation(owner('broker', digest));
    await submitNativeInvocation(receipt);
    const executor = jest.fn(async () => ({ ok: true }));
    const approval = jest.fn(async () => true);
    const port = createNativeToolPort({
      receipt, tools, localToolExecutors: { worker_search: executor },
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      requestToolApproval: approval,
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: new AbortController().signal,
    });
    expect(() => assertNativeToolPort(JSON.parse(JSON.stringify({ advertised: port.advertised })))).toThrow();
    expect(Object.isFrozen(port.advertised)).toBe(true);
    const call = { toolInvocationId: 'sdk-1', name: 'worker_search', args: { q: 'test' }, signal: new AbortController().signal };
    const first = await port.dispatch(call);
    const replay = await port.dispatch(call);
    expect(replay).toEqual(first);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledTimes(1);
    await expect(port.dispatch({ ...call, args: { q: 'changed' } })).rejects.toThrow(/Conflicting/);
  });

  it('fails before effect when the lease is stale or cancellation arrives', async () => {
    const tools = [tool('worker_search')];
    const executors = { worker_search: jest.fn(async () => ({ ok: true })) };
    const digest = nativeToolInventoryDigest(tools, undefined, executors);
    const receipt = await prepareNativeInvocation(owner('stale', digest));
    await submitNativeInvocation(receipt);
    const authority = createNativeBrokerAuthority('lease-a', async () => { throw new Error('stale lease'); });
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'], authority,
      signal: new AbortController().signal });
    await expect(port.dispatch({ toolInvocationId: 'sdk-1', name: 'worker_search', args: {},
      signal: new AbortController().signal })).rejects.toThrow(/stale lease/);
    expect(executors.worker_search).not.toHaveBeenCalled();

    const cancelled = new AbortController();
    cancelled.abort();
    const freshReceipt = await prepareNativeInvocation(owner('cancelled', digest));
    await submitNativeInvocation(freshReceipt);
    const freshPort = createNativeToolPort({ receipt: freshReceipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: cancelled.signal });
    await expect(freshPort.dispatch({ toolInvocationId: 'sdk-cancelled', name: 'worker_search', args: {},
      signal: new AbortController().signal })).rejects.toThrow();
    expect(executors.worker_search).not.toHaveBeenCalled();
  });

  it('checks live MCP client and schema identity after approval before the effect', async () => {
    const tools = [tool('worker_mcp')];
    const mapping = { worker_mcp: {
      server: 'worker-server', tool: 'search', clientGeneration: 7, schemaHash: 'schema-a',
      presetArgs: { fixed: true },
    } };
    const digest = nativeToolInventoryDigest(tools, mapping);
    const receipt = await prepareNativeInvocation(owner('mcp-stale', digest));
    await submitNativeInvocation(receipt);
    const service = {
      getClient: jest.fn(() => ({})),
      getClientGeneration: jest.fn(() => 8),
      getToolSchemaHash: jest.fn(() => 'schema-a'),
      callTool: jest.fn(async () => ({ success: true, data: { content: [{ type: 'text', text: 'unsafe' }] } })),
    } as unknown as Parameters<typeof createNativeToolPort>[0]['service'];
    const approval = jest.fn(async () => true);
    const port = createNativeToolPort({ receipt, tools, toolNameMap: mapping, service,
      requestToolApproval: approval,
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: new AbortController().signal });
    const result = await port.dispatch({ toolInvocationId: 'sdk-mcp', name: 'worker_mcp', args: { q: 'test' },
      signal: new AbortController().signal });
    expect(result.result.isError).toBe(true);
    expect(service.callTool).not.toHaveBeenCalled();
    expect(approval).toHaveBeenCalledTimes(1);
  });

  it('holds an oversized effect result instead of replaying the executor', async () => {
    const tools = [tool('large_result')];
    const executor = jest.fn(async () => ({ data: 'x'.repeat(1024 * 1024 + 1) }));
    const executors = { large_result: executor };
    const receipt = await prepareNativeInvocation(owner('large', nativeToolInventoryDigest(tools, undefined, executors)));
    await submitNativeInvocation(receipt);
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: new AbortController().signal });
    const call = { toolInvocationId: 'sdk-large', name: 'large_result', args: {}, signal: new AbortController().signal };
    await expect(port.dispatch(call)).rejects.toThrow(/exceeds the broker transport bound/);
    await expect(port.dispatch(call)).rejects.toThrow(/unresolved/);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('holds an MCP transport failure as an unknown effect', async () => {
    const tools = [tool('worker_mcp')];
    const mapping = { worker_mcp: {
      server: 'worker-server', tool: 'write', clientGeneration: 7, schemaHash: 'schema-a',
    } };
    const receipt = await prepareNativeInvocation(owner('mcp-unknown', nativeToolInventoryDigest(tools, mapping)));
    await submitNativeInvocation(receipt);
    const callTool = jest.fn(async () => ({ success: false, error: 'timeout' }));
    const service = { getClient: () => ({}), getClientGeneration: () => 7,
      getToolSchemaHash: () => 'schema-a', callTool } as unknown as Parameters<typeof createNativeToolPort>[0]['service'];
    const port = createNativeToolPort({ receipt, tools, toolNameMap: mapping, service,
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: new AbortController().signal });
    const call = { toolInvocationId: 'sdk-timeout', name: 'worker_mcp', args: {}, signal: new AbortController().signal };
    await expect(port.dispatch(call)).rejects.toThrow(/unresolved/);
    await expect(port.dispatch(call)).rejects.toThrow(/unresolved/);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('keeps the multi-worker handoff invitation in the frozen broker inventory', async () => {
    const tools: OpenAI.ChatCompletionFunctionTool[] = [{
      type: 'function', function: { name: 'handoff_to_worker', description: 'Spawn worker',
        parameters: { type: 'object', properties: { task: { type: 'string' } } },
      },
    }];
    const receipt = await prepareNativeInvocation(owner('handoff', nativeToolInventoryDigest(tools)));
    await submitNativeInvocation(receipt);
    const port = createNativeToolPort({ receipt, tools,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: new AbortController().signal });
    const response = await port.dispatch({ toolInvocationId: 'sdk-spawn', name: 'handoff_to_worker',
      args: { task: 'One child' }, signal: new AbortController().signal });
    expect(response.kind).toBe('handoff');
    expect(response.result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('another parallel worker') });
  });
});
