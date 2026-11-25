import type { CompletionAdapter, CompletionResult } from './types';

/**
 * A reply that reached the output length limit (`finish_reason: 'length'`) can
 * end in the middle of a tool call, so its arguments may be empty or half
 * written. Such a call never runs and is never sent back to a model. The text
 * written so far stays, and the chat shows the reply as cut off (issue #1227).
 */
export function withoutCutOffToolCalls(result: CompletionResult): CompletionResult {
  const choices = result.completion?.choices;
  const cutOffCall = (choice: (typeof choices)[number]) =>
    choice.finish_reason === 'length' && Boolean(choice.message?.tool_calls?.length);
  if (!choices?.some(cutOffCall)) return result;
  return {
    ...result,
    completion: {
      ...result.completion,
      choices: choices.map(choice => {
        if (!cutOffCall(choice)) return choice;
        const { tool_calls: _cutOff, ...message } = choice.message;
        return { ...choice, message };
      }),
    },
  };
}

/** Every adapter FLUJO creates returns its replies through this rule. */
export function guardCutOffToolCalls(adapter: CompletionAdapter): CompletionAdapter {
  const createCompletion = adapter.createCompletion.bind(adapter);
  adapter.createCompletion = async input => withoutCutOffToolCalls(await createCompletion(input));
  if (adapter.createStreamCompletion) {
    const createStreamCompletion = adapter.createStreamCompletion.bind(adapter);
    adapter.createStreamCompletion = async input => withoutCutOffToolCalls(await createStreamCompletion(input));
  }
  return adapter;
}
