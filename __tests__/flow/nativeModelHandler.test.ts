import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const invoke = (conversationId: string, overrides: Record<string, unknown> = {}) => (
  ModelHandler as unknown as { generateCompletion: (
    modelId: string, prompt: string, messages: FlujoChatMessage[], tools: [], options: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: { message: string } }> }
).generateCompletion('model-native', '', [message], [], {
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
});
