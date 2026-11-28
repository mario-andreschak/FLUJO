// The live view of a running model call: transcript messages, deltas and tool progress on the event stream.
import { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelStreamDelta, ModelToolProgress } from '@/backend/services/model/adapters/types';
import { commitFlowDurableMutation, type FlowDurableMutationContext } from '@/backend/execution/flow/executionAuthority';
import { persistStreamedMessage } from './streamedAssistantMessages';
import type { EmitFn } from '@/shared/types/execution/events';
import type { FlowExecutionAuthority } from '../types';

/** What the live projection needs from the model call. */
export type LiveModelProjectionContext = {
  emit?: EmitFn;
  conversationId?: string;
  nodeId?: string;
  durableContext: FlowDurableMutationContext;
  executionAuthority?: FlowExecutionAuthority;
};

/**
 * Live view of a model call that is still running: transcript messages,
 * token deltas and tool progress reach the conversation's event stream as
 * they happen. Transcript messages are written in order under the run's
 * authority; finish() closes the gate before draining, so a late adapter
 * callback cannot add to a newer run.
 */
export function createLiveModelProjection(context: LiveModelProjectionContext) {
  const { emit, conversationId, nodeId, durableContext, executionAuthority } = context;
  // Live sink for self-orchestrating adapters (Claude subscription): surface
  // each assistant/tool message on the conversation's event stream AS it is
  // produced inside the adapter's agentic loop, rather than only when the whole
  // (possibly hour-long) call returns. The message carries a stable id that the
  // transcript materialization below reuses, so this live copy and the final
  // persisted copy dedupe in the UI. Emitting also keeps the frontend's
  // "no activity" timer reset while background tool calls are in flight.
  const liveMessageIds = new Set<string>();
  let acceptLiveProjection = true;
  let liveProjectionFailure: unknown;
  let liveProjectionChain: Promise<void> = Promise.resolve();
  const enqueueLiveProjection = (task: () => Promise<void>): void => {
    liveProjectionChain = liveProjectionChain.then(async () => {
      if (liveProjectionFailure) return;
      try {
        await task();
      } catch (error) {
        liveProjectionFailure = error;
      }
    });
  };
  const finishLiveProjection = async (): Promise<void> => {
    // Close the callback gate before draining: an adapter that resolves and
    // then invokes a late callback cannot append to a newer generation.
    acceptLiveProjection = false;
    await liveProjectionChain;
    if (liveProjectionFailure) throw liveProjectionFailure;
  };
  const flushLiveProjection = async (): Promise<void> => {
    await liveProjectionChain;
    if (liveProjectionFailure) throw liveProjectionFailure;
  };
  const onTranscriptMessage = emit
    ? (message: FlujoChatMessage) => {
        if (!acceptLiveProjection || executionAuthority?.signal.aborted) return;
        const withNode: FlujoChatMessage = nodeId ? { ...message, processNodeId: nodeId } : message;
        enqueueLiveProjection(() => commitFlowDurableMutation(durableContext, async () => {
          // A native partial draft with this id is now durable and must survive
          // a later failure in the same self-orchestrating run.
          liveMessageIds.delete(message.id);
          emit({ type: 'message', message: withNode, node: nodeId ? { nodeId } : undefined });
          // Fold under the SAME authority as the event.  The bus append is
          // independently fenced by conversationLog when it reaches disk.
          if (conversationId) persistStreamedMessage(conversationId, withNode);
        }));
      }
    : undefined;

  // Native adapter token/tool deltas are live-only. Keep their stable ids so a
  // failed attempt can explicitly retract its transient UI drafts.
  const onModelDelta = emit
    ? (delta: ModelStreamDelta) => {
        if (!acceptLiveProjection || executionAuthority?.signal.aborted) return;
        liveMessageIds.add(delta.messageId);
        emit({
          type: 'model:delta',
          messageId: delta.messageId,
          delta: delta.contentDelta,
          // Never push large base64 blobs through the live SSE channel.
          // Binary media is persisted and delivered with the durable message.
          mediaPart:
            delta.mediaPart &&
            !delta.mediaPart.data &&
            !delta.mediaPart.url?.startsWith('data:')
              ? delta.mediaPart
              : undefined,
          toolCallDelta: delta.toolCallDelta,
          node: nodeId ? { nodeId } : undefined,
        });
      }
    : undefined;

  // Claude/Codex own their tool loops inside createCompletion(), so their MCP
  // progress callbacks cannot pass through processToolCalls below. Project
  // them onto the same live event used by the ordinary tool loop.
  const onToolProgress = emit
    ? (progress: ModelToolProgress) => {
        emit({
          type: 'tool:progress',
          toolCallId: progress.toolCallId,
          name: progress.name,
          progress: progress.progress,
          total: progress.total,
          message: progress.message,
          node: nodeId ? { nodeId } : undefined,
        });
      }
    : undefined;

  return {
    /** Ids of live-only drafts that no durable message has confirmed yet. */
    liveMessageIds,
    isAccepting: () => acceptLiveProjection,
    enqueue: enqueueLiveProjection,
    finish: finishLiveProjection,
    flush: flushLiveProjection,
    onTranscriptMessage,
    onModelDelta,
    onToolProgress,
  };
}
