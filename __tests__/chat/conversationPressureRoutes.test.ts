import { makeLocalRequest } from '../utils/localRequest';
import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => undefined) }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map(), clearFlowCache: jest.fn() },
}));
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(), loadCollectionItem: jest.fn(), deleteCollectionItem: jest.fn(),
  saveCollectionItem: jest.fn(), assertSafeCollectionId: jest.fn(),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({ persistConversationState: jest.fn() }));
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({ executionEventBus: { emit: jest.fn(), emitterFor: jest.fn() } }));
jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({ cancelPersonaFlowDispatch: jest.fn(), submitPersonaFlowDispatch: jest.fn() }));
jest.mock('@/backend/execution/flow/steeringInbox', () => ({ enqueueSteeringMessage: jest.fn(), clearSteeringInbox: jest.fn() }));
jest.mock('@/backend/execution/flow/conversationLog', () => ({ deleteConversationLog: jest.fn(), repairDanglingToolCalls: jest.fn(), appendRawForState: jest.fn() }));
jest.mock('@/backend/services/runResources', () => ({ deleteRunResources: jest.fn() }));
jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({ deleteConversationSummary: jest.fn() }));
jest.mock('@/backend/services/flow', () => ({ flowService: {} }));
jest.mock('@/backend/services/enduringAgents', () => ({}));
jest.mock('@/frontend/components/Chat', () => ({}));

import { POST as cancel } from '@/app/v1/chat/conversations/[conversationId]/cancel/route';
import { POST as inject } from '@/app/v1/chat/conversations/[conversationId]/inject/route';
import { DELETE as bulkDelete } from '@/app/v1/chat/conversations/route';
import { loadItem, loadCollectionItem, deleteCollectionItem } from '@/utils/storage/backend';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { cancelPersonaFlowDispatch, submitPersonaFlowDispatch } from '@/backend/services/enduringAgents/personaDispatcher';
import { enqueueSteeringMessage } from '@/backend/execution/flow/steeringInbox';
import { deleteConversationLog } from '@/backend/execution/flow/conversationLog';
import { deleteRunResources } from '@/backend/services/runResources';
import { deleteConversationSummary } from '@/backend/execution/flow/conversationSummaryStore';
import { isConversationDeleted, unmarkConversationDeleted } from '@/backend/execution/flow/cancellation';

const ids = Array.from({ length: 11 }, (_, i) => `pressure-delete-${i}`);
beforeEach(() => {
  jest.clearAllMocks();
  FlowExecutor.conversationStates.clear();
  ids.forEach(unmarkConversationDeleted);
  (loadItem as jest.Mock).mockReset();
  (loadCollectionItem as jest.Mock).mockReset();
});
afterEach(() => ids.forEach(unmarkConversationDeleted));

it.each([
  ['busy', 'CONVERSATION_LOG_READ_BUSY', 429],
  ['memory', 'CONVERSATION_LOG_READ_MEMORY', 503],
] as const)('cold cancel and inject return retryable %s pressure without side effects', async (_, code, status) => {
  (loadItem as jest.Mock).mockRejectedValue(new ConversationLogReadPressureError(code, status));
  for (const handler of [cancel, inject]) {
    const response = await handler(makeLocalRequest({ body: { content: 'steer' } }), {
      params: Promise.resolve({ conversationId: 'cold-pressure' }),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(expect.objectContaining({ code }));
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  }
  expect(loadItem).toHaveBeenCalledTimes(2);
  expect(FlowExecutor.conversationStates.size).toBe(0);
  for (const effect of [persistConversationState, executionEventBus.emit, cancelPersonaFlowDispatch,
    submitPersonaFlowDispatch, enqueueSteeringMessage, deleteCollectionItem]) expect(effect).not.toHaveBeenCalled();
});

it('bulk deletion drains more than four cold records with at most four concurrent loads', async () => {
  let active = 0, maximum = 0;
  (loadCollectionItem as jest.Mock).mockImplementation(async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return undefined;
  });
  const response = await bulkDelete(makeLocalRequest({ body: { ids } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deleted: ids.length, errors: 0 });
  expect(maximum).toBe(4);
  expect(active).toBe(0);
  expect(loadCollectionItem).toHaveBeenCalledTimes(ids.length);
  for (const id of ids) {
    expect(deleteCollectionItem).toHaveBeenCalledWith('conversations', id);
    expect(deleteConversationLog).toHaveBeenCalledWith(id);
    expect(deleteRunResources).toHaveBeenCalledWith(id);
    expect(deleteConversationSummary).toHaveBeenCalledWith(id);
    expect(isConversationDeleted(id)).toBe(true);
  }
});

it('bulk pressure preserves successful deletions and reports only pressure ids as retryable', async () => {
  const retryable = ids.slice(2, 4);
  (loadCollectionItem as jest.Mock).mockImplementation(async (_collection, id) => {
    if (retryable.includes(id)) throw new ConversationLogReadPressureError('CONVERSATION_LOG_READ_BUSY', 429);
    return undefined;
  });
  const response = await bulkDelete(makeLocalRequest({ body: { ids: [...ids, '../unsafe'] } }));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toEqual({ deleted: 9, errors: 3, retryableIds: expect.arrayContaining(retryable), retryAfterSeconds: 5 });
  expect(result.retryableIds).toHaveLength(2);
  expect(response.headers.get('Retry-After')).toBe('5');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  for (const id of retryable) {
    expect(isConversationDeleted(id)).toBe(false);
    expect(deleteCollectionItem).not.toHaveBeenCalledWith('conversations', id);
    expect(deleteConversationLog).not.toHaveBeenCalledWith(id);
  }
  expect(deleteCollectionItem).toHaveBeenCalledTimes(9);
});
