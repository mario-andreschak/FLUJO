import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import {
  _setNativeToolJournalRootForTests, beginNativeTool, finishNativeInvocation,
  finishNativeTool, holdNativeInvocation, markNativeToolEffectMayHaveStarted, nativeInvocationStatus,
  prepareNativeInvocation, submitNativeInvocation, type NativeInvocationOwner,
} from '@/backend/execution/flow/handlers/nativeToolJournal';
import {
  assertNativeToolPort, createNativeBrokerAuthority, createNativeToolPort,
  nativeToolInventoryDigest,
} from '@/backend/execution/flow/handlers/nativeToolBroker';
import { NATIVE_HANDOFF_PROTOCOL } from '@/backend/execution/flow/handlers/nativeHandoffProtocol';

const tool = (name: string): OpenAI.ChatCompletionFunctionTool => ({
  type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } },
});
const owner = (conversationId: string, inventoryDigest = 'inventory'): NativeInvocationOwner => ({
  conversationId, runId: 'run-a', nodeId: 'node-a', modelId: 'model-a',
  leaseEpoch: 'lease-a', inventoryDigest, inputDigest: 'input-a',
  attemptOrdinal: 1,
});

describe('native broker journal', () => {
  it('does not admit a handoff protocol string or fake exit promises as an owned host capability', async () => {
    const tools = [tool('handoff_to_finish')];
    const digest = nativeToolInventoryDigest(tools, undefined, undefined, NATIVE_HANDOFF_PROTOCOL);
    const receipt = await prepareNativeInvocation(owner('fake-handoff-cap', digest));
    const confirm = jest.fn();
    expect(() => createNativeToolPort({ receipt, tools,
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      signal: new AbortController().signal, terminationProtocol: NATIVE_HANDOFF_PROTOCOL,
      originalProcessHost: { confirmHandoffTermination: confirm, waitForExit: async () => undefined } as never,
    })).toThrow('held');
    expect(confirm).not.toHaveBeenCalled();
    expect((await nativeInvocationStatus(receipt.invocationId, receipt.owner)).state).toBe('prepared');
  });
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

  it('serializes concurrent allocations for the same origin conversation', async () => {
    const [first, second] = await Promise.allSettled([
      prepareNativeInvocation(owner('concurrent')),
      prepareNativeInvocation({ ...owner('concurrent'), leaseEpoch: 'other-lease' }),
    ]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
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

  it('keeps the durable hold when terminal release persistence fails', async () => {
    const receipt = await prepareNativeInvocation(owner('release-failure'));
    await submitNativeInvocation(receipt);
    const originalUnlink = fs.unlink.bind(fs);
    const unlink = jest.spyOn(fs, 'unlink').mockImplementation(file => {
      if (String(file).startsWith(path.join(directory, 'holds'))) {
        return Promise.reject(new Error('release disk fault'));
      }
      return originalUnlink(file);
    });
    try {
      await expect(finishNativeInvocation(receipt, 'completed', {
        assertCurrent: async () => undefined, signal: new AbortController().signal,
      })).rejects.toThrow(/release disk fault/);
    } finally { unlink.mockRestore(); }
    expect((await nativeInvocationStatus(receipt.invocationId, receipt.owner)).state).toBe('unknown');
    await expect(prepareNativeInvocation({ ...owner('release-failure'), leaseEpoch: 'successor' }))
      .rejects.toThrow(/unresolved/);
  });

  it('holds after prepare second-write failure and after loss of a scope pointer', async () => {
    const originalRename = fs.rename.bind(fs);
    const rename = jest.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (String(to).startsWith(path.join(directory, 'calls'))) {
        return Promise.reject(new Error('second write failed'));
      }
      return originalRename(from, to);
    });
    try {
      await expect(prepareNativeInvocation(owner('second-write'))).rejects.toThrow(/second write failed/);
    } finally { rename.mockRestore(); }
    _setNativeToolJournalRootForTests(undefined);
    _setNativeToolJournalRootForTests(directory); // fresh module-facing root, same durable files
    await expect(prepareNativeInvocation({ ...owner('second-write'), leaseEpoch: 'successor' }))
      .rejects.toThrow(/unresolved/);

    const indexed = await prepareNativeInvocation(owner('missing-pointer'));
    await submitNativeInvocation(indexed);
    const scopes = await fs.readdir(path.join(directory, 'scopes'));
    for (const scope of scopes) {
      const file = path.join(directory, 'scopes', scope);
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.invocationId === indexed.invocationId) await fs.unlink(file);
    }
    await expect(prepareNativeInvocation({ ...owner('missing-pointer'), leaseEpoch: 'successor' }))
      .rejects.toThrow(/unresolved/);
  });

  it('deduplicates SDK callback identity and refuses changed arguments or an unresolved effect', async () => {
    const receipt = await prepareNativeInvocation(owner('dedupe'));
    await submitNativeInvocation(receipt);
    const terminalFence = { assertCurrent: async () => undefined, signal: new AbortController().signal };
    const first = await beginNativeTool(receipt, 'sdk-tool-1', 'fingerprint-a');
    expect(first.fresh).toBe(true);
    expect((await beginNativeTool(receipt, 'sdk-tool-1', 'fingerprint-a')).fresh).toBe(false);
    await expect(beginNativeTool(receipt, 'sdk-tool-1', 'fingerprint-b')).rejects.toThrow(/Conflicting/);
    await markNativeToolEffectMayHaveStarted(first.entry);
    await expect(finishNativeInvocation(receipt, 'completed', terminalFence)).rejects.toThrow(/unresolved/);
    await finishNativeTool(first.entry, {
      kind: 'synthetic', transcriptText: 'done', result: { content: [{ type: 'text', text: 'done' }] },
    });
    expect((await beginNativeTool(receipt, 'sdk-tool-1', 'fingerprint-a')).entry.state).toBe('terminal');
    await finishNativeInvocation(receipt, 'completed', terminalFence);
    await expect(beginNativeTool(receipt, 'sdk-tool-2', 'fingerprint-b')).rejects.toThrow(/unresolved/);
  });

  it('preserves an exact terminal tool result for original-ID reconciliation under a parent hold', async () => {
    const receipt = await prepareNativeInvocation(owner('reconcile'));
    await submitNativeInvocation(receipt);
    const first = await beginNativeTool(receipt, 'sdk-original', 'same-fingerprint');
    await finishNativeTool(first.entry, { kind: 'synthetic', transcriptText: 'done',
      result: { content: [{ type: 'text', text: 'done' }] } });
    await holdNativeInvocation(receipt);
    const replay = await beginNativeTool(receipt, 'sdk-original', 'same-fingerprint');
    expect(replay.fresh).toBe(false);
    expect(replay.entry.state).toBe('terminal');
    await expect(beginNativeTool(receipt, 'sdk-new', 'new-fingerprint')).rejects.toThrow(/unresolved/);
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

  it('runs the final native lease check after an asynchronous dispatch gate', async () => {
    const tools = [tool('worker_search')];
    const executor = jest.fn(async () => ({ unsafe: true }));
    const executors = { worker_search: executor };
    const receipt = await prepareNativeInvocation(owner('gate-revocation', nativeToolInventoryDigest(tools, undefined, executors)));
    await submitNativeInvocation(receipt);
    let current = true;
    let entered!: () => void;
    let release!: () => void;
    const atGate = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-a', async () => {
        if (!current) throw new Error('native lease revoked');
      }),
      beforeToolDispatch: async () => { entered(); await gate; },
      signal: new AbortController().signal });
    const pending = port.dispatch({ toolInvocationId: 'sdk-gate', name: 'worker_search', args: {},
      signal: new AbortController().signal });
    await atGate;
    current = false;
    release();
    await expect(pending).rejects.toThrow(/native lease revoked/);
    expect(executor).not.toHaveBeenCalled();
  });

  it('uses the original approved argument snapshot even when the caller mutates during approval', async () => {
    const tools = [tool('worker_search')];
    const executor = jest.fn(async (args: Record<string, unknown>) => args);
    const executors = { worker_search: executor };
    const receipt = await prepareNativeInvocation(owner('args-snapshot', nativeToolInventoryDigest(tools, undefined, executors)));
    await submitNativeInvocation(receipt);
    let entered!: () => void;
    let release!: () => void;
    const atApproval = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const approved = jest.fn(async ({ args }: { args: Record<string, unknown> }) => {
      expect(args).toEqual({ nested: { value: 'original' }, a: 1 });
      entered();
      await gate;
      return true;
    });
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      requestToolApproval: approved,
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: new AbortController().signal });
    const callerArgs = { nested: { value: 'original' }, a: 1 };
    const call = { toolInvocationId: 'sdk-snapshot', name: 'worker_search', args: callerArgs,
      signal: new AbortController().signal };
    const pending = port.dispatch(call);
    await atApproval;
    callerArgs.nested.value = 'mutated';
    release();
    await pending;
    expect(executor).toHaveBeenCalledWith({ nested: { value: 'original' }, a: 1 });
    expect(approved).toHaveBeenCalledTimes(1);
    // Key order is JSON-insignificant, so the exact-ID callback is cached.
    await port.dispatch({ ...call, args: { a: 1, nested: { value: 'original' } } });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('does not return a cached result when Stop arrives during authority recheck', async () => {
    const tools = [tool('worker_search')];
    const executor = jest.fn(async () => ({ done: true }));
    const executors = { worker_search: executor };
    const receipt = await prepareNativeInvocation(owner('duplicate-stop', nativeToolInventoryDigest(tools, undefined, executors)));
    await submitNativeInvocation(receipt);
    let block = false;
    let entered!: () => void;
    let release!: () => void;
    const atAuthority = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stop = new AbortController();
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-a', async () => {
        if (block) { entered(); await gate; }
      }), signal: stop.signal });
    const call = { toolInvocationId: 'sdk-duplicate-stop', name: 'worker_search', args: {},
      signal: new AbortController().signal };
    await port.dispatch(call);
    block = true;
    const replay = port.dispatch(call);
    await atAuthority;
    stop.abort();
    release();
    await expect(replay).rejects.toThrow();
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('pins executor references and serializes concurrent duplicate callbacks', async () => {
    const tools = [tool('worker_search')];
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = jest.fn(async () => { entered(); await gate; return { original: true }; });
    const replacement = jest.fn(async () => ({ original: false }));
    const executors = { worker_search: original };
    const receipt = await prepareNativeInvocation(owner('concurrent-tool', nativeToolInventoryDigest(tools, undefined, executors)));
    await submitNativeInvocation(receipt);
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: new AbortController().signal });
    executors.worker_search = replacement;
    const call = { toolInvocationId: 'sdk-concurrent', name: 'worker_search', args: {},
      signal: new AbortController().signal };
    const first = port.dispatch(call);
    await started;
    await expect(port.dispatch(call)).rejects.toThrow(/unresolved/);
    release();
    expect((await first).result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('original') });
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
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

  it('rechecks Stop after the durable effect marker and before a synthetic executor', async () => {
    const tools = [tool('worker_search')];
    const executor = jest.fn(async () => ({ unsafe: true }));
    const executors = { worker_search: executor };
    const receipt = await prepareNativeInvocation(owner('marker-stop', nativeToolInventoryDigest(tools, undefined, executors)));
    await submitNativeInvocation(receipt);
    const stop = new AbortController();
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-a', async () => undefined), signal: stop.signal });
    const originalRename = fs.rename.bind(fs);
    let toolWrites = 0;
    const rename = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(to).startsWith(path.join(directory, 'tools', receipt.invocationId))) {
        toolWrites += 1;
        if (toolWrites === 2) stop.abort();
      }
    });
    try {
      await expect(port.dispatch({ toolInvocationId: 'sdk-stop', name: 'worker_search', args: {},
        signal: new AbortController().signal })).rejects.toThrow();
    } finally { rename.mockRestore(); }
    expect(toolWrites).toBe(2);
    expect(executor).not.toHaveBeenCalled();
  });

  it('keeps a terminal receipt but never returns success after Stop during its final write', async () => {
    const tools = [tool('worker_search')];
    const executor = jest.fn(async () => ({ done: true }));
    const executors = { worker_search: executor };
    const receipt = await prepareNativeInvocation(owner('finish-stop', nativeToolInventoryDigest(tools, undefined, executors)));
    await submitNativeInvocation(receipt);
    const stop = new AbortController();
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-a', async () => undefined), signal: stop.signal });
    const originalRename = fs.rename.bind(fs);
    let toolWrites = 0;
    const rename = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(to).startsWith(path.join(directory, 'tools', receipt.invocationId))) {
        toolWrites += 1;
        if (toolWrites === 3) stop.abort();
      }
    });
    const call = { toolInvocationId: 'sdk-finish-stop', name: 'worker_search', args: {},
      signal: new AbortController().signal };
    try { await expect(port.dispatch(call)).rejects.toThrow(); }
    finally { rename.mockRestore(); }
    expect(toolWrites).toBe(3);
    expect(executor).toHaveBeenCalledTimes(1);
    await expect(port.dispatch(call)).rejects.toThrow();
    expect(executor).toHaveBeenCalledTimes(1);
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

  it('rechecks MCP identity after the marker write and before callTool', async () => {
    const tools = [tool('worker_mcp')];
    const mapping = { worker_mcp: { server: 'worker-server', tool: 'write',
      clientGeneration: 7, schemaHash: 'schema-a' } };
    const receipt = await prepareNativeInvocation(owner('marker-identity', nativeToolInventoryDigest(tools, mapping)));
    await submitNativeInvocation(receipt);
    let generation = 7;
    const callTool = jest.fn(async () => ({ success: true, data: { content: [{ type: 'text', text: 'unsafe' }] } }));
    const service = { getClient: () => ({}), getClientGeneration: () => generation,
      getToolSchemaHash: () => 'schema-a', callTool } as unknown as Parameters<typeof createNativeToolPort>[0]['service'];
    const port = createNativeToolPort({ receipt, tools, toolNameMap: mapping, service,
      authority: createNativeBrokerAuthority('lease-a', async () => undefined),
      signal: new AbortController().signal });
    const originalRename = fs.rename.bind(fs);
    let toolWrites = 0;
    const rename = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(to).startsWith(path.join(directory, 'tools', receipt.invocationId))) {
        toolWrites += 1;
        if (toolWrites === 2) generation = 8;
      }
    });
    try {
      await expect(port.dispatch({ toolInvocationId: 'sdk-identity', name: 'worker_mcp', args: {},
        signal: new AbortController().signal })).rejects.toThrow(/effect boundary/);
    } finally { rename.mockRestore(); }
    expect(toolWrites).toBe(2);
    expect(callTool).not.toHaveBeenCalled();
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

  it('rejects strict handoff inventory before creating a native invocation', () => {
    const tools: OpenAI.ChatCompletionFunctionTool[] = [{
      type: 'function', function: { name: 'handoff_to_worker', description: 'Spawn worker',
        parameters: { type: 'object', properties: { task: { type: 'string' } } },
      },
    }];
    expect(() => nativeToolInventoryDigest(tools)).toThrow(/confirmed SDK termination protocol/);
  });
});
