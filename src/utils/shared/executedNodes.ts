// deriveExecutedNodeIds (issue #213)
// -----------------------------------------------------------------------------
// Pure helper that computes the set of node ids actually executed in a
// conversation, for the Chat "Executed Steps" path panel. It merges three
// graceful-fallback sources so the executed path is recoverable regardless of
// which data happens to be hydrated for a given conversation:
//
//   1. per-message `processNodeId` — the append-style conversation log; always
//      available, even for old conversations whose run SharedState is gone.
//   2. `trackingInfo.nodeExecutionTracker` — populated in both debug and normal
//      runs while the SharedState is live.
//   3. `executionTrace` — richer, but only present in debug mode.
//
// Only nodes that were truly visited are added, so for a branching flow (B xor
// C) the untaken branch never appears and thus stays dimmed. Ids are de-duped
// (a looped node is listed once) and returned in first-seen order.

export interface ExecutedNodesSources {
  /** Conversation messages carrying an optional `processNodeId`. */
  messages?: ReadonlyArray<{ processNodeId?: string }> | null;
  /** Node execution tracker entries (each with an optional `nodeId`). */
  nodeExecutionTracker?: ReadonlyArray<{ nodeId?: string }> | null;
  /** Debug execution trace steps (each with an optional `nodeId`). */
  executionTrace?: ReadonlyArray<{ nodeId?: string }> | null;
  /** Node ids accumulated live from the `node:enter` SSE stream (issue #243).
   *  Unlike the other sources this covers EVERY node type (start/finish/mcp/
   *  signal/...), not just Process nodes, so the executed-path highlight is no
   *  longer Process-only. May be a Set or a plain array. */
  sseVisitedIds?: ReadonlySet<string> | ReadonlyArray<string> | null;
}

export function deriveExecutedNodeIds(sources: ExecutedNodesSources): string[] {
  const ids = new Set<string>();
  sources.messages?.forEach(m => { if (m?.processNodeId) ids.add(m.processNodeId); });
  sources.nodeExecutionTracker?.forEach(e => { if (e?.nodeId) ids.add(e.nodeId); });
  sources.executionTrace?.forEach(s => { if (s?.nodeId) ids.add(s.nodeId); });
  sources.sseVisitedIds?.forEach(id => { if (id) ids.add(id); });
  return Array.from(ids);
}
