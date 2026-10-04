import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import {
  ExecutionExtensionError,
  MAX_EXECUTION_MODEL_STEP_ORDINAL,
  issueExecutionModelStepContext,
  registerExecutionExtension,
  type ExecutionModelStepSlot,
} from '@/backend/execution/extensions';
import { modelService } from '@/backend/services/model';
import type { Model } from '@/shared/types/model';
import { fixtureAdapter, mintFixture } from './fixtureAdapter';

const mockAdapterCalled = jest.fn((..._args: unknown[]) => { throw new Error('provider adapter must not be selected'); });
jest.mock('@/backend/services/model/adapters', () => ({ getCompletionAdapter: (...args: unknown[]) => mockAdapterCalled(...args) }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));

const bound: Model = {
  id: 'bound-model', name: 'sha256:' + '1'.repeat(64), provider: 'openai', adapter: 'openai',
  baseUrl: 'https://communityai.invalid/v1', ApiKey: '',
  ownerCredentialBinding: { ownerId: 'owner-fixture', credentialId: 'credential-fixture' },
};

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  jest.restoreAllMocks();
  mockAdapterCalled.mockClear();
});

it('passes two closed Process slots to the owner without selecting a physical sender', async () => {
  const slots: ExecutionModelStepSlot[] = [];
  const issueModelStep = jest.fn(async (parent: object, _model: object, slot: ExecutionModelStepSlot) => {
    slots.push(slot);
    return { ...parent, step: slots.length };
  });
  const dispatchModelRequest = jest.fn(async () => { throw new Error('physical send forbidden'); });
  const owner = fixtureAdapter({ issueModelStep, dispatchModelRequest });
  restore = registerExecutionExtension(owner);
  const parent = mintFixture(owner);

  await issueExecutionModelStepContext(parent, bound, { nodeId: 'process-a', ordinal: 0 });
  await issueExecutionModelStepContext(parent, bound, { nodeId: 'process-a', ordinal: 1 });

  expect(slots).toEqual([{ nodeId: 'process-a', ordinal: 0 }, { nodeId: 'process-a', ordinal: 1 }]);
  expect(slots.every(slot => Object.isFrozen(slot) && Object.keys(slot).join(',') === 'nodeId,ordinal')).toBe(true);
  expect(dispatchModelRequest).not.toHaveBeenCalled();
  expect(mockAdapterCalled).not.toHaveBeenCalled();
});

it('refuses missing, malformed, and exhausted slot identities before calling the owner', async () => {
  const issueModelStep = jest.fn(async (parent: object) => ({ ...parent, step: 1 }));
  const owner = fixtureAdapter({ issueModelStep });
  restore = registerExecutionExtension(owner);
  const parent = mintFixture(owner);
  const invalid = [
    undefined,
    { nodeId: '', ordinal: 0 },
    { nodeId: 'process/a', ordinal: 0 },
    { nodeId: 'process', ordinal: -1 },
    { nodeId: 'process', ordinal: 0.5 },
    { nodeId: 'process', ordinal: MAX_EXECUTION_MODEL_STEP_ORDINAL + 1 },
    { nodeId: 'process', ordinal: 0, extra: 'caller metadata' },
    new Proxy({ nodeId: 'process', ordinal: 0 }, {}),
    Object.defineProperty({ nodeId: 'process' }, 'ordinal', { get: () => 0, enumerable: true }),
  ];
  for (const slot of invalid) {
    await expect(issueExecutionModelStepContext(parent, bound, slot as ExecutionModelStepSlot))
      .rejects.toMatchObject({ code: 'execution_model_step_slot_required' });
  }
  expect(issueModelStep).not.toHaveBeenCalled();
  expect(mockAdapterCalled).not.toHaveBeenCalled();
});

it('preserves owner slot mismatch and private-child reuse refusals without dispatch', async () => {
  const privateChild = { step: 'same-private-child', expires: Date.now() + 60_000, revoked: false };
  const issueModelStep = jest.fn(async (_parent: object, _model: object, slot: ExecutionModelStepSlot) => {
    if (slot.nodeId !== 'process-a') throw new ExecutionExtensionError('fixture_slot_mismatch');
    return privateChild;
  });
  const dispatchModelRequest = jest.fn(async () => { throw new Error('physical send forbidden'); });
  const owner = fixtureAdapter({ issueModelStep, dispatchModelRequest });
  restore = registerExecutionExtension(owner);
  const parent = mintFixture(owner);

  await expect(issueExecutionModelStepContext(parent, bound, { nodeId: 'process-b', ordinal: 0 }))
    .rejects.toMatchObject({ code: 'fixture_slot_mismatch' });
  await issueExecutionModelStepContext(parent, bound, { nodeId: 'process-a', ordinal: 0 });
  await expect(issueExecutionModelStepContext(parent, bound, { nodeId: 'process-a', ordinal: 1 }))
    .rejects.toMatchObject({ code: 'execution_model_step_reused' });
  expect(dispatchModelRequest).not.toHaveBeenCalled();
});

it('takes the Process ordinal in ModelHandler only for a bound call and stops at the owner HOLD', async () => {
  const issueModelStep = jest.fn(async () => { throw new ExecutionExtensionError('PHYSICAL_SEND_HOLD'); });
  const owner = fixtureAdapter({ issueModelStep });
  restore = registerExecutionExtension(owner);
  jest.spyOn(modelService, 'getModel').mockResolvedValue(bound);
  const takeModelStepOrdinal = jest.fn(() => 4);
  const input = {
    modelId: bound.id, prompt: 'offline fixture',
    messages: [{ id: 'u', role: 'user' as const, content: 'offline fixture', timestamp: 1 }],
    iteration: 1, maxIterations: 1, nodeId: 'process-a', nodeName: 'Process',
    executionExtensionContext: mintFixture(owner), takeModelStepOrdinal,
  };
  const result = await ModelHandler.callModel(input);
  expect(result.success).toBe(false);
  expect(takeModelStepOrdinal).toHaveBeenCalledTimes(1);
  expect(issueModelStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: bound.id }),
    { nodeId: 'process-a', ordinal: 4 });
  expect(mockAdapterCalled).not.toHaveBeenCalled();

  issueModelStep.mockClear();
  takeModelStepOrdinal.mockClear();
  const missing = await ModelHandler.callModel({ ...input, takeModelStepOrdinal: undefined });
  expect(missing.success).toBe(false);
  expect(issueModelStep).not.toHaveBeenCalled();
  expect(takeModelStepOrdinal).not.toHaveBeenCalled();
  expect(mockAdapterCalled).not.toHaveBeenCalled();
});
