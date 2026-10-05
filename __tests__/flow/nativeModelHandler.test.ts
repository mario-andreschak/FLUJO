import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { CompletionInput, CompletionResult } from '@/backend/services/model/adapters/types';
import type { FlujoChatMessage } from '@/shared/types/chat';

const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
const createCompletionMock = jest.fn();
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: (...args: unknown[]) => getModelMock(...args),
  resolveAndDecryptApiKey: (...args: unknown[]) => resolveKeyMock(...args),
} }));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: (input: CompletionInput) => createCompletionMock(input) }),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { _setNativeToolJournalRootForTests } from '@/backend/execution/flow/handlers/nativeToolJournal';
import { _setModelTurnArchiveDirForTests } from '@/backend/execution/flow/modelTurnArchive';
import { createNativeBrokerAuthority } from '@/backend/execution/flow/handlers/nativeToolBroker';
import { createNativeLineageRootBinding } from '@/backend/execution/flow/handlers/nativeOriginLineage';
import { createNativeInvocationSessionHook, type NativeInvocationSession } from '@/backend/execution/flow/handlers/nativeInvocationSession';
import { _setNativeSessionPayloadRootForTests, readNativeSessionPayload } from '@/backend/execution/flow/handlers/nativeSessionPayload';
import { saveCollectionItem } from '@/utils/storage/backend';

const message: FlujoChatMessage = { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 };
const completion = (terminal: boolean): CompletionResult => ({
  nativeSdkTerminal: terminal,
  completion: {
    id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-native',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null,
      message: { role: 'assistant', content: 'done', refusal: null } }],
  },
});
const invoke = (conversationId: string, overrides: Record<string, unknown> = {},
  tools: OpenAI.ChatCompletionFunctionTool[] = []) => (
  ModelHandler as unknown as { generateCompletion: (
    modelId: string, prompt: string, messages: FlujoChatMessage[], tools: OpenAI.ChatCompletionFunctionTool[],
    options: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: { message: string } }> }
).generateCompletion('model-native', '', [message], tools, {
  conversationId, runId: 'run-native', nodeId: 'node-native',
  nativeBrokerAuthority: createNativeBrokerAuthority('lease-1', async () => undefined),
  ...overrides,
});

describe('ModelHandler native SDK receipt boundary', () => {
  let directory: string;
  let priorArchiveDir: string | undefined;
  let priorDataDir: string | undefined;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-native-model-handler-'));
    priorDataDir = process.env.FLUJO_DATA_DIR;
    process.env.FLUJO_DATA_DIR = directory;
    _setNativeToolJournalRootForTests(path.join(directory, 'journal'));
    _setNativeSessionPayloadRootForTests(path.join(directory, 'session-payloads'));
    priorArchiveDir = _setModelTurnArchiveDirForTests(path.join(directory, 'archive'));
    getModelMock.mockReset().mockResolvedValue({
      id: 'model-native', name: 'fixture-native', displayName: 'Fixture native',
      provider: 'openai', adapter: 'codex-cli', ApiKey: 'fixture-key',
      inputModalities: ['text'], outputModalities: ['text'],
    });
    resolveKeyMock.mockReset().mockResolvedValue('fixture-key');
    createCompletionMock.mockReset();
  });
  afterEach(async () => {
    _setNativeToolJournalRootForTests(undefined);
    _setNativeSessionPayloadRootForTests(undefined);
    _setModelTurnArchiveDirForTests(priorArchiveDir);
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const saveRoot = async (conversationId: string) => saveCollectionItem('conversations', conversationId, {
    conversationId, title: conversationId, createdAt: Date.now(), updatedAt: Date.now(),
    flowId: 'flow-native', logicalRunId: 'run-native', currentNodeId: 'node-native',
    source: 'api', status: 'running', runDepth: 0,
  });
  const binding = (conversationId: string, assertCurrent: () => Promise<void> = async () => undefined) => createNativeLineageRootBinding({
    fleetRunId: `fleet-${conversationId}`, workerId: 'worker-1', goalId: 'goal-1',
    workspace: 'default-workspace', rootConversationId: conversationId,
    rootLogicalRunId: 'run-native', rootFlowId: 'flow-native',
  }, assertCurrent);

  it('archives before one SDK start and allows a fresh successor only after confirmed terminal', async () => {
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: { test: true } });
      expect(id).toBe(input.nativeToolPort?.invocationId);
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
      return completion(true);
    });
    expect((await invoke('success')).success).toBe(true);
    expect((await invoke('success')).success).toBe(true);
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
  });

  it('publishes one bounded archived original before the adapter can issue its SDK call', async () => {
    await saveRoot('session-success');
    const order: string[] = [];
    const events: string[] = [];
    let published: NativeInvocationSession | undefined;
    const hook = createNativeInvocationSessionHook({
      root: binding('session-success'),
      publish: async session => {
        order.push('publish');
        published = session;
        expect(session.phase()).toBe('prepared');
        expect(Buffer.byteLength(JSON.stringify(session.descriptor))).toBeLessThan(16 * 1024);
        const payload = await readNativeSessionPayload(session.descriptor.payloadRef);
        expect(payload.archive.sdkRequest).toEqual({ test: 'saved SDK input', large: 'x'.repeat(20 * 1024) });
        expect(payload.inventory.tools).toEqual([]);
        expect(session.descriptor.receipt.owner.inputDigest)
          .not.toBe(session.descriptor.archive.sanitizedSdkRequestDigest);
        session.subscribe(event => { events.push(event.kind); });
      },
      acknowledgeLive: async () => { order.push('live-ack'); },
      acknowledgeSdkOutcome: async () => { order.push('outcome-ack'); },
      acknowledgeTerminalReady: async () => { order.push('terminal-ack'); },
    });
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      order.push('adapter-entry');
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed',
        request: { test: 'saved SDK input', large: 'x'.repeat(20 * 1024) } });
      order.push('sdk-issue');
      expect(id).toBe(input.nativeToolPort?.invocationId);
      await input.onNativeSdkLive!();
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
      return completion(true);
    });
    expect((await invoke('session-success', { nativeInvocationSessionHook: hook })).success).toBe(true);
    expect(order).toEqual(['adapter-entry', 'publish', 'sdk-issue', 'live-ack', 'outcome-ack', 'terminal-ack']);
    expect(events).toEqual(['issue-uncertain', 'confirmed-live', 'sdk-finished', 'sdk-outcome', 'terminal']);
    expect(await published!.waitTerminal()).toEqual({ state: 'terminal', outcome: 'completed' });
    expect(published!.phase()).toBe('terminal');
    const ref = published!.descriptor.payloadRef;
    await fs.writeFile(path.join(directory, 'session-payloads', ref.invocationId, `${ref.sha256}.json`), 'changed');
    await expect(readNativeSessionPayload(ref)).rejects.toThrow();
  });

  it('holds the original ID and prevents SDK issue when publication or its lease fails', async () => {
    for (const mode of ['rejected', 'revoked'] as const) {
      const conversationId = `session-${mode}`;
      await saveRoot(conversationId);
      let current = true;
      let sdkIssued = false;
      const lease = createNativeBrokerAuthority('lease-1', async () => {
        if (!current) throw new Error('Worker lease revoked');
      });
      const hook = createNativeInvocationSessionHook({
        root: binding(conversationId),
        publish: async () => {
          await Promise.resolve();
          if (mode === 'rejected') throw new Error('Host write-ahead accept failed');
          current = false;
        },
        acknowledgeLive: async () => undefined,
        acknowledgeSdkOutcome: async () => undefined,
        acknowledgeTerminalReady: async () => undefined,
      });
      createCompletionMock.mockImplementation(async (input: CompletionInput) => {
        await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
        sdkIssued = true;
        return completion(true);
      });
      expect((await invoke(conversationId, { nativeBrokerAuthority: lease,
        nativeInvocationSessionHook: hook })).success).toBe(false);
      expect(sdkIssued).toBe(false);
      expect((await invoke(conversationId)).success).toBe(false);
    }
  });

  it('holds before SDK issue when the root is revoked during publication', async () => {
    await saveRoot('session-root-revoked');
    let rootCurrent = true;
    let sdkIssued = false;
    const hook = createNativeInvocationSessionHook({
      root: binding('session-root-revoked', async () => {
        if (!rootCurrent) throw new Error('Root generation changed');
      }),
      publish: async () => { await Promise.resolve(); rootCurrent = false; },
      acknowledgeLive: async () => undefined,
      acknowledgeSdkOutcome: async () => undefined,
      acknowledgeTerminalReady: async () => undefined,
    });
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      sdkIssued = true;
      return completion(true);
    });
    expect((await invoke('session-root-revoked', { nativeInvocationSessionHook: hook })).success).toBe(false);
    expect(sdkIssued).toBe(false);
    expect((await invoke('session-root-revoked')).success).toBe(false);
  });

  it('holds before SDK issue when the root is revoked while saving the private payload', async () => {
    await saveRoot('session-payload-revoked');
    let rootCurrent = true;
    let sdkIssued = false;
    const hook = createNativeInvocationSessionHook({
      root: binding('session-payload-revoked', async () => {
        if (!rootCurrent) throw new Error('Root generation changed');
      }),
      publish: async () => undefined,
      acknowledgeLive: async () => undefined,
      acknowledgeSdkOutcome: async () => undefined,
      acknowledgeTerminalReady: async () => undefined,
    });
    const link = fs.link.bind(fs);
    const spy = jest.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      await link(source, target);
      if (String(target).includes('session-payloads')) rootCurrent = false;
    });
    try {
      createCompletionMock.mockImplementation(async (input: CompletionInput) => {
        await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
        sdkIssued = true;
        return completion(true);
      });
      expect((await invoke('session-payload-revoked', { nativeInvocationSessionHook: hook })).success).toBe(false);
      expect(sdkIssued).toBe(false);
      expect((await invoke('session-payload-revoked')).success).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('rechecks cancellation after the issue-uncertain notification', async () => {
    await saveRoot('session-event-cancel');
    let sdkIssued = false;
    let published: NativeInvocationSession | undefined;
    const hook = createNativeInvocationSessionHook({
      root: binding('session-event-cancel'),
      publish: async session => {
        published = session;
        session.subscribe(event => { if (event.kind === 'issue-uncertain') session.cancel(); });
      },
      acknowledgeLive: async () => undefined,
      acknowledgeSdkOutcome: async () => undefined,
      acknowledgeTerminalReady: async () => undefined,
    });
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      sdkIssued = true;
      return completion(true);
    });
    expect((await invoke('session-event-cancel', { nativeInvocationSessionHook: hook })).success).toBe(false);
    expect(sdkIssued).toBe(false);
    expect(published!.signal.aborted).toBe(true);
    expect(await published!.waitTerminal()).toEqual({ state: 'held' });
  });

  it('holds a finished SDK stream when Stop arrives during outcome acknowledgement', async () => {
    await saveRoot('session-outcome-delay');
    let published: NativeInvocationSession | undefined;
    let enterAck!: () => void;
    let releaseAck!: () => void;
    const ackEntered = new Promise<void>(resolve => { enterAck = resolve; });
    const ackReleased = new Promise<void>(resolve => { releaseAck = resolve; });
    const hook = createNativeInvocationSessionHook({
      root: binding('session-outcome-delay'),
      publish: async session => { published = session; },
      acknowledgeLive: async () => undefined,
      acknowledgeSdkOutcome: async () => { enterAck(); await ackReleased; },
      acknowledgeTerminalReady: async () => undefined,
    });
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      await input.onNativeSdkLive!();
      input.onNativeSdkFinished!();
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
      return completion(true);
    });
    const result = invoke('session-outcome-delay', { nativeInvocationSessionHook: hook });
    await ackEntered;
    expect(published!.phase()).toBe('sdk-finished');
    published!.cancel();
    expect(published!.signal.aborted).toBe(true);
    releaseAck();
    expect((await result).success).toBe(false);
    expect(await published!.waitTerminal()).toEqual({ state: 'held' });
    expect((await invoke('session-outcome-delay')).success).toBe(false);
  });

  it('holds after a lost terminal acknowledgement and settles the original session as held', async () => {
    await saveRoot('session-terminal-loss');
    let published: NativeInvocationSession | undefined;
    const hook = createNativeInvocationSessionHook({
      root: binding('session-terminal-loss'),
      publish: async session => { published = session; },
      acknowledgeLive: async () => undefined,
      acknowledgeSdkOutcome: async () => undefined,
      acknowledgeTerminalReady: async () => { throw new Error('Host terminal-ready acknowledgement lost'); },
    });
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      await input.onNativeSdkLive!();
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
      return completion(true);
    });
    expect((await invoke('session-terminal-loss', { nativeInvocationSessionHook: hook })).success).toBe(false);
    expect(await published!.waitTerminal()).toEqual({ state: 'held' });
    expect((await invoke('session-terminal-loss')).success).toBe(false);
  });

  it('holds an already issued original when live observation cannot be acknowledged', async () => {
    await saveRoot('session-live-loss');
    let sdkIssued = false;
    let published: NativeInvocationSession | undefined;
    const events: string[] = [];
    const hook = createNativeInvocationSessionHook({
      root: binding('session-live-loss'),
      publish: async session => { published = session; session.subscribe(event => { events.push(event.kind); }); },
      acknowledgeLive: async () => { throw new Error('Host live acknowledgement lost'); },
      acknowledgeSdkOutcome: async () => undefined,
      acknowledgeTerminalReady: async () => undefined,
    });
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      sdkIssued = true;
      await input.onNativeSdkLive!();
      return completion(true);
    });
    expect((await invoke('session-live-loss', { nativeInvocationSessionHook: hook })).success).toBe(false);
    expect(sdkIssued).toBe(true);
    expect(events).toEqual(['issue-uncertain', 'held']);
    expect(await published!.waitTerminal()).toEqual({ state: 'held' });
    expect((await invoke('session-live-loss')).success).toBe(false);
  });

  it('binds session cancellation to the original adapter signal before issue', async () => {
    await saveRoot('session-cancel');
    let sdkIssued = false;
    let published: NativeInvocationSession | undefined;
    const hook = createNativeInvocationSessionHook({
      root: binding('session-cancel'),
      publish: async session => { published = session; session.cancel(); },
      acknowledgeLive: async () => undefined,
      acknowledgeSdkOutcome: async () => undefined,
      acknowledgeTerminalReady: async () => undefined,
    });
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      sdkIssued = true;
      return completion(true);
    });
    expect((await invoke('session-cancel', { nativeInvocationSessionHook: hook })).success).toBe(false);
    expect(sdkIssued).toBe(false);
    expect(published!.signal.aborted).toBe(true);
    expect(await published!.waitTerminal()).toEqual({ state: 'held' });
  });

  it('rejects a JSON-shaped session hook before adapter entry', async () => {
    const real = createNativeInvocationSessionHook({
      root: binding('session-json'), publish: async () => undefined,
      acknowledgeLive: async () => undefined,
      acknowledgeSdkOutcome: async () => undefined,
      acknowledgeTerminalReady: async () => undefined,
    });
    expect((await invoke('session-json', { nativeInvocationSessionHook: JSON.parse(JSON.stringify(real)) })).success)
      .toBe(false);
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it('holds normal EOF without a native terminal event and never retries the SDK', async () => {
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
      return completion(false);
    });
    expect((await invoke('eof')).success).toBe(false);
    expect((await invoke('eof')).success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an error SDK outcome unresolved even if an adapter resolves with a terminal-shaped value', async () => {
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'error' });
      return completion(true);
    });
    expect((await invoke('error-outcome')).success).toBe(false);
    expect((await invoke('error-outcome')).success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when archive persistence fails before SDK start', async () => {
    const archiveFile = path.join(directory, 'archive-file');
    await fs.writeFile(archiveFile, 'not a directory');
    _setModelTurnArchiveDirForTests(archiveFile);
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      throw new Error('SDK should not start');
    });
    expect((await invoke('archive-failure')).success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    // The adapter stub reached only its write-ahead callback; no provider call was made.
    const calls = await fs.readdir(path.join(directory, 'journal', 'calls'));
    expect(calls).toHaveLength(1);
    const receipt = JSON.parse(await fs.readFile(path.join(directory, 'journal', 'calls', calls[0]), 'utf8'));
    expect(receipt.state).toBe('unknown');
  });

  it('holds the original SDK invocation when outcome persistence loses its acknowledgement', async () => {
    const archiveFile = path.join(directory, 'outcome-file');
    await fs.writeFile(archiveFile, 'not a directory');
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      _setModelTurnArchiveDirForTests(archiveFile);
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
      return completion(true);
    });
    expect((await invoke('ack-loss')).success).toBe(false);
    expect((await invoke('ack-loss')).success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    const calls = await fs.readdir(path.join(directory, 'journal', 'calls'));
    const receipt = JSON.parse(await fs.readFile(path.join(directory, 'journal', 'calls', calls[0]), 'utf8'));
    expect(receipt.state).toBe('unknown');
  });

  it('cancels the original SDK signal and holds its receipt without a second start', async () => {
    let stop = false;
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      stop = true;
      await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('cancelled');
    });
    expect((await invoke('stop', { shouldAbort: () => stop })).success).toBe(false);
    expect((await invoke('stop', { shouldAbort: () => stop })).success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a JSON-shaped authority before creating a native SDK attempt', async () => {
    const fakeAuthority = JSON.parse(JSON.stringify(createNativeBrokerAuthority('lease-1', async () => undefined)));
    expect((await invoke('json-authority', { nativeBrokerAuthority: fakeAuthority })).success).toBe(false);
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it('rejects strict handoff tools before an SDK request or invocation receipt', async () => {
    const handoff: OpenAI.ChatCompletionFunctionTool = { type: 'function', function: {
      name: 'handoff_to_worker', description: 'Spawn worker',
      parameters: { type: 'object', properties: { task: { type: 'string' } } },
    } };
    expect((await invoke('handoff', {}, [handoff])).success).toBe(false);
    expect(createCompletionMock).not.toHaveBeenCalled();
    await expect(fs.readdir(path.join(directory, 'journal', 'calls'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['completed', 'held', 'preflight'] as const)(
    'stops cancellation polling after a %s native return', async outcome => {
      let polls = 0;
      const shouldAbort = () => { polls += 1; return false; };
      createCompletionMock.mockImplementation(async (input: CompletionInput) => {
        const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
        await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
        return completion(outcome === 'completed');
      });
      const handoff: OpenAI.ChatCompletionFunctionTool = { type: 'function', function: {
        name: 'handoff_to_worker', description: 'Spawn worker',
        parameters: { type: 'object', properties: { task: { type: 'string' } } },
      } };
      const result = await invoke(`watch-${outcome}`, { shouldAbort }, outcome === 'preflight' ? [handoff] : []);
      expect(result.success).toBe(outcome === 'completed');
      expect(createCompletionMock).toHaveBeenCalledTimes(outcome === 'preflight' ? 0 : 1);
      const pollsAtReturn = polls;
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(polls).toBe(pollsAtReturn);
    },
  );

  it('keeps admission held when Stop lands during the terminal scope write', async () => {
    let stop = false;
    let rename: jest.SpyInstance | undefined;
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
      const originalRename = fs.rename.bind(fs);
      rename = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        await originalRename(from, to);
        if (String(to).startsWith(path.join(directory, 'journal', 'scopes'))) {
          stop = true;
          if (!input.signal!.aborted) {
            await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
          }
        }
      });
      return completion(true);
    });
    try {
      expect((await invoke('terminal-stop', { shouldAbort: () => stop })).success).toBe(false);
    } finally { rename?.mockRestore(); }
    expect((await invoke('terminal-stop')).success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(path.join(directory, 'journal', 'holds'))).toHaveLength(1);
  });

  it('keeps admission held when the native lease is revoked during terminal persistence', async () => {
    let current = true;
    let rename: jest.SpyInstance | undefined;
    const authority = createNativeBrokerAuthority('lease-1', async () => {
      if (!current) throw new Error('lease revoked');
    });
    createCompletionMock.mockImplementation(async (input: CompletionInput) => {
      const id = await input.onSdkRequest!({ adapter: 'codex-cli', operation: 'thread.runStreamed', request: {} });
      await input.onSdkRequestResult!({ dispatchId: id!, outcome: 'completed' });
      const originalRename = fs.rename.bind(fs);
      rename = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        await originalRename(from, to);
        if (String(to).startsWith(path.join(directory, 'journal', 'scopes'))) current = false;
      });
      return completion(true);
    });
    try {
      expect((await invoke('terminal-lease', { nativeBrokerAuthority: authority })).success).toBe(false);
    } finally { rename?.mockRestore(); }
    expect((await invoke('terminal-lease')).success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(path.join(directory, 'journal', 'holds'))).toHaveLength(1);
  });
});
