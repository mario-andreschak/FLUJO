jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(), withConversationSnapshot: async (id: string, consume: (state: unknown, token: unknown) => Promise<unknown>) => jest.requireActual('@/backend/execution/flow/conversationLogReadAdmission').withConversationLogReadAdmission(100, async (token: unknown) => consume(await jest.requireMock('@/utils/storage/backend').loadItem(`conversations/${id}`), token)), assertSafeCollectionId: jest.fn() }));
jest.mock('@/backend/execution/flow/conversationLog', () => ({ recoverMessagesFromLog: jest.fn(), repairDanglingToolCalls: jest.fn(), appendRawForState: jest.fn() }));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({ persistConversationState: jest.fn() }));
jest.mock('@/backend/execution/flow/recoveryCheckpoint', () => ({ markDanglingToolEffectsUnknown: jest.fn(), reconcileInterruptedRecovery: jest.fn() }));
jest.mock('@/backend/execution/flow/conversationStateCache', () => ({ coalesceLoad: (_id: string, load: () => unknown) => load(), noteRead: jest.fn(), noteWrite: jest.fn() }));
jest.mock('@/backend/execution/extensions', () => ({ assertExecutionConversationAccess: jest.fn(), assertExecutionStateAccess: jest.fn(), isExecutionProtectedState: () => false }));
import { loadConversationState, loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { loadItem } from '@/utils/storage/backend';
import { recoverMessagesFromLog } from '@/backend/execution/flow/conversationLog';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
it.each([['CONVERSATION_LOG_READ_BUSY', 429], ['CONVERSATION_LOG_READ_MEMORY', 503]] as const)('propagates %s instead of not-found or cache adoption', async (code, status) => {
  jest.mocked(loadItem).mockResolvedValueOnce({ conversationId: 'cold', messages: [] });
  const pressure = new ConversationLogReadPressureError(code, status);
  jest.mocked(recoverMessagesFromLog).mockRejectedValueOnce(pressure);
  await expect(loadConversationState('cold')).rejects.toBe(pressure);
  expect(FlowExecutor.conversationStates.has('cold')).toBe(false);
});

it('propagates snapshot pressure through both cold load modes without recovery or cache adoption', async () => {
  jest.mocked(loadItem).mockRejectedValue(new ConversationLogReadPressureError('CONVERSATION_LOG_READ_MEMORY', 503));
  await expect(loadConversationState('snapshot-pressure')).rejects.toMatchObject({ status: 503 });
  await expect(loadConversationStateReadOnly('snapshot-pressure')).rejects.toMatchObject({ status: 503 });
  expect(FlowExecutor.conversationStates.has('snapshot-pressure')).toBe(false);
});
