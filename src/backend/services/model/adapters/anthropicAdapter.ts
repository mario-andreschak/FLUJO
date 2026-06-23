import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { extractText, parseToolArgs } from './messageUtils';

const log = createLogger('backend/services/model/adapters/anthropicAdapter');

// The Anthropic Messages API requires max_tokens. Modern Claude models support
// at least this many output tokens; it bounds a single completion, not a flow.
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Convert OpenAI-format messages into Anthropic's shape:
 *   - system messages are hoisted into the top-level `system` string
 *   - assistant tool_calls become `tool_use` content blocks
 *   - tool results become `tool_result` blocks inside a user message
 *     (consecutive tool results are merged into one user message, as the API
 *     requires)
 */
export function toAnthropicMessages(messages: OpenAI.ChatCompletionMessageParam[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  const pushToolResult = (toolUseId: string, content: string) => {
    const block: Anthropic.ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
    };
    const last = out[out.length - 1];
    if (
      last &&
      last.role === 'user' &&
      Array.isArray(last.content) &&
      last.content.every(b => (b as { type?: string }).type === 'tool_result')
    ) {
      (last.content as Anthropic.ContentBlockParam[]).push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === 'tool') {
      pushToolResult(msg.tool_call_id, extractText(msg.content));
      continue;
    }

    if (msg.role === 'user') {
      out.push({ role: 'user', content: extractText(msg.content) });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      const text = extractText(msg.content ?? '');
      if (text) blocks.push({ type: 'text', text });

      for (const tc of msg.tool_calls ?? []) {
        if (tc.type !== 'function') continue;
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parseToolArgs(tc.function.arguments),
        });
      }

      // Anthropic rejects an empty content array; fall back to a (possibly
      // empty) text string when there is nothing to send.
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : text });
      continue;
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

export function toAnthropicTools(
  tools?: OpenAI.ChatCompletionTool[]
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter(t => t.type === 'function')
    .map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters as Anthropic.Tool.InputSchema) ?? {
        type: 'object',
        properties: {},
      },
    }));
}

/** Map an Anthropic response back into an OpenAI-shaped ChatCompletion. */
function toChatCompletion(
  fallbackModel: string,
  resp: Anthropic.Message
): OpenAI.Chat.Completions.ChatCompletion {
  let text = '';
  const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

  for (const block of resp.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] =
    resp.stop_reason === 'tool_use'
      ? 'tool_calls'
      : resp.stop_reason === 'max_tokens'
        ? 'length'
        : 'stop';

  return {
    id: resp.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model || fallbackModel,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: {
          role: 'assistant',
          content: text || null,
          refusal: null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
    },
  };
}

/**
 * Native Anthropic adapter (using @anthropic-ai/sdk). Used by the
 * "Anthropic (Native)" provider profile. Supports tool calling: tools are
 * translated to Anthropic's tool schema and `tool_use` responses are mapped
 * back to OpenAI `tool_calls` so FLUJO's tool-execution loop drives them.
 */
export class AnthropicAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
  }: CompletionInput): Promise<CompletionResult> {
    const client = new Anthropic({
      apiKey,
      // Honour a custom base URL if one was configured; otherwise the SDK
      // default (api.anthropic.com) is used.
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
    });

    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(tools);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: model.name,
      max_tokens: DEFAULT_MAX_TOKENS,
      temperature,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools ? { tools: anthropicTools } : {}),
    };

    log.debug('createCompletion via Anthropic SDK', {
      model: model.name,
      toolCount: anthropicTools?.length || 0,
      hasSystem: Boolean(system),
    });

    const resp = await client.messages.create(params);
    return { completion: toChatCompletion(model.name, resp) };
  }
}
