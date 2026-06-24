import { GoogleGenAI, Content, Part, FunctionDeclaration, GenerateContentResponse } from '@google/genai';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { extractText, extractImageParts, parseToolArgs } from './messageUtils';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';

const log = createLogger('backend/services/model/adapters/geminiAdapter');

/**
 * Convert OpenAI-format messages into Gemini's `contents` shape:
 *   - system messages are hoisted into `systemInstruction`
 *   - assistant role -> 'model'; tool_calls become `functionCall` parts
 *   - tool results become `functionResponse` parts in a user message.
 *
 * Gemini keys function responses by the function NAME, not by an opaque call id
 * (which OpenAI tool messages carry). We therefore track id -> name from the
 * preceding assistant tool_calls and look it up when converting tool results.
 */
export function toGeminiContents(messages: OpenAI.ChatCompletionMessageParam[]): {
  systemInstruction?: string;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const contents: Content[] = [];
  const idToName = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === 'user') {
      const text = extractText(msg.content);
      const parts: Part[] = [];
      if (text) parts.push({ text });
      // Inline base64 image parts (e.g. pasted screenshots). Remote image URLs
      // are skipped here — Gemini's inlineData wants bytes, and fileData/fileUri
      // requires a Files-API upload we don't perform.
      for (const img of extractImageParts(msg.content)) {
        if (img.base64 && img.mimeType) {
          parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
        }
      }
      // Gemini rejects an empty parts array; keep a (possibly empty) text part.
      contents.push({ role: 'user', parts: parts.length > 0 ? parts : [{ text: '' }] });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: Part[] = [];
      const text = extractText(msg.content ?? '');
      if (text) parts.push({ text });

      for (const tc of msg.tool_calls ?? []) {
        if (tc.type !== 'function') continue;
        idToName.set(tc.id, tc.function.name);
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: parseToolArgs(tc.function.arguments),
          },
        });
      }

      contents.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
      continue;
    }

    if (msg.role === 'tool') {
      const name = idToName.get(msg.tool_call_id) || msg.tool_call_id;
      const raw = extractText(msg.content);
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw);
        response =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : { result: parsed };
      } catch {
        response = { result: raw };
      }

      const part: Part = { functionResponse: { name, response } };
      const last = contents[contents.length - 1];
      if (
        last &&
        last.role === 'user' &&
        Array.isArray(last.parts) &&
        last.parts.every(p => 'functionResponse' in p)
      ) {
        last.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }
  }

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    contents,
  };
}

export function toGeminiTools(tools?: OpenAI.ChatCompletionTool[]): FunctionDeclaration[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter(t => t.type === 'function')
    .map(t => ({
      name: t.function.name,
      description: t.function.description,
      // Pass the OpenAI JSON Schema through verbatim; the GenAI SDK accepts a
      // raw JSON schema here (sidestepping its stricter `Schema` type).
      parametersJsonSchema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
}

/** Map a Gemini response back into an OpenAI-shaped ChatCompletion. */
function toChatCompletion(
  modelName: string,
  resp: GenerateContentResponse
): OpenAI.Chat.Completions.ChatCompletion {
  const candidate = resp.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  let text = '';
  const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string') {
      text += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        // Gemini does not return tool-call ids; synthesize a stable one so the
        // downstream tool-result correlation has something to key on.
        id: `call_${uuidv4()}`,
        type: 'function',
        function: {
          name: part.functionCall.name ?? '',
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  const finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] =
    toolCalls.length > 0 ? 'tool_calls' : 'stop';

  const usage = resp.usageMetadata;

  return {
    id: `gemini_${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
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
    usage: usage
      ? {
          prompt_tokens: usage.promptTokenCount ?? 0,
          completion_tokens: usage.candidatesTokenCount ?? 0,
          total_tokens: usage.totalTokenCount ?? 0,
        }
      : undefined,
  };
}

/**
 * Native Gemini adapter (using @google/genai). Used by the "Gemini (Native)"
 * provider profile. Supports tool calling: tools are translated to Gemini
 * function declarations and `functionCall` responses are mapped back to OpenAI
 * `tool_calls` so FLUJO's tool-execution loop drives them.
 */
export class GeminiAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
  }: CompletionInput): Promise<CompletionResult> {
    // Raise the per-request timeout (SDK default is short relative to a long
    // agentic turn) via httpOptions; see shared timeouts config.
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: LLM_REQUEST_TIMEOUT_MS } });

    const { systemInstruction, contents } = toGeminiContents(messages);
    const functionDeclarations = toGeminiTools(tools);

    log.debug('createCompletion via Gemini GenAI SDK', {
      model: model.name,
      toolCount: functionDeclarations?.length || 0,
      hasSystem: Boolean(systemInstruction),
    });

    const resp = await ai.models.generateContent({
      model: model.name,
      contents,
      config: {
        temperature,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
      },
    });

    return { completion: toChatCompletion(model.name, resp) };
  }
}
