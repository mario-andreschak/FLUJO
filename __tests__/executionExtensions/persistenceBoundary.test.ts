import type { SharedState } from '@/backend/execution/flow/types';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { registerExecutionExtension, runWithExecutionConversationAccess } from '@/backend/execution/extensions';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';
import type { StorageKey } from '@/shared/types/storage';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@/utils/storage/backend', () => ({ saveItem: jest.fn(), loadItem: jest.fn(), assertSafeCollectionId: jest.fn() }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({ persistConversationSummary: jest.fn() }));

describe('private context persistence and reloaded protected conversation boundary', () => {
  let restore: () => void;
  beforeEach(() => { jest.clearAllMocks(); FlowExecutor.conversationStates.clear(); });
  afterEach(() => restore?.());
  test('even an enumerable run capability never reaches the durable snapshot', async () => {
    const adapter = fixtureAdapter(); restore = registerExecutionExtension(adapter);
    const run = fixtureRun(); const context = mintFixture(adapter, run);
    const state = { conversationId: run.conversation, executionExtensionOwned: true, executionExtensionContext: context,
      messages: [{ role: 'user', content: 'own inquiry' }], flowSnapshot: { id: 'one-shared-graph', nodes: [], edges: [] } } as unknown as SharedState;
    await persistConversationState(`conversations/${run.conversation}` as StorageKey, state);
    const durable = jest.mocked(saveItem).mock.calls[0][1] as Record<string, unknown>;
    expect(durable.executionExtensionContext).toBeUndefined();
    expect(durable.executionExtensionOwned).toBe(true);
    expect(JSON.stringify(durable)).not.toContain(run.privateMarker);
    expect(JSON.stringify(durable)).not.toContain('executionExtensionContext');
    expect(state.executionExtensionContext).toBe(context);
  });

  test('reload without fresh authority cannot persist an owned conversation', async () => {
    restore = registerExecutionExtension(fixtureAdapter());
    const state = { conversationId: 'conversation-A', executionExtensionOwned: true, messages: [] } as unknown as SharedState;
    await expect(persistConversationState('conversations/conversation-A' as StorageKey, state)).rejects.toThrow('trusted_execution_context_required');
    expect(saveItem).not.toHaveBeenCalled();
  });

  test('revoked authority cannot commit even if its old capability remains in live state', async () => {
    const adapter = fixtureAdapter(); restore = registerExecutionExtension(adapter);
    const run = fixtureRun(); const context = mintFixture(adapter, run); run.revoked = true;
    const state = { conversationId: run.conversation, executionExtensionOwned: true, executionExtensionContext: context,
      messages: [] } as unknown as SharedState;
    await expect(persistConversationState(`conversations/${run.conversation}` as StorageKey, state)).rejects.toThrow('fixture_authorization_denied');
    expect(saveItem).not.toHaveBeenCalled();
  });

  test('an owner guard rejects before cached or durable state is read', async () => {
    const deny = jest.fn(async () => { throw new Error('foreign-owner'); });
    restore = registerExecutionExtension(fixtureAdapter({ assertConversationAccess: deny }));
    FlowExecutor.conversationStates.set('conversation-B', { messages: [{ role: 'assistant', content: 'B-secret' }] } as unknown as SharedState);
    await expect(loadConversationStateReadOnly('conversation-B')).rejects.toThrow('foreign-owner');
    expect(loadItem).not.toHaveBeenCalled();
    expect(deny).toHaveBeenCalledWith('conversation-B');
  });

  test('authenticated A read scope cannot authorize B or survive revocation', async () => {
    const adapter = fixtureAdapter({ assertConversationAccess: async () => { throw new Error('foreign-owner'); } });
    restore = registerExecutionExtension(adapter);
    const own = { executionExtensionOwned: true, messages: [{ role: 'assistant', content: 'A-only' }] } as unknown as SharedState;
    FlowExecutor.conversationStates.set('conversation-A', own);
    FlowExecutor.conversationStates.set('conversation-B', { ...own, messages: [] });
    let revoked = false;
    const current = async () => { if (revoked) throw new Error('revoked'); };
    await runWithExecutionConversationAccess('conversation-A', current, async () => {
      await expect(loadConversationStateReadOnly('conversation-A')).resolves.toBe(own);
      await expect(loadConversationStateReadOnly('conversation-B')).rejects.toThrow('foreign-owner');
      revoked = true;
      await expect(loadConversationStateReadOnly('conversation-A')).rejects.toThrow('revoked');
    });
    expect(loadItem).not.toHaveBeenCalled();
  });
});
