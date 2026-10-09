/** Read-only evidence for a finished foreground utterance in an open flow run.
 * Dispatch completion belongs to the utterance; it never certifies child work. */
export function completedForegroundDispatch(conversationId, message, events) {
  if (!message || message.role !== 'assistant' || message.disabled || message.depth || message.tool_calls?.length
      || typeof message.processNodeId !== 'string') return false;
  const dispatches = events.filter(event => event.type === 'model:dispatch' && !event.depth
    && event.turn?.conversationId === conversationId);
  const dispatch = dispatches.at(-1);
  if (!dispatch || dispatch.turn.node?.nodeId !== message.processNodeId) return false;
  const committed = events.filter(event => event.type === 'message' && !event.depth && event.message?.id === message.id).at(-1);
  if (!committed || committed.seq < dispatch.seq || JSON.stringify(committed.message.content) !== JSON.stringify(message.content)) return false;
  const result = events.filter(event => event.type === 'model:dispatch-result' && !event.depth
    && event.dispatchId === dispatch.turn.id).at(-1);
  return result?.outcome === 'completed'
    && !events.some(event => event.type === 'model:end' && event.messageId === message.id && event.discard);
}
