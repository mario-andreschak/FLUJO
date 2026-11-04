/**
 * Workspace switches for reaching a model without a flow.
 *
 * Each way in is driven through its real route or runFlow, against a throwaway
 * data directory. A switch only means something if no route is left open, so the
 * cases name each route, and the default-on cases pin that existing installs are
 * unchanged. The model service is the observed boundary: nothing may reach it.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { makeLocalRequest } from '../utils/localRequest';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import type { Flow } from '@/shared/types/flow';

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));

const mockGenerate = jest.fn(async () => ({
  success: true,
  response: { id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [] },
}));
const mockModels = [{ id: 'm1', name: 'listed', displayName: 'Listed', provider: 'openai', adapter: 'openai', ApiKey: '' }];

const quickChatFlow = (id: string): Flow => ({
  id,
  name: 'Quick Chat',
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } },
    { id: 'end', type: 'finish', position: { x: 0, y: 1 }, data: { label: 'End', type: 'finish', properties: {} } },
  ],
  edges: [{ id: 'e', source: 'start', target: 'end', data: { edgeType: 'standard' } }],
} as unknown as Flow);

describe('model access switches', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let saveItem: typeof import('@/utils/storage/backend').saveItem;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-model-access-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    global.__flujo_flowsCache = null;
    global.__flujo_flowsMigration = undefined;
    jest.resetModules();
    jest.doMock('@/backend/services/model', () => ({
      modelService: {
        generateChatCompletion: mockGenerate,
        loadModels: async () => mockModels,
        getModel: async (id: string) => mockModels.find((model) => model.id === id) ?? null,
      },
    }));
    mockGenerate.mockClear();
    ({ saveItem } = await import('@/utils/storage/backend'));
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const switches = (modelAccess: Settings['modelAccess']) =>
    saveItem(StorageKey.SPEECH_SETTINGS, { speech: {}, modelAccess } as unknown as Settings);

  const direct = async (model: string) => {
    const { processChatCompletion } = await import('@/app/v1/chat/completions/chatCompletionService');
    return processChatCompletion({ model, messages: [{ role: 'user', content: 'Hello' }] } as never, false, false, false);
  };

  describe('direct model calls', () => {
    it.each(['model-anything', 'policy/anything'])('refuses %s when switched off', async (model) => {
      await switches({ directModelCalls: false });

      const response = await direct(model);

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('direct_model_calls_disabled');
      expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('reaches the model service by default', async () => {
      await direct('model-anything');
      expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('stays on when only Quick Chat is switched off', async () => {
      await switches({ quickChat: false });
      await direct('model-anything');
      expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('takes models off the list when switched off', async () => {
      const { GET } = await import('@/app/v1/models/route');
      const ids = async () => (await (await GET(new Request('http://localhost/v1/models?workspace=default-workspace'))).json()).data.map((entry: { id: string }) => entry.id);

      expect(await ids()).toContain('model-Listed');
      await switches({ directModelCalls: false });
      expect((await ids()).filter((id: string) => id.startsWith('model-') || id.startsWith('policy/'))).toEqual([]);
    });
  });

  describe('Quick Chat', () => {
    const post = (url: string, body: unknown) => makeLocalRequest({ url, body });

    it('refuses to build a Quick Chat flow when switched off', async () => {
      await switches({ quickChat: false });
      const { POST } = await import('@/app/api/flow/quick-chat/route');

      const response = await POST(post('http://localhost/api/flow/quick-chat', { modelId: 'm1' }));

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('quick_chat_disabled');
    });

    it('still builds a Quick Chat flow by default', async () => {
      const { POST } = await import('@/app/api/flow/quick-chat/route');
      const response = await POST(post('http://localhost/api/flow/quick-chat', { modelId: 'm1' }));
      // The fixture has no real model, so the request ends at the model lookup. It
      // only matters here that the switch did not stop it first.
      expect(response.status).not.toBe(403);
      expect((await response.json()).code).toBeUndefined();
    });

    it('refuses to prepare the Flow Generator when switched off', async () => {
      await switches({ quickChat: false });
      const { POST } = await import('@/app/api/flow/generator/route');

      const response = await POST(post('http://localhost/api/flow/generator', { conversationId: 'c1', modelId: 'm1' }));

      expect(response.status).toBe(403);
    });

    it.each([
      ['a graph supplied by the client', { flowId: 'any-flow-id', flowSnapshot: quickChatFlow('any-flow-id') }],
      ['a Quick Chat id without a graph', { flowId: 'quickchat-c1' }],
    ])('refuses to create a conversation from %s when switched off', async (_label, fields) => {
      await switches({ quickChat: false });
      const { POST } = await import('@/app/v1/chat/conversations/route');

      const response = await POST(post('http://localhost/v1/chat/conversations', {
        id: 'c1', title: 'Chat', createdAt: 1, updatedAt: 1, ...fields,
      }));

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('quick_chat_disabled');
    });

    it('still creates a conversation for a saved flow when switched off', async () => {
      await switches({ quickChat: false });
      const { POST } = await import('@/app/v1/chat/conversations/route');

      const response = await POST(post('http://localhost/v1/chat/conversations', {
        id: 'c2', title: 'Chat', flowId: 'saved-flow', createdAt: 1, updatedAt: 1,
      }));

      expect(response.status).toBeLessThan(300);
    });

    it('stops a Quick Chat run, so an existing conversation cannot continue', async () => {
      await switches({ quickChat: false });
      const { runFlow } = await import('@/backend/execution/flow/runFlow');

      const result = await runFlow({
        flowDefinition: quickChatFlow('quickchat-existing'),
        prompt: 'Hello',
        source: 'api',
        mode: 'ephemeral',
        emit: () => undefined,
      });

      expect(result.status).toBe('error');
      expect(result.error?.details).toMatchObject({ code: 'quick_chat_disabled', status: 403 });
    });

    it('lets the same run finish by default', async () => {
      const { runFlow } = await import('@/backend/execution/flow/runFlow');

      const result = await runFlow({
        flowDefinition: quickChatFlow('quickchat-existing'),
        prompt: 'Hello',
        source: 'api',
        mode: 'ephemeral',
        emit: () => undefined,
      });

      expect(result.error?.details?.code).not.toBe('quick_chat_disabled');
    });

    it('keeps saved flows running when switched off', async () => {
      await switches({ quickChat: false, directModelCalls: false });
      const { runFlow } = await import('@/backend/execution/flow/runFlow');

      const result = await runFlow({
        flowDefinition: quickChatFlow('saved-flow'),
        prompt: 'Hello',
        source: 'api',
        mode: 'ephemeral',
        emit: () => undefined,
      });

      expect(result.error?.details?.code).not.toBe('quick_chat_disabled');
    });
  });
});
