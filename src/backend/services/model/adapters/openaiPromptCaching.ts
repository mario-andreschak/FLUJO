import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';

const MAX_EXPLICIT_BREAKPOINTS = 4;

type CacheableContentPart = Record<string, unknown> & {
  type?: string;
  prompt_cache_breakpoint?: { mode: 'explicit' };
};

export interface PreparedOpenAiPromptCacheWire {
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Attach request-level `prompt_cache_options: { mode: "explicit" }`. */
  explicit: boolean;
  breakpointCount: number;
  movedSystemMessages: number;
  lateSystem: boolean;
}

type CacheWireModel = Pick<Model, 'provider' | 'adapter' | 'name' | 'baseUrl'>;

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const GPT_FAMILY = /(?:^|\/)gpt-\d+/i;

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

/**
 * True when requests go to OpenAI's own servers. An empty address uses the
 * OpenAI SDK's default, which is OpenAI unless `OPENAI_BASE_URL` says otherwise.
 * The provider name never decides this: a self-hosted server may be saved as
 * "openai" and still needs its messages in the order they were written.
 */
export function isOfficialOpenAiEndpoint(baseUrl: string | undefined): boolean {
  const host = hostOf(baseUrl?.trim() || process.env.OPENAI_BASE_URL?.trim() || OPENAI_DEFAULT_BASE_URL);
  return host === 'api.openai.com' || Boolean(host?.endsWith('.api.openai.com'));
}

/** Azure OpenAI resources also serve other vendors' models, so they need a GPT name too. */
function isAzureOpenAiEndpoint(baseUrl: string | undefined): boolean {
  const host = baseUrl ? hostOf(baseUrl.trim()) : undefined;
  return Boolean(host && ['.openai.azure.com', '.openai.azure.us'].some(suffix => host.endsWith(suffix)));
}

function isOfficialOpenAiChatCompletion(model: CacheWireModel): boolean {
  const compatible = !model.adapter || model.adapter === 'openai' || model.adapter === 'openai-responses';
  if (!compatible) return false;
  if (isOfficialOpenAiEndpoint(model.baseUrl)) return true;
  // A LiteLLM gateway or an Azure OpenAI resource passes GPT models through to OpenAI's models.
  return (model.provider === 'litellm' || isAzureOpenAiEndpoint(model.baseUrl)) && GPT_FAMILY.test(model.name);
}

/**
 * OpenAI introduced explicit prompt-cache breakpoints in the GPT-5.6 family.
 * Older models reject both the request option and the per-content marker.
 */
export function supportsExplicitOpenAiPromptCaching(model: CacheWireModel): boolean {
  if (!isOfficialOpenAiChatCompletion(model)) return false;
  const match = model.name.toLowerCase().match(/(?:^|\/)gpt-(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

const CACHEABLE_PART_TYPES = new Set(['text', 'image_url', 'input_audio', 'file', 'refusal']);

function markMessageBreakpoint(
  message: OpenAI.ChatCompletionMessageParam,
): OpenAI.ChatCompletionMessageParam | undefined {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    if (content.length === 0) return undefined;
    return {
      ...message,
      content: [{
        type: 'text',
        text: content,
        prompt_cache_breakpoint: { mode: 'explicit' },
      }],
    } as OpenAI.ChatCompletionMessageParam;
  }
  if (!Array.isArray(content)) return undefined;

  let target = -1;
  for (let index = content.length - 1; index >= 0; index--) {
    const part = content[index] as CacheableContentPart | null;
    if (part && CACHEABLE_PART_TYPES.has(String(part.type ?? ''))) {
      target = index;
      break;
    }
  }
  if (target < 0) return undefined;

  const next = content.map((part, index) => index === target
    ? {
        ...(part as Record<string, unknown>),
        prompt_cache_breakpoint: { mode: 'explicit' as const },
      }
    : part);
  return { ...message, content: next } as OpenAI.ChatCompletionMessageParam;
}

/** Remove FLUJO-added markers when an endpoint rejects the new cache controls. */
export function stripOpenAiPromptCacheBreakpoints(
  messages: OpenAI.ChatCompletionMessageParam[],
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const next = content.map((part) => {
      if (!part || typeof part !== 'object' || !('prompt_cache_breakpoint' in part)) return part;
      const { prompt_cache_breakpoint: _removed, ...rest } = part as CacheableContentPart;
      changed = true;
      return rest;
    });
    return changed
      ? { ...message, content: next } as OpenAI.ChatCompletionMessageParam
      : message;
  });
}

/**
 * Official OpenAI Chat Completions wire strategy:
 *
 *  1. Keep the threaded conversation first and move the node's system message
 *     to the tail. Different nodes can therefore share the same large history
 *     prefix while applying different node instructions afterwards.
 *  2. Keep explicit markers on the latest four cacheable history messages.
 *     The prior call's terminal marker normally remains among those four, so a
 *     growing agent loop can read the longest already-written history prefix.
 *  3. Use explicit-only mode so the volatile late instruction is never written
 *     as part of an implicit latest-message breakpoint.
 *
 * GPT-5.6+ additionally receives explicit markers/options. Earlier cacheable
 * OpenAI models still benefit from the history-first ordering through their
 * automatic longest-prefix matching, but receive no unsupported controls.
 * Every other server, including a self-hosted one saved under the provider
 * "openai", keeps the system message first: many chat templates (Qwen on vLLM,
 * for example) refuse a system message anywhere else.
 */
export function prepareOpenAiPromptCacheWire(
  messages: OpenAI.ChatCompletionMessageParam[],
  model: CacheWireModel,
  options: { lateNodeInstruction: boolean },
): PreparedOpenAiPromptCacheWire {
  if (!options.lateNodeInstruction || !isOfficialOpenAiChatCompletion(model)) {
    return {
      messages,
      explicit: false,
      breakpointCount: 0,
      movedSystemMessages: 0,
      lateSystem: false,
    };
  }

  const systems = messages.filter(message => message.role === 'system');
  const history = messages.filter(message => message.role !== 'system');
  if (systems.length === 0 || history.length === 0) {
    return {
      messages,
      explicit: false,
      breakpointCount: 0,
      movedSystemMessages: 0,
      lateSystem: false,
    };
  }

  const explicitSupported = supportsExplicitOpenAiPromptCaching(model);
  if (!explicitSupported) {
    return {
      messages: [...history, ...systems],
      explicit: false,
      breakpointCount: 0,
      movedSystemMessages: systems.length,
      lateSystem: true,
    };
  }

  const candidates: number[] = [];
  for (let index = 0; index < history.length; index++) {
    if (markMessageBreakpoint(history[index])) candidates.push(index);
  }
  const marked = new Set(candidates.slice(-MAX_EXPLICIT_BREAKPOINTS));
  let breakpointCount = 0;
  const markedHistory = history.map((message, index) => {
    if (!marked.has(index)) return message;
    const next = markMessageBreakpoint(message);
    if (!next) return message;
    breakpointCount++;
    return next;
  });

  if (breakpointCount === 0) {
    return {
      messages: [...history, ...systems],
      explicit: false,
      breakpointCount: 0,
      movedSystemMessages: systems.length,
      lateSystem: true,
    };
  }

  return {
    messages: [...markedHistory, ...systems],
    explicit: true,
    breakpointCount,
    movedSystemMessages: systems.length,
    lateSystem: true,
  };
}
