import { NodeType } from '@/shared/types/flow';

/**
 * Single source of truth for which nodes may connect to which. Both the connection validator
 * (edgeUtils.validateConnection) and the drop-on-pane node picker (NodeSelectionModal) derive
 * from getConnectionError, so the picker can never offer a node type the validator then
 * rejects. The auto-repair planner (flowAutoRepair.ts) uses the same rules so every edge it
 * injects is one the builder would have allowed.
 *
 * Lives in utils/shared (pure, no framework/component imports) so the backend + the pure
 * repair/compile modules can share it with the frontend Canvas utils, which re-export from
 * here. Moved out of FlowBuilder/Canvas/utils/connectionRules.ts unchanged.
 */

/**
 * MCP wiring handles are exactly the handle ids containing 'mcp': the mcp-*
 * handles on MCP nodes and process-left-mcp / process-right-mcp on Process
 * nodes.
 */
export function isMcpHandle(handleId?: string | null): boolean {
  return !!handleId && handleId.includes('mcp');
}

/**
 * Resource wiring handles (Tier 3): the resource-in / resource-out handles on
 * Resource nodes and process-left-resource / process-right-resource on Process
 * nodes. Never overlaps isMcpHandle — no resource handle id contains 'mcp'.
 */
export function isResourceHandle(handleId?: string | null): boolean {
  return !!handleId && handleId.includes('resource');
}

/**
 * ATTACHMENT edges are configuration wiring, not flow control: 'mcp' edges
 * bind tool servers to a step, 'resource' edges bind data artifacts (consume /
 * produce). Every control-flow discrimination in the codebase (reachability,
 * successor wiring, subflow single-outgoing counting, edge conditions,
 * auto-repair, layout) must use THIS predicate rather than testing
 * `edgeType === 'mcp'` — otherwise a resource edge is silently misread as a
 * control edge and corrupts the flow's structure.
 */
export function isAttachmentEdge(edge: { data?: { edgeType?: unknown } | null }): boolean {
  const t = edge?.data?.edgeType;
  return t === 'mcp' || t === 'resource';
}

/**
 * Why a connection between the given endpoints is not allowed, or null when
 * it is:
 * - nothing may connect INTO a Start node or OUT OF a Finish node
 * - anything involving an MCP node or an MCP handle must link an MCP node
 *   with a Process node (the tool-wiring relationship); MCP handles cannot
 *   be used for flow control between other node types
 * - anything involving a Resource node or a resource handle must link a
 *   Resource node with a Process node via resource handles (the data-wiring
 *   relationship, Tier 3). Direction encodes role: resource→process = the
 *   step CONSUMES the artifact; process→resource = the step PRODUCES it.
 */
export function getConnectionError(
  sourceType: string | undefined,
  sourceHandleId: string | null | undefined,
  targetType: string | undefined,
  targetHandleId: string | null | undefined
): string | null {
  if (targetType === 'start') {
    return 'Start nodes cannot have incoming connections';
  }
  if (sourceType === 'finish') {
    return 'Finish nodes cannot have outgoing connections';
  }

  const mcpInvolved =
    sourceType === 'mcp' ||
    targetType === 'mcp' ||
    isMcpHandle(sourceHandleId) ||
    isMcpHandle(targetHandleId);

  if (mcpInvolved) {
    const mcpPair =
      (sourceType === 'mcp' && targetType === 'process') ||
      (sourceType === 'process' && targetType === 'mcp');
    if (!mcpPair) {
      return 'MCP connections must link an MCP node to a Process node via MCP handles';
    }
    // From the Process side, MCP wiring uses the dedicated left/right MCP
    // handles — the bottom flow-control handle is not an MCP attachment
    // point. (From the MCP side every handle is an MCP handle already.)
    if (sourceType === 'process' && !isMcpHandle(sourceHandleId)) {
      return "Connect MCP nodes from the Process node's left/right MCP handles";
    }
    return null;
  }

  const resourceInvolved =
    sourceType === 'resource' ||
    targetType === 'resource' ||
    isResourceHandle(sourceHandleId) ||
    isResourceHandle(targetHandleId);

  if (resourceInvolved) {
    const resourcePair =
      (sourceType === 'resource' && targetType === 'process') ||
      (sourceType === 'process' && targetType === 'resource');
    if (!resourcePair) {
      return 'Resource connections must link a Resource node to a Process node via resource handles';
    }
    // From the Process side, resource wiring uses the dedicated left/right
    // resource handles (mirrors the MCP rule above).
    if (sourceType === 'process' && !isResourceHandle(sourceHandleId)) {
      return "Connect Resource nodes from the Process node's left/right resource handles";
    }
  }

  return null;
}

/** The default target handle a node type is connected on when auto-wiring. */
export function defaultTargetHandleFor(nodeType: NodeType, sourceHandleId?: string | null): string {
  // Resource wiring targets the dedicated resource handles, not the top
  // flow-control handle: a drag from process-right-resource lands on the
  // resource node's input; a drag from resource-out lands on the process
  // node's left resource handle.
  if (nodeType === 'resource') return 'resource-in';
  if (nodeType === 'process' && isResourceHandle(sourceHandleId)) return 'process-left-resource';
  if (nodeType === 'process' && isMcpHandle(sourceHandleId)) return 'process-left-mcp';
  return `${nodeType}-top`;
}

/**
 * The node types worth offering when a connection from the given source is
 * dropped on the empty pane — exactly those getConnectionError allows.
 */
export function validTargetTypesFor(
  sourceType?: NodeType,
  sourceHandleId?: string | null
): NodeType[] {
  const all: NodeType[] = ['process', 'finish', 'mcp', 'subflow', 'resource'];
  if (!sourceType || !sourceHandleId) return all;
  return all.filter(
    t => getConnectionError(sourceType, sourceHandleId, t, defaultTargetHandleFor(t, sourceHandleId)) === null
  );
}
