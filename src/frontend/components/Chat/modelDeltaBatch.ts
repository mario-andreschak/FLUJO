import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelDeltaEvent } from '@/shared/types/execution/events';

/**
 * Fold a burst of append-only model deltas into one immutable conversation
 * update. The SSE transport can emit dozens of chunks per second; applying
 * each chunk through React state separately repeatedly clones the transcript
 * and re-runs all of ChatMessages' full-history projections.
 */
export function applyModelDeltaBatch<
  Message extends FlujoChatMessage,
  Conversation extends { id: string; messages: Message[] },
>(conversation: Conversation, events: readonly ModelDeltaEvent[]): Conversation {
  if (events.length === 0) return conversation;

  let messages = conversation.messages;
  let changed = false;
  const indexes = new Map(messages.map((message, index) => [message.id, index]));

  for (const event of events) {
    if (event.conversationId !== conversation.id) continue;

    const existingIndex = indexes.get(event.messageId) ?? -1;
    const existing = existingIndex >= 0
      ? messages[existingIndex]
      : ({
          id: event.messageId,
          role: 'assistant',
          content: '',
          timestamp: event.timestamp,
          processNodeId: event.node?.nodeId,
        } as Message);

    if (existing.role !== 'assistant') continue;

    const toolCalls = [...(existing.tool_calls ?? [])];
    const toolDelta = event.toolCallDelta;
    if (toolDelta) {
      const prior = toolCalls[toolDelta.index];
      toolCalls[toolDelta.index] = {
        id: toolDelta.id ?? prior?.id ?? `pending_${event.messageId}_${toolDelta.index}`,
        type: 'function',
        function: {
          name: `${prior?.function.name ?? ''}${toolDelta.nameDelta ?? ''}`,
          arguments: `${prior?.function.arguments ?? ''}${toolDelta.argumentsDelta ?? ''}`,
        },
      };
    }

    const media = event.mediaPart
      ? [
          ...(existing.media ?? []),
          ...(existing.media ?? []).some(part =>
            part.type === event.mediaPart?.type
            && part.url === event.mediaPart?.url
            && part.resourceUri === event.mediaPart?.resourceUri
          )
            ? []
            : [event.mediaPart],
        ]
      : existing.media;

    const draft = {
      ...existing,
      content: `${typeof existing.content === 'string' ? existing.content : ''}${event.delta ?? ''}`,
      ...(media ? { media } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    } as Message;

    if (!changed) {
      messages = [...messages];
      changed = true;
    }
    if (existingIndex >= 0) {
      messages[existingIndex] = draft;
    } else {
      indexes.set(event.messageId, messages.length);
      messages.push(draft);
    }
  }

  return changed ? { ...conversation, messages } : conversation;
}
