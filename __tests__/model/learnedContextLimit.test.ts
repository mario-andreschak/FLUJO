/**
 * #1327 / #1091: a size a provider refused becomes that model's input budget
 * for an hour, so later turns are shortened before they are sent instead of
 * being refused again. Replaces the fixed 96,000-token guess PR #1327 used for
 * models without catalogue metadata: the number comes from the provider, can
 * only go down while it lasts, and is forgotten without a restart.
 */
import {
  LEARNED_CONTEXT_LIMIT_MS,
  __resetLearnedContextLimits,
  effectiveInputBudget,
  learnedInputBudget,
  rememberContextRejection,
  resolveOutgoingInputBudget,
} from '@/backend/execution/flow/handlers/contextWindowFit';
import { createModelError } from '@/backend/execution/flow/errorFactory';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const refusal = (message: string, providerError?: unknown) =>
  createModelError('provider_error', message, 'model-1', undefined, providerError ? { providerError } : undefined);

beforeEach(() => __resetLearnedContextLimits());

describe('learned context limits', () => {
  it.each([
    ['OpenAI and OpenRouter', "This endpoint's maximum context length is 262144 tokens. However, you requested about 351213 tokens.", 262_144],
    ['Anthropic', 'prompt is too long: 215000 tokens > 200000 maximum', 200_000],
    ['Anthropic with max_tokens', 'input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000', 200_000],
  ])('takes the window the %s refusal states', (_source, message, window) => {
    rememberContextRejection('model-1', 999_999, refusal(message), 4_096);
    expect(learnedInputBudget('model-1')).toBe(resolveOutgoingInputBudget(window, 4_096));
  });

  it('reads the number from the raw provider body as well', () => {
    rememberContextRejection('model-1', 999_999, refusal('Bad request', { error: { message: 'prompt is too long: 9 tokens > 120,000 maximum' } }));
    expect(learnedInputBudget('model-1')).toBe(resolveOutgoingInputBudget(120_000, undefined));
  });

  it('uses 70% of the refused request when the refusal names no number (Claude Code: "Prompt is too long")', () => {
    rememberContextRejection('model-1', 100_000, refusal('Prompt is too long'));
    expect(learnedInputBudget('model-1')).toBe(70_000);
  });

  it('only lowers the budget while it lasts, and keeps models apart', () => {
    rememberContextRejection('model-1', 100_000, refusal('Prompt is too long'));
    rememberContextRejection('model-1', 400_000, refusal('Prompt is too long'));
    expect(learnedInputBudget('model-1')).toBe(70_000);
    expect(learnedInputBudget('model-2')).toBeUndefined();
  });

  it('is forgotten after an hour, with no restart and no setting', () => {
    const now = 1_000_000;
    rememberContextRejection('model-1', 100_000, refusal('Prompt is too long'), undefined, now);
    expect(learnedInputBudget('model-1', now + LEARNED_CONTEXT_LIMIT_MS - 1)).toBe(70_000);
    expect(learnedInputBudget('model-1', now + LEARNED_CONTEXT_LIMIT_MS)).toBeUndefined();
  });

  it('takes the smaller of the catalogue budget and the learned one', () => {
    expect(effectiveInputBudget('model-1', 200_000, 8_000)).toBe(resolveOutgoingInputBudget(200_000, 8_000));
    expect(effectiveInputBudget('model-1', undefined, 8_000)).toBeUndefined();
    rememberContextRejection('model-1', 100_000, refusal('Prompt is too long'));
    expect(effectiveInputBudget('model-1', 200_000, 8_000)).toBe(70_000);
    expect(effectiveInputBudget('model-1', undefined, 8_000)).toBe(70_000);
    expect(effectiveInputBudget('model-1', 50_000, 8_000)).toBe(resolveOutgoingInputBudget(50_000, 8_000));
  });
});
