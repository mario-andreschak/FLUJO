/**
 * Tests for the "AI decides" (llm-gate) poll evaluator: change-gated model
 * calls, daily budget, verdict parsing (fail-closed on garbage), and error
 * handling. The model service and completion adapter are mocked at the module
 * boundaries the evaluator lazy-imports.
 */
import { evaluateLlmGate, parseVerdict } from '@/backend/services/scheduler/triggers/llmGate';
import { hashResult } from '@/backend/services/scheduler/triggers/pollEvaluators';
import type { PlannedExecutionState } from '@/shared/types/plannedExecution';

const createCompletionMock = jest.fn();
const getModelMock = jest.fn();

jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...args: unknown[]) => getModelMock(...args),
    resolveAndDecryptApiKey: jest.fn(async () => 'test-key'),
  },
}));

jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({
    createCompletion: (...args: unknown[]) => createCompletionMock(...args),
  }),
}));

const gateConfig = (overrides: Record<string, unknown> = {}) => ({
  mode: 'llm-gate' as const,
  condition: 'any email mentions an invoice',
  modelId: 'model-1',
  ...overrides,
});

const modelAnswer = (text: string) => ({
  completion: { choices: [{ message: { content: text } }] },
});

const today = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  getModelMock.mockReset().mockResolvedValue({ id: 'model-1', name: 'small', ApiKey: 'enc' });
  createCompletionMock.mockReset().mockResolvedValue(modelAnswer('{"fire": true, "reason": "invoice found"}'));
});

describe('parseVerdict', () => {
  it.each([
    ['{"fire": true, "reason": "x"}', { fire: true, reason: 'x' }],
    ['Sure! ```json\n{"fire": false, "reason": "nothing"}\n```', { fire: false, reason: 'nothing' }],
    ['{"fire": "yes"}', null], // fire must be a boolean
    ['no json at all', null],
    ['{broken', null],
  ])('%s', (text, expected) => {
    expect(parseVerdict(text as string)).toEqual(expected);
  });
});

describe('evaluateLlmGate', () => {
  it('primes on first poll without calling the model', async () => {
    const result = await evaluateLlmGate({ v: 1 }, gateConfig(), {});
    expect(result.fire).toBe(false);
    expect(result.newState.lastHash).toBe(hashResult({ v: 1 }));
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it('skips the model when the result is unchanged', async () => {
    const state: PlannedExecutionState = { lastHash: hashResult({ v: 1 }) };
    const result = await evaluateLlmGate({ v: 1 }, gateConfig(), state);
    expect(result.fire).toBe(false);
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it('consults the model on change and fires on a positive verdict', async () => {
    const state: PlannedExecutionState = { lastHash: hashResult({ v: 1 }) };
    const result = await evaluateLlmGate({ v: 2 }, gateConfig(), state);

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    const input = createCompletionMock.mock.calls[0][0];
    expect(input.temperature).toBe(0);
    expect(input.messages[1].content).toContain('any email mentions an invoice');
    expect(input.messages[1].content).toContain('"v": 2');

    expect(result.fire).toBe(true);
    expect(result.summary).toBe('AI condition met');
    expect((result.context as { aiReason: string }).aiReason).toBe('invoice found');
    expect(result.newState.lastHash).toBe(hashResult({ v: 2 }));
    expect(result.newState.llmCallsDay).toBe(today);
    expect(result.newState.llmCallsCount).toBe(1);
  });

  it('does not fire on a negative verdict but still advances state', async () => {
    createCompletionMock.mockResolvedValue(modelAnswer('{"fire": false, "reason": "nothing new"}'));
    const state: PlannedExecutionState = { lastHash: hashResult({ v: 1 }), llmCallsDay: today, llmCallsCount: 3 };
    const result = await evaluateLlmGate({ v: 2 }, gateConfig(), state);
    expect(result.fire).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.newState.llmCallsCount).toBe(4);
    expect(result.newState.lastHash).toBe(hashResult({ v: 2 }));
  });

  it('fails closed on unparseable model output', async () => {
    createCompletionMock.mockResolvedValue(modelAnswer('I think you should probably run it!'));
    const state: PlannedExecutionState = { lastHash: hashResult({ v: 1 }) };
    const result = await evaluateLlmGate({ v: 2 }, gateConfig(), state);
    expect(result.fire).toBe(false);
    expect(result.error).toMatch(/unreadable answer/);
    // The call still counts against the budget.
    expect(result.newState.llmCallsCount).toBe(1);
  });

  it('enforces the daily budget and resets it on day rollover', async () => {
    const state: PlannedExecutionState = {
      lastHash: hashResult({ v: 1 }),
      llmCallsDay: today,
      llmCallsCount: 2,
    };
    const capped = await evaluateLlmGate({ v: 2 }, gateConfig({ maxCallsPerDay: 2 }), state);
    expect(capped.fire).toBe(false);
    expect(capped.error).toMatch(/budget reached/);
    expect(createCompletionMock).not.toHaveBeenCalled();

    // Yesterday's spend does not count today.
    const yesterdayState: PlannedExecutionState = {
      lastHash: hashResult({ v: 1 }),
      llmCallsDay: '2020-01-01',
      llmCallsCount: 999,
    };
    const fresh = await evaluateLlmGate({ v: 2 }, gateConfig({ maxCallsPerDay: 2 }), yesterdayState);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(fresh.newState.llmCallsCount).toBe(1);
  });

  it('reports a missing model as a trigger error without firing', async () => {
    getModelMock.mockResolvedValue(null);
    const state: PlannedExecutionState = { lastHash: hashResult({ v: 1 }) };
    const result = await evaluateLlmGate({ v: 2 }, gateConfig(), state);
    expect(result.fire).toBe(false);
    expect(result.error).toMatch(/no longer exists/);
  });

  it('keeps the change pending (lastHash unmoved) when the completion call throws', async () => {
    createCompletionMock.mockRejectedValue(new Error('provider 500'));
    const oldHash = hashResult({ v: 1 });
    const state: PlannedExecutionState = { lastHash: oldHash };
    const result = await evaluateLlmGate({ v: 2 }, gateConfig(), state);
    expect(result.fire).toBe(false);
    expect(result.error).toMatch(/provider 500/);
    // lastHash not advanced → the same change is re-judged next poll.
    expect(result.newState.lastHash).toBeUndefined();
  });
});
