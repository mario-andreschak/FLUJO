// Local implementation of PocketFlow for debugging
import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import { SharedState, SignalNodeParams } from '../types';
import { resolveRunVars } from '@/utils/shared/resolveRunVars';
import { getFlowRunEventBus, FlowRunFiredBy } from '@/backend/services/scheduler/flowRunEventBus';
import { FEATURES } from '@/config/features';

const log = createLogger('backend/flow/execution/nodes/SignalNode');

/**
 * Signal node (issue #117) — a deterministic, non-LLM, pass-through node. When
 * execution TRAVERSES it, it emits `{ topic, payload }` onto the process-global
 * flow-run event bus (payload = the node's template with `${var:NAME}` resolved)
 * and then hands off to its first successor unchanged. It complements #116's
 * completion events: instead of "run B after A finishes", a signal is
 * "A decides mid-run to kick off C now and keeps going" — and, because whether
 * the path REACHES the signal node is already governed by deterministic edge
 * conditions (Tier 2b), conditional emission ("emit only if the review found
 * blockers") is just a conditioned edge into the node.
 *
 * Design rules from the issue:
 *  - Transparent: it must NOT touch the conversation/messages (unlike StartNode,
 *    which injects a system message) so it is safe to drop inline on any path.
 *  - Fire-and-forget: the emit must never block or fail the emitting run; a bus
 *    error is logged, not propagated.
 *  - NOT suppressed by subflow depth (unlike completion events, which only emit
 *    at runDepth 0): a signal is an explicit authored emission and should fire
 *    wherever placed. Loop safety comes from the shared `chainDepth`.
 */
export class SignalNode extends BaseNode {
  async prep(_sharedState: SharedState, node_params?: SignalNodeParams): Promise<{ topic: string; payloadTemplate: string }> {
    const topic = (node_params?.properties?.topic ?? '').trim();
    const payloadTemplate = node_params?.properties?.payloadTemplate ?? '';
    log.info('prep() started', { nodeId: node_params?.id, topic, payloadTemplateLength: payloadTemplate.length });
    return { topic, payloadTemplate };
  }

  async execCore(): Promise<Record<string, never>> {
    // A signal node performs no work — the emit happens in post(), where the run
    // context (flowId, conversationId, chainDepth, variables) is in scope.
    return {};
  }

  async post(
    prepResult: { topic: string; payloadTemplate: string },
    _execResult: unknown,
    sharedState: SharedState,
    node_params?: SignalNodeParams
  ): Promise<string> {
    log.info('post() started', { nodeId: node_params?.id, topic: prepResult.topic });

    // Tracking (never alters the conversation).
    if (FEATURES.ENABLE_EXECUTION_TRACKER && Array.isArray(sharedState.trackingInfo?.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'SignalNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Signal Node',
        timestamp: new Date().toISOString(),
      });
    }

    // Fire-and-forget emit. A missing topic means nothing can match, so skip
    // (still transparent). Any failure is logged, never propagated.
    const topic = prepResult.topic;
    if (topic) {
      try {
        const payload = resolveRunVars(prepResult.payloadTemplate ?? '', sharedState.variables);
        const firedBy: FlowRunFiredBy =
          sharedState.source === 'schedule' ? 'schedule' : sharedState.source === 'api' ? 'api' : 'chat';
        getFlowRunEventBus().publish({
          kind: 'signal',
          topic,
          payload,
          emitterFlowId: sharedState.flowId,
          runId: sharedState.conversationId || '',
          conversationId: sharedState.conversationId || '',
          firedBy,
          // The emitting run's own depth — the listener increments it and
          // enforces maxChainDepth. Threaded onto SharedState by runFlow.
          chainDepth: sharedState.chainDepth ?? 0,
          timestamp: new Date().toISOString(),
        });
        log.info('Emitted signal', { topic, payloadLength: payload.length, chainDepth: sharedState.chainDepth ?? 0 });
      } catch (error) {
        log.warn('Signal emit failed (ignored so the run continues):', error);
      }
    } else {
      log.warn('Signal node has no topic; nothing emitted', { nodeId: node_params?.id });
    }

    // Pass through to the first successor if one exists (mirrors StartNode/MCPNode).
    const actions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});
    return actions.length > 0 ? actions[0] : 'default';
  }

  _clone(): BaseNode {
    return new SignalNode();
  }
}
