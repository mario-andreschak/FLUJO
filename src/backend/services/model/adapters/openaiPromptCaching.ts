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

function isOfficialOpenAiChatCompletion(
  model: Pick<Model, 'provider' | 'adapter'>,
): boolean {
  return model.provider === 'openai' && (!model.adapter || model.adapter === 'openai');
}

/**
 * OpenAI introduced explicit prompt-cache breakpoints in the GPT-5.6 family.
 * Older models reject both the request option and the per-content marker.
 */
export function supportsExplicitOpenAiPromptCaching(
  model: Pick<Model, 'provider' | 'name' | 'adapter'>,
): boolean {
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
 * OpenAI-compatible gateways retain conventional system-first ordering because
 * they may impose stricter role-order rules.
 */
export function prepareOpenAiPromptCacheWire(
  messages: OpenAI.ChatCompletionMessageParam[],
  model: Pick<Model, 'provider' | 'name' | 'adapter'>,
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
