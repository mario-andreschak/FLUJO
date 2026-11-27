// Unattended runs: keep a run going when a step ends on plain text.
import { createLogger } from '@/utils/logger';
import type { EmitFn } from '@/shared/types/execution/events';
import type { SharedState } from '@/backend/execution/flow/types';
import { flowService } from '@/backend/services/flow/index';
import type { Flow } from '@/shared/types/flow';

const log = createLogger('backend/execution/flow/unattendedDriveForward');

/** Unattended mode (issue #218): how many times to re-prompt a Process node
 *  that ended on plain text but has MORE THAN ONE forward successor (so the
 *  engine can't pick deterministically) before giving up and completing the
 *  run. The single-forward-successor case never nudges — it auto-advances. */
const UNATTENDED_MAX_NUDGES = 1;

export type UnattendedOutcome = 'advanced' | 'nudged' | 'complete';

/**
 * Unattended drive-forward (issue #218). Called when a step returned
 * FINAL_RESPONSE_ACTION (a Process node ended its turn on plain text with no
 * tool call / handoff). In a normal run that silently completes the flow — a
 * problem for headless runs where the model "narrates and stops" instead of
 * handing off, leaving the flow dead halfway (labels not moved, no commit,
 * status reported as success). In UNATTENDED mode:
 *   - exactly ONE forward (non-returning) control successor  -> auto-advance to
 *     it (the author's unambiguous continuation);
 *   - MORE THAN ONE                                          -> re-prompt the
 *     model to hand off, bounded by UNATTENDED_MAX_NUDGES, then complete;
 *   - ZERO (a genuine leaf, e.g. a simple answer flow)       -> complete as
 *     today.
 * "Forward" excludes explicit bidirectional back-edges AND one-way terminal
 * Subflows (both return to their caller rather than progress toward a finish),
 * plus MCP/resource attachments. Only Process nodes are driven; a Finish node
 * reaching FINAL_RESPONSE_ACTION completes normally.
 */
export async function unattendedDriveForward(
  state: SharedState,
  emit: EmitFn,
  nudges: Map<string, number>,
): Promise<UnattendedOutcome> {
  if (!state.unattended) return 'complete';

  const nodeId = state.currentNodeId;
  if (!nodeId) return 'complete';

  let flow: Flow | undefined;
  try {
    flow = state.flowSnapshot
      ?? (state.flowId ? (await flowService.getFlow(state.flowId)) ?? undefined : undefined);
  } catch (err) {
    log.debug('[Unattended] flow load failed; completing normally', { err });
    return 'complete';
  }
  if (!flow) return 'complete';

  const node = flow.nodes?.find(n => n.id === nodeId);
  // Only Process nodes stall on plain text. A finish node (or anything else)
  // reaching here means the flow genuinely ended — complete normally.
  if (!node || node.type !== 'process') return 'complete';

  const flowNodes = flow.nodes ?? [];
  const flowEdges = flow.edges ?? [];
  const mcpNodeIds = new Set(flowNodes.filter(n => n.type === 'mcp').map(n => n.id));

  // Mirror FlowConverter's control-successor rules. A Subflow has an explicit
  // onward path when it authors a non-attachment outgoing edge, or when a
  // bidirectional edge pointing at it supplies a reverse successor. Without
  // either, Process -> Subflow is an implicit call/return and must not be
  // mistaken for unattended forward progress.
  const hasRuntimeControlSuccessor = (subflowId: string): boolean =>
    flowEdges.some((edge) => {
      const data = edge.data as { edgeType?: string; bidirectional?: boolean } | undefined;
      const attachment =
        edge.type === 'mcpEdge' ||
        data?.edgeType === 'mcp' ||
        data?.edgeType === 'resource';
      if (attachment) return false;
      return edge.source === subflowId || (edge.target === subflowId && data?.bidirectional === true);
    });

  const isImplicitReturningSubflow = (targetId: string): boolean => {
    const target = flowNodes.find(candidate => candidate.id === targetId);
    return target?.type === 'subflow' && !hasRuntimeControlSuccessor(targetId);
  };

  const forwardTargets = Array.from(
    new Set(
      flowEdges
        .filter(e =>
          e.source === nodeId &&
          e.type !== 'mcpEdge' &&
          (e.data as { edgeType?: string; bidirectional?: boolean } | undefined)?.edgeType !== 'mcp' &&
          (e.data as { edgeType?: string; bidirectional?: boolean } | undefined)?.edgeType !== 'resource' &&
          (e.data as { edgeType?: string; bidirectional?: boolean } | undefined)?.bidirectional !== true &&
          !mcpNodeIds.has(e.target) &&
          !isImplicitReturningSubflow(e.target),
        )
        .map(e => e.target),
    ),
  ).filter(t => flowNodes.some(n => n.id === t));

  if (forwardTargets.length === 1) {
    const nextNodeId = forwardTargets[0];
    log.info(
      `[Unattended] Process node ${nodeId} ended on plain text; auto-advancing to sole forward successor ${nextNodeId} for conv ${state.conversationId}.`,
    );
    const fromNodeId = state.currentNodeId;
    state.currentNodeId = nextNodeId;
    state.handoffRequested = undefined;
    nudges.delete(nodeId);
    emit({
      type: 'handoff',
      from: fromNodeId ? { nodeId: fromNodeId } : undefined,
      toNodeId: nextNodeId,
      edgeId: `unattended-auto:${nodeId}->${nextNodeId}`,
    });
    return 'advanced';
  }

  if (forwardTargets.length > 1) {
    const count = nudges.get(nodeId) ?? 0;
    if (count < UNATTENDED_MAX_NUDGES) {
      nudges.set(nodeId, count + 1);
      log.info(
        `[Unattended] Process node ${nodeId} ended on plain text with ${forwardTargets.length} forward successors; nudging to hand off (attempt ${count + 1}/${UNATTENDED_MAX_NUDGES}).`,
      );
      state.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        content:
          'You ended your turn without calling a tool or handing off, but this is an unattended run that cannot stop at this step. To continue you MUST call one of your handoff tools to route to the next step. If your work at this step is complete, hand off to the finishing/next step now.',
        timestamp: Date.now(),
        processNodeId: nodeId,
      });
      return 'nudged';
    }
    log.warn(
      `[Unattended] Process node ${nodeId} still did not hand off after ${UNATTENDED_MAX_NUDGES} nudge(s); completing the run to avoid a loop.`,
    );
    return 'complete';
  }

  // Zero forward successors: a genuine leaf. Nothing to drive to — complete.
  return 'complete';
}
