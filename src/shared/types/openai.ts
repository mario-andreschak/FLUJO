import type OpenAI from 'openai';

/**
 * FLUJO's execution engine supports JSON-schema function tools. OpenAI SDK 7
 * widened the public SDK types to include free-form custom tools, so keep the
 * narrower invariant explicit inside the application.
 */
export type FlujoFunctionTool = OpenAI.ChatCompletionFunctionTool;
export type FlujoFunctionToolCall = OpenAI.ChatCompletionMessageFunctionToolCall;

export class UnsupportedOpenAIToolTypeError extends TypeError {
  readonly code = 'unsupported_tool_type';

  constructor(kind: 'tool' | 'tool call', type: string) {
    super(`Unsupported OpenAI ${kind} type "${type}"; FLUJO supports function tools only.`);
    this.name = 'UnsupportedOpenAIToolTypeError';
  }
}

export function isFunctionTool(
  tool: OpenAI.ChatCompletionTool,
): tool is FlujoFunctionTool {
  return tool.type === 'function';
}

export function isFunctionToolCall(
  call: OpenAI.ChatCompletionMessageToolCall,
): call is FlujoFunctionToolCall {
  return call.type === 'function';
}

/**
 * Narrow SDK tool calls at an external boundary. Silently dropping an unknown
 * call would leave an assistant/tool transcript malformed, so fail with a
 * useful message instead.
 */
export function requireFunctionToolCalls(
  calls: readonly OpenAI.ChatCompletionMessageToolCall[] | null | undefined,
): FlujoFunctionToolCall[] {
  if (!calls) return [];
  const unsupported = calls.find(call => !isFunctionToolCall(call));
  if (unsupported) {
    throw new UnsupportedOpenAIToolTypeError('tool call', unsupported.type);
  }
  return calls as FlujoFunctionToolCall[];
}

export function requireFunctionTools(
  tools: readonly OpenAI.ChatCompletionTool[] | null | undefined,
): FlujoFunctionTool[] {
  if (!tools) return [];
  const unsupported = tools.find(tool => !isFunctionTool(tool));
  if (unsupported) {
    throw new UnsupportedOpenAIToolTypeError('tool', unsupported.type);
  }
  return tools as FlujoFunctionTool[];
}
