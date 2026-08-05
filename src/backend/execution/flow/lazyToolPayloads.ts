import type { FlujoChatMessage, LazyToolPayloadRef } from '@/shared/types/chat';
import type { RunResourceEntry } from '@/shared/types/runResources';
import type { FlujoFunctionToolCall } from '@/shared/types/openai';
import {
  getRunResourceSettings,
  listRunResources,
  readRunResource,
} from '@/backend/services/runResources';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';

const INLINE_PREVIEW_CHARS = 1200;

function previewPayload(value: string, label: string, fullSize: number): string {
  if (value.length <= INLINE_PREVIEW_CHARS) return value;
  return `${value.slice(0, INLINE_PREVIEW_CHARS)}\n\n[${label} preview — expand to load the full ${fullSize.toLocaleString('en-US')}-byte payload]`;
}

function payloadHref(entry: RunResourceEntry): string {
  return `/v1/chat/conversations/${encodeURIComponent(entry.conversationId)}`
    + `/resources/${encodeURIComponent(entry.id)}/content`;
}

function payloadRef(entry: RunResourceEntry): LazyToolPayloadRef {
  return {
    uri: entry.uri,
    href: payloadHref(entry),
    size: entry.size,
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
  };
}

function newestPayloads(entries: RunResourceEntry[]): {
  argumentsByCallId: Map<string, RunResourceEntry>;
  resultByCallId: Map<string, RunResourceEntry>;
} {
  const argumentsByCallId = new Map<string, RunResourceEntry>();
  const resultByCallId = new Map<string, RunResourceEntry>();
  for (const entry of [...entries].sort((left, right) => right.createdAt - left.createdAt)) {
    const callId = entry.producedBy.toolCallId;
    if (!callId || entry.kind !== 'text' || entry.encoding !== 'utf8') continue;
    if (entry.producedBy.source === 'tool-args' && !argumentsByCallId.has(callId)) {
      argumentsByCallId.set(callId, entry);
    }
    if (
      entry.producedBy.source === 'tool-result'
      && entry.producedBy.payloadRole === 'tool-message'
      && !resultByCallId.has(callId)
    ) {
      resultByCallId.set(callId, entry);
    }
  }
  return { argumentsByCallId, resultByCallId };
}

/**
 * Replace large tool arguments/results with bounded previews in a response DTO.
 * Canonical SharedState and the append-only conversation log stay untouched.
 */
export async function projectLazyToolPayloads(
  messages: FlujoChatMessage[],
  conversationId: string,
): Promise<FlujoChatMessage[]> {
  const resources = await listRunResources(conversationId);
  if (resources.length === 0) return messages;
  const { argumentsByCallId, resultByCallId } = newestPayloads(resources);
  if (argumentsByCallId.size === 0 && resultByCallId.size === 0) return messages;

  // MCP Apps consume their call arguments/result as soon as the View mounts.
  // Keep those few payloads inline until the app host itself supports lazy data.
  const appCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.ui && typeof message.tool_call_id === 'string') {
      appCallIds.add(message.tool_call_id);
    }
  }

  return messages.map((message) => {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      let changed = false;
      const toolPayloads = { ...(message.toolPayloads ?? {}) };
      const toolCalls = (message.tool_calls as FlujoFunctionToolCall[]).map((call) => {
        const resource = appCallIds.has(call.id) ? undefined : argumentsByCallId.get(call.id);
        const args = call.function.arguments;
        if (!resource || typeof args !== 'string') return call;
        changed = true;
        toolPayloads[call.id] = {
          ...toolPayloads[call.id],
          arguments: payloadRef(resource),
        };
        return {
          ...call,
          function: {
            ...call.function,
            arguments: previewPayload(args, 'tool parameters', resource.size),
          },
        };
      });
      return changed ? ({ ...message, tool_calls: toolCalls, toolPayloads } as FlujoChatMessage) : message;
    }

    if (
      message.role === 'tool'
      && typeof message.tool_call_id === 'string'
      && !appCallIds.has(message.tool_call_id)
      && typeof message.content === 'string'
    ) {
      const resource = resultByCallId.get(message.tool_call_id);
      if (!resource) return message;
      return {
        ...message,
        content: previewPayload(message.content, 'tool result', resource.size),
        toolPayloads: {
          ...(message.toolPayloads ?? {}),
          [message.tool_call_id]: {
            ...message.toolPayloads?.[message.tool_call_id],
            result: payloadRef(resource),
          },
        },
      };
    }
    return message;
  });
}

async function readExactPayload(
  ref: LazyToolPayloadRef,
  toolCallId: string,
  kind: 'arguments' | 'result',
): Promise<{ text: string; entry: RunResourceEntry }> {
  const read = await readRunResource(ref.uri);
  const expectedSource = kind === 'arguments' ? 'tool-args' : 'tool-result';
  if (
    !read
    || read.entry.producedBy.source !== expectedSource
    || read.entry.producedBy.toolCallId !== toolCallId
    || (kind === 'result' && read.entry.producedBy.payloadRole !== 'tool-message')
  ) {
    throw new Error(`Could not hydrate lazy tool ${kind} for ${toolCallId}`);
  }
  const content = read.contents.contents[0];
  if (!content || !('text' in content) || typeof content.text !== 'string') {
    throw new Error(`Lazy tool ${kind} for ${toolCallId} is not textual`);
  }
  return { text: content.text, entry: read.entry };
}

/**
 * Restore response-only lazy previews before an incoming transcript replaces
 * canonical state. Existing conversations use their authoritative state first;
 * splits/edits can safely fall back to the validated run-resource reference.
 */
export async function hydrateLazyToolPayloads(
  messages: unknown[],
  canonicalMessages: FlujoChatMessage[],
  targetConversationId: string,
): Promise<unknown[]> {
  const canonicalById = new Map(canonicalMessages.map((message) => [message.id, message]));

  return Promise.all(messages.map(async (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const message = raw as FlujoChatMessage;
    const refs = message.toolPayloads;
    if (!refs || Object.keys(refs).length === 0) return message;
    const canonical = canonicalById.get(message.id);

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const canonicalCalls = canonical?.role === 'assistant' && Array.isArray(canonical.tool_calls)
        ? new Map((canonical.tool_calls as FlujoFunctionToolCall[]).map((call) => [call.id, call]))
        : new Map<string, FlujoFunctionToolCall>();
      const toolCalls = await Promise.all((message.tool_calls as FlujoFunctionToolCall[]).map(async (call) => {
        const ref = refs[call.id]?.arguments;
        if (!ref) return call;
        const canonicalArgs = canonicalCalls.get(call.id)?.function.arguments;
        const args = typeof canonicalArgs === 'string'
          ? canonicalArgs
          : (await readExactPayload(ref, call.id, 'arguments')).text;
        return { ...call, function: { ...call.function, arguments: args } };
      }));
      const hydrated = { ...message, tool_calls: toolCalls };
      delete hydrated.toolPayloads;
      return hydrated;
    }

    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      const ref = refs[message.tool_call_id]?.result;
      let content = message.content;
      if (ref) {
        if (
          canonical?.role === 'tool'
          && canonical.tool_call_id === message.tool_call_id
          && typeof canonical.content === 'string'
        ) {
          content = canonical.content;
        } else {
          const full = await readExactPayload(ref, message.tool_call_id, 'result');
          const settings = await getRunResourceSettings();
          const bounded = await boundToolResult({
            conversationId: targetConversationId,
            toolCallId: message.tool_call_id,
            server: full.entry.producedBy.server ?? 'unknown',
            toolName: full.entry.producedBy.toolName ?? 'unknown',
            nodeId: full.entry.producedBy.nodeId,
            content: full.text,
            settings,
          });
          content = bounded.content;
        }
      }
      const hydrated = { ...message, content };
      delete hydrated.toolPayloads;
      return hydrated;
    }

    const hydrated = { ...message };
    delete hydrated.toolPayloads;
    return hydrated;
  }));
}
