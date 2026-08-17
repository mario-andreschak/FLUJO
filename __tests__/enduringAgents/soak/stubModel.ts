import type {
  CompletionAdapter,
  CompletionResult,
} from '@/backend/services/model/adapters/types';

export interface StubFact { id: string; subject: string; value: string; }

export function createSeededStubModel(seed: number, facts: StubFact[]): CompletionAdapter {
  let call = 0;
  const complete = async (): Promise<CompletionResult> => {
    const fact = facts[(seed + call++) % facts.length];
    const content = `<persona_activity_outcome>{"resolution":"completed","summary":"${fact.subject}: ${fact.value}"}</persona_activity_outcome>`;
    return {
      completion: {
        id: `soak-completion-${call}`,
        object: 'chat.completion',
        created: 0,
        model: 'persona-soak-stub',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: { role: 'assistant', content, refusal: null, annotations: [] },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
  };
  return { createCompletion: complete, createStreamCompletion: complete };
}
