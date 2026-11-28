import type OpenAI from 'openai';
import type { CompletionAdapter, CompletionResult } from './types';

/**
 * A reply whose token count reached its limit was cut off, whatever finish
 * reason the server reported. vLLM before September 2026 (PRs #46303 and
 * #59324) reported `tool_calls` for a call the output limit cut off in the
 * middle of its arguments, after closing the cut JSON itself, so the call
 * looked finished. The limit is reached when the reply used every output
 * token `max_tokens` allowed or, with no cap sent, when prompt and reply
 * fill the context window exactly: such servers stop there on their own.
 */
export function withLengthFromUsage(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  limits: { maxTokens?: number; contextWindow?: number },
): OpenAI.Chat.Completions.ChatCompletion {
  const usage = completion.usage;
  if (!usage || !completion.choices?.some(choice => choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls')) {
    return completion;
  }
  const reachedCap = typeof limits.maxTokens === 'number' && limits.maxTokens > 0 && usage.completion_tokens >= limits.maxTokens;
  const filledContext = typeof limits.maxTokens !== 'number' && typeof limits.contextWindow === 'number'
    && limits.contextWindow > 0 && usage.prompt_tokens + usage.completion_tokens === limits.contextWindow;
  if (!reachedCap && !filledContext) return completion;
  return {
    ...completion,
    choices: completion.choices.map(choice => choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls'
      ? { ...choice, finish_reason: 'length' as const }
      : choice),
  };
}

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

/**
 * Every adapter FLUJO creates returns its replies through this rule. A
 * request the adapter refuses before sending still throws at once, as it
 * would without this rule.
 */
export function guardCutOffToolCalls(adapter: CompletionAdapter): CompletionAdapter {
  const createCompletion = adapter.createCompletion.bind(adapter);
  adapter.createCompletion = input => createCompletion(input).then(withoutCutOffToolCalls);
  if (adapter.createStreamCompletion) {
    const createStreamCompletion = adapter.createStreamCompletion.bind(adapter);
    adapter.createStreamCompletion = input => createStreamCompletion(input).then(withoutCutOffToolCalls);
  }
  return adapter;
}
