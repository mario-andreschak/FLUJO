import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { createOpenAIClient } from '../openaiClient';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';

const log = createLogger('backend/services/model/adapters/openaiAdapter');

/**
 * The OpenAI-compatible adapter — FLUJO's original completion path. Used by
 * OpenAI, OpenRouter, X.ai, Ollama, and the "OpenAI Format" variants of Gemini
 * and Anthropic. Uses the shared hardened client (keep-alive disabled) to avoid
 * the intermittent "Premature close" transport bug.
 */
export class OpenAiAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
  }: CompletionInput): Promise<CompletionResult> {
    const openai = createOpenAIClient({ apiKey, baseURL: model.baseUrl });

    const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model: model.name,
      messages,
      temperature,
    };
    if (tools && tools.length > 0) {
      requestParams.tools = tools;
    }

    log.debug('createCompletion via OpenAI-compatible API', {
      model: model.name,
      baseUrl: model.baseUrl,
      toolCount: tools?.length || 0,
    });

    // No `stream: true`, so the SDK resolves to a ChatCompletion.
    const completion = (await openai.chat.completions.create(
      requestParams
    )) as OpenAI.Chat.Completions.ChatCompletion;
    return { completion };
  }
}
