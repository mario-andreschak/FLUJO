import { GoogleGenAI, Content, Part, FunctionDeclaration, GenerateContentResponse } from '@google/genai';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { CompletionAdapter, CompletionInput, CompletionResult, observeSdkRequest } from './types';
import { extractText, extractMediaParts, parseToolArgs } from './messageUtils';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { mediaTypeFromMime } from '@/shared/types/model/media';

const log = createLogger('backend/services/model/adapters/geminiAdapter');

// --- Remote image fetch-and-inline guards ---------------------------------
// Gemini's `inlineData` needs raw bytes and `fileData.fileUri` only accepts
// GCS/Files-API URIs, so — unlike Anthropic/Claude-subscription, which pass a
// URL straight through to their SDKs — the Gemini adapter must fetch a remote
// http(s) image server-side and inline it. URLs are user-supplied, so the fetch
// is bounded by a short timeout, a byte cap, an `image/*` content-type check,
// and a conservative SSRF guard that blocks obvious private/loopback hosts
// (literal addresses only — no DNS resolution).
const FETCH_IMAGE_TIMEOUT_MS = 30_000; // 30s — deliberately short vs the LLM ceiling
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB pre-base64
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const GEMINI_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Normalize a response Content-Type to a Gemini-accepted image MIME, or null. */
function normalizeGeminiImageMime(contentType: string): string | null {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  return GEMINI_IMAGE_MIME.has(mime) ? mime : null;
}


/**
 * Conservative SSRF guard: block requests to obvious private / loopback /
 * link-local hosts. This inspects only the literal hostname (no DNS lookup), so
 * it stops the common accidental/abusive cases without pretending to be a full
 * SSRF firewall.
 */
function isBlockedImageHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

/**
 * Fetch a remote http(s) image and return it as `{ mimeType, data }` ready for a
 * Gemini `inlineData` part. Throws (with a short, secret-free reason) on any
 * failure — the caller logs a warning and drops just the image, never the text.
 * Honors the request `AbortSignal` (Stop button) in addition to its own timeout.
 */
async function fetchRemoteImageAsInline(
  url: string,
  signal?: AbortSignal
): Promise<{ mimeType: string; data: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol "${parsed.protocol}"`);
  }
  if (isBlockedImageHost(parsed.hostname)) {
    throw new Error('blocked host (private/loopback)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_IMAGE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const rawType = response.headers.get('content-type') || '';
    const mimeType = normalizeGeminiImageMime(rawType);
    if (!mimeType) throw new Error(`non-image content-type "${rawType}"`);

    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > MAX_IMAGE_BYTES) {
      throw new Error(`image too large (${declared} bytes > ${MAX_IMAGE_BYTES})`);
    }

    // Read the body and re-check the size — a missing or lying Content-Length
    // must not bypass the cap.
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(`image too large (${buf.length} bytes > ${MAX_IMAGE_BYTES})`);
    }
    return { mimeType, data: buf.toString('base64') };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

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
export async function toGeminiContents(
  messages: OpenAI.ChatCompletionMessageParam[],
  signal?: AbortSignal
): Promise<{
  systemInstruction?: string;
  contents: Content[];
}> {
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
      // Inline base64 image parts (e.g. pasted screenshots) directly. Remote
      // http(s) image URLs are fetched server-side and inlined, since Gemini's
      // inlineData wants bytes and fileData/fileUri requires a Files-API upload
      // we don't perform. A fetch that fails (network error, non-image, too
      // large, blocked host) drops just that image with a warning — the turn's
      // text still goes through.
      for (const media of extractMediaParts(msg.content)) {
        if (media.data && media.mimeType) {
          parts.push({ inlineData: { mimeType: media.mimeType, data: media.data } });
        } else if (media.url) {
          try {
            const inline = media.type === 'image'
              ? await fetchRemoteImageAsInline(media.url, signal)
              : await fetchRemoteMediaAsInline(media.url, signal);
            parts.push({ inlineData: inline });
          } catch (err) {
            log.warn(
              'Skipping remote media for Gemini (fetch failed / unsupported / too large)',
              { url: media.url, reason: err instanceof Error ? err.message : String(err) }
            );
          }
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

export function toGeminiTools(tools?: OpenAI.ChatCompletionFunctionTool[]): FunctionDeclaration[] | undefined {
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

function requestedGeminiModalities(outputModalities?: string[]): import('@google/genai').Modality[] | undefined {
  const modalities = (outputModalities ?? [])
    .map(value => value.toUpperCase())
    .filter(value => value === 'TEXT' || value === 'IMAGE' || value === 'AUDIO');
  return modalities.some(value => value !== 'TEXT')
    ? Array.from(new Set(modalities)) as import('@google/genai').Modality[]
    : undefined;
}

/** Map a Gemini response back into an OpenAI-shaped ChatCompletion. */
function toChatCompletion(
  modelName: string,
  resp: GenerateContentResponse
): { completion: OpenAI.Chat.Completions.ChatCompletion; media: ModelMediaPart[] } {
  const candidate = resp.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  let text = '';
  const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
  const media: ModelMediaPart[] = [];
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
    } else if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType ?? 'application/octet-stream';
      media.push({
        type: mediaTypeFromMime(mimeType),
        data: part.inlineData.data,
        mimeType,
      });
    } else if (part.fileData?.fileUri) {
      const mimeType = part.fileData.mimeType ?? 'application/octet-stream';
      media.push({
        type: mediaTypeFromMime(mimeType),
        url: part.fileData.fileUri,
        mimeType,
      });
    }
  }

  const finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] =
    toolCalls.length > 0 ? 'tool_calls' : 'stop';

  const usage = resp.usageMetadata;

  const completion: OpenAI.Chat.Completions.ChatCompletion = {
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
  return { completion, media };
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
    maxTokens,
    signal,
    onSdkRequest,
    onSdkRequestResult,
  }: CompletionInput): Promise<CompletionResult> {
    // Raise the per-request timeout (SDK default is short relative to a long
    // agentic turn) via httpOptions; see shared timeouts config.
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: LLM_REQUEST_TIMEOUT_MS } });

    const { systemInstruction, contents } = await toGeminiContents(messages, signal);
    const functionDeclarations = toGeminiTools(tools);
    const responseModalities = requestedGeminiModalities(model.outputModalities);
    const thinkingConfig =
      typeof model.thinkingBudget === 'number'
        ? { thinkingBudget: model.thinkingBudget }
        : model.thinkingLevel
          ? {
              thinkingLevel: model.thinkingLevel.toUpperCase() as unknown as
                import('@google/genai').ThinkingLevel,
            }
          : undefined;

    log.debug('createCompletion via Gemini GenAI SDK', {
      model: model.name,
      toolCount: functionDeclarations?.length || 0,
      hasSystem: Boolean(systemInstruction),
    });

    const request = {
      model: model.name,
      contents,
      config: {
        temperature,
        // Only set an output cap when one was resolved; omitting it preserves
        // the previous default behavior.
        ...(typeof maxTokens === 'number' ? { maxOutputTokens: maxTokens } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
        ...(responseModalities ? { responseModalities } : {}),
        // The abort signal (Stop button) cancels the in-flight HTTP request.
        ...(signal ? { abortSignal: signal } : {}),
      },
    };
    const resp = await observeSdkRequest(
      { onSdkRequest, onSdkRequestResult, signal },
      { adapter: 'gemini', operation: 'models.generateContent', request },
      () => ai.models.generateContent(request),
    );

    return toChatCompletion(model.name, resp);
  }

  async createStreamCompletion({
    model,
    apiKey,
    messages,
    tools,
    temperature,
    maxTokens,
    signal,
    onModelDelta,
    onSdkRequest,
    onSdkRequestResult,
  }: CompletionInput): Promise<CompletionResult> {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: LLM_REQUEST_TIMEOUT_MS } });
    const { systemInstruction, contents } = await toGeminiContents(messages, signal);
    const functionDeclarations = toGeminiTools(tools);
    const responseModalities = requestedGeminiModalities(model.outputModalities);
    const thinkingConfig =
      typeof model.thinkingBudget === 'number'
        ? { thinkingBudget: model.thinkingBudget }
        : model.thinkingLevel
          ? {
              thinkingLevel: model.thinkingLevel.toUpperCase() as unknown as
                import('@google/genai').ThinkingLevel,
            }
          : undefined;
    const liveMessageId = `stream_${uuidv4()}`;
    const request = {
      model: model.name,
      contents,
      config: {
        temperature,
        ...(typeof maxTokens === 'number' ? { maxOutputTokens: maxTokens } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
        ...(responseModalities ? { responseModalities } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      },
    };
    const stream = await observeSdkRequest(
      { onSdkRequest, onSdkRequestResult, signal },
      { adapter: 'gemini', operation: 'models.generateContentStream', request },
      () => ai.models.generateContentStream(request),
    );

    let responseId = `gemini_${uuidv4()}`;
    let text = '';
    let usage: GenerateContentResponse['usageMetadata'];
    const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
    const media: ModelMediaPart[] = [];
    const seenMedia = new Set<string>();
    const toolIndexById = new Map<string, number>();
    let activePartialToolIndex: number | undefined;

    for await (const chunk of stream) {
      responseId = chunk.responseId || responseId;
      usage = chunk.usageMetadata ?? usage;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          text += part.text;
          onModelDelta?.({ messageId: liveMessageId, contentDelta: part.text });
        } else if (part.functionCall) {
          const providerId = part.functionCall.id;
          const knownIndex = providerId ? toolIndexById.get(providerId) : undefined;
          const index = knownIndex ?? activePartialToolIndex ?? toolCalls.length;
          const prior = toolCalls[index];
          const id = providerId || prior?.id || `call_${uuidv4()}`;
          const name = part.functionCall.name ?? '';
          const argsObject = part.functionCall.args ?? {};
          const args =
            part.functionCall.willContinue && Object.keys(argsObject).length === 0
              ? ''
              : JSON.stringify(argsObject);
          toolCalls[index] = {
            id,
            type: 'function',
            function: { name, arguments: args },
          };
          if (providerId) toolIndexById.set(providerId, index);
          activePartialToolIndex = part.functionCall.willContinue ? index : undefined;
          const nameDelta = name.startsWith(prior?.function.name ?? '')
            ? name.slice(prior?.function.name.length ?? 0)
            : (prior ? '' : name);
          const argumentsDelta = args.startsWith(prior?.function.arguments ?? '')
            ? args.slice(prior?.function.arguments.length ?? 0)
            : (prior ? '' : args);
          onModelDelta?.({
            messageId: liveMessageId,
            toolCallDelta: {
              index,
              ...(prior ? {} : { id }),
              ...(nameDelta ? { nameDelta } : {}),
              ...(argumentsDelta ? { argumentsDelta } : {}),
            },
          });
        } else if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType ?? 'application/octet-stream';
          const item: ModelMediaPart = {
            type: mediaTypeFromMime(mimeType),
            data: part.inlineData.data,
            mimeType,
          };
          const key = `${item.type}|${item.mimeType}|${item.data}`;
          if (!seenMedia.has(key)) {
            seenMedia.add(key);
            media.push(item);
            onModelDelta?.({ messageId: liveMessageId, mediaPart: item });
          }
        } else if (part.fileData?.fileUri) {
          const mimeType = part.fileData.mimeType ?? 'application/octet-stream';
          const item: ModelMediaPart = {
            type: mediaTypeFromMime(mimeType),
            url: part.fileData.fileUri,
            mimeType,
          };
          const key = `${item.type}|${item.mimeType}|${item.url}`;
          if (!seenMedia.has(key)) {
            seenMedia.add(key);
            media.push(item);
            onModelDelta?.({ messageId: liveMessageId, mediaPart: item });
          }
        }
      }
    }

    return {
      liveMessageId,
      media,
      completion: {
        id: responseId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.name,
        choices: [{
          index: 0,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: text || null,
            refusal: null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        }],
        ...(usage
          ? {
              usage: {
                prompt_tokens: usage.promptTokenCount ?? 0,
                completion_tokens: usage.candidatesTokenCount ?? 0,
                total_tokens: usage.totalTokenCount ?? 0,
              },
            }
          : {}),
      },
    };
  }
}

async function fetchRemoteMediaAsInline(
  url: string,
  signal?: AbortSignal
): Promise<{ mimeType: string; data: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol "${parsed.protocol}"`);
  }
  if (isBlockedImageHost(parsed.hostname)) {
    throw new Error('blocked host (private/loopback)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_IMAGE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rawType = response.headers.get('content-type') || '';
    const mimeType = normalizeGeminiMediaMime(rawType);
    if (!mimeType) throw new Error(`unsupported content-type "${rawType}"`);
    const cap = mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES;
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > cap) {
      throw new Error(`media too large (${declared} bytes > ${cap})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > cap) {
      throw new Error(`media too large (${buffer.length} bytes > ${cap})`);
    }
    return { mimeType, data: buffer.toString('base64') };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function normalizeGeminiMediaMime(contentType: string): string | null {
  const image = normalizeGeminiImageMime(contentType);
  if (image) return image;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'application/pdf' ||
    mime === 'text/plain'
  ) {
    return mime;
  }
  return null;
}
