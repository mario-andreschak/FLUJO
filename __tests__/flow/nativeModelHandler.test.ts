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
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-native-model-handler-'));
    _setNativeToolJournalRootForTests(path.join(directory, 'journal'));
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
    _setModelTurnArchiveDirForTests(priorArchiveDir);
    await fs.rm(directory, { recursive: true, force: true });
  });

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
