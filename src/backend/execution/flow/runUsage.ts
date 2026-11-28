// Token usage totals of a run, per node, with the live usage event.
import { EmitFn, UsageTotals } from '@/shared/types/execution/events';
import { SharedState } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';

/**
 * Adds one message's reported usage to the run's totals (overall and per
 * node) and emits the usage event. A call that reported no usage is counted,
 * so a total of 0 reads as "not reported" rather than "nothing used".
 */
export const accumulateUsage = (sharedState: SharedState, emit: EmitFn, msg: FlujoChatMessage) => {
  if (!msg.usage && !msg.usageNotReported) return;
  const totals: UsageTotals = sharedState.usage ?? {
    promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, byNode: {},
  };
  sharedState.usage = totals;
  if (!msg.usage) {
    // Count the call, so a total of 0 reads as "not reported" rather than "nothing used".
    const nodeKey = msg.processNodeId || 'unknown';
    const node = totals.byNode[nodeKey] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
    totals.unreportedCalls = (totals.unreportedCalls ?? 0) + 1;
    node.unreportedCalls = (node.unreportedCalls ?? 0) + 1;
    totals.byNode[nodeKey] = node;
    emit({
      type: 'usage',
      node: msg.processNodeId ? { nodeId: msg.processNodeId } : undefined,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      notReported: true,
    });
    return;
  }
  totals.promptTokens += msg.usage.promptTokens;
  totals.completionTokens += msg.usage.completionTokens;
  totals.totalTokens += msg.usage.totalTokens;
  // Cache RE-READ tokens are a subset of promptTokens; track them separately so
  // the UI can show the honest "fresh (+cached)" split (#87). Guard with ?? 0
  // so state persisted before #87 (no cacheReadTokens) doesn't produce NaN.
  const msgCacheRead = msg.usage.cacheReadTokens ?? 0;
  if (msgCacheRead) totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + msgCacheRead;
  const msgCacheWrite = msg.usage.cacheWriteTokens ?? 0;
  if (msgCacheWrite) totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + msgCacheWrite;
  const nodeKey = msg.processNodeId || 'unknown';
  const node = totals.byNode[nodeKey] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
  node.promptTokens += msg.usage.promptTokens;
  node.completionTokens += msg.usage.completionTokens;
  node.totalTokens += msg.usage.totalTokens;
  if (msgCacheRead) node.cacheReadTokens = (node.cacheReadTokens ?? 0) + msgCacheRead;
  if (msgCacheWrite) node.cacheWriteTokens = (node.cacheWriteTokens ?? 0) + msgCacheWrite;
  totals.byNode[nodeKey] = node;
  emit({
    type: 'usage',
    node: msg.processNodeId ? { nodeId: msg.processNodeId } : undefined,
    promptTokens: msg.usage.promptTokens,
    completionTokens: msg.usage.completionTokens,
    totalTokens: msg.usage.totalTokens,
    costUsd: 0,
    ...(msgCacheRead ? { cacheReadTokens: msgCacheRead } : {}),
    ...(msgCacheWrite ? { cacheWriteTokens: msgCacheWrite } : {}),
  });
};
