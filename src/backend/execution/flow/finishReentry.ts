import type { Flow } from '@/shared/types/flow';
import type { FlujoChatMessage } from '@/shared/types/chat';

/**
 * A Finish step ends a turn, not the conversation. When a new message arrives
 * on a conversation that stopped at a Finish step, return the step to run
 * instead: the model step that answered last (the step the chat window names
 * for its next message), or the Start step when no model step answered.
 * Returns undefined when the conversation is not at a Finish step.
 */
export function nodeAfterFinishStep(
  flow: Pick<Flow, 'nodes'> | null | undefined,
  currentNodeId: string | undefined,
  messages: readonly Pick<FlujoChatMessage, 'role' | 'processNodeId'>[],
): string | undefined {
  const nodes = flow?.nodes ?? [];
  const typeOf = (id: string | undefined) => id ? nodes.find(node => node.id === id)?.type : undefined;
  if (typeOf(currentNodeId) !== 'finish') return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && typeOf(message.processNodeId) === 'process') return message.processNodeId;
  }
  return nodes.find(node => node.type === 'start')?.id;
}
