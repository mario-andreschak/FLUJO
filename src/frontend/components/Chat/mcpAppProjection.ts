import type { FlujoChatMessage } from '@/shared/types/chat';
import { canvasKey } from './canvasState';
import type { ToolCallPair } from './toolCallPairing';

/** One transcript occurrence of a tool-linked MCP App resource. */
export interface McpAppOccurrence {
  key: string;
  serverName: string;
  uri: string;
  toolName?: string;
  toolArgs?: string;
  resultContent?: string;
  cancelledReason?: string;
  isError?: boolean;
  /** Stable delivery identity; result ids win because they identify completion. */
  updateId: string;
  toolCallId: string;
  resultMessageId?: string;
}

/** Ordered projection of all calls in one assistant timeline that share an App. */
export interface McpAppOccurrenceGroup {
  key: string;
  serverName: string;
  uri: string;
  occurrences: McpAppOccurrence[];
  /** Deterministically the last occurrence in transcript/tool-call order. */
  latest: McpAppOccurrence;
}

/**
 * Project call-centric transcript data into resource-centric MCP App groups.
 *
 * Tool chips remain call-centric, but an interactive View is rendered once for
 * each `serverName::resourceUri` represented in the assistant timeline. This is
 * deliberately pure: resource reads, frame mounting and canvas handoff happen
 * only after the projection has selected one deterministic latest occurrence.
 */
export function groupMcpAppOccurrences<TMessage extends FlujoChatMessage>(
  pairs: ToolCallPair<TMessage>[],
): McpAppOccurrenceGroup[] {
  const groups = new Map<string, McpAppOccurrenceGroup>();

  for (const pair of pairs) {
    const ui = pair.result?.ui;
    if (!ui?.uri || !ui.serverName) continue;

    const toolCallId = pair.toolCall.id || `${ui.serverName}:${pair.toolCall.function.name}`;
    const resultMessageId = pair.result?.id || undefined;
    const key = canvasKey(ui.serverName, ui.uri);
    const occurrence: McpAppOccurrence = {
      key,
      serverName: ui.serverName,
      uri: ui.uri,
      toolName: ui.toolName ?? pair.toolCall.function.name,
      toolArgs: ui.toolArgs ?? pair.toolCall.function.arguments,
      resultContent: typeof pair.result?.content === 'string' ? pair.result.content : undefined,
      cancelledReason: ui.cancelledReason,
      isError: ui.isError,
      updateId: resultMessageId ?? toolCallId,
      toolCallId,
      resultMessageId,
    };

    const existing = groups.get(key);
    if (existing) {
      existing.occurrences.push(occurrence);
      existing.latest = occurrence;
    } else {
      groups.set(key, {
        key,
        serverName: ui.serverName,
        uri: ui.uri,
        occurrences: [occurrence],
        latest: occurrence,
      });
    }
  }

  return [...groups.values()];
}

/**
 * Observe App-bearing result messages for one conversation.
 *
 * The first snapshot establishes a passive hydration baseline and returns no
 * launch candidates. Later calls return only newly appended result ids and add
 * them to the caller-owned observed set, making auto-launch edge-triggered.
 */
export function observeNewMcpAppResultIds<TMessage extends FlujoChatMessage>(
  observedByConversation: Map<string, Set<string>>,
  conversationId: string,
  messages: TMessage[],
): string[] {
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.ui?.uri && message.ui.serverName && message.id) {
      resultIds.add(message.id);
    }
  }

  const observed = observedByConversation.get(conversationId);
  if (!observed) {
    observedByConversation.set(conversationId, resultIds);
    return [];
  }

  const fresh = [...resultIds].filter((id) => !observed.has(id));
  for (const id of resultIds) observed.add(id);
  return fresh;
}

/** Keep only the last candidate result for each App resource in transcript order. */
export function latestMcpAppResultIdsByResource<TMessage extends FlujoChatMessage>(
  messages: TMessage[],
  candidateIds: Iterable<string>,
): string[] {
  const candidates = new Set(candidateIds);
  const latestByResource = new Map<string, string>();
  for (const message of messages) {
    if (
      message.role !== 'tool'
      || !candidates.has(message.id)
      || !message.ui?.uri
      || !message.ui.serverName
    ) continue;
    latestByResource.set(canvasKey(message.ui.serverName, message.ui.uri), message.id);
  }
  return [...latestByResource.values()];
}
