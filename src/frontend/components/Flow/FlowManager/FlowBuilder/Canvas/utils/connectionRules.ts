import { NodeType } from '@/frontend/types/flow/flow';

/**
 * Single source of truth for which nodes may connect to which. Both the
 * connection validator (edgeUtils.validateConnection) and the drop-on-pane
 * node picker (NodeSelectionModal) derive from getConnectionError, so the
 * picker can never offer a node type the validator then rejects.
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
 * Why a connection between the given endpoints is not allowed, or null when
 * it is:
 * - nothing may connect INTO a Start node or OUT OF a Finish node
 * - anything involving an MCP node or an MCP handle must link an MCP node
 *   with a Process node (the tool-wiring relationship); MCP handles cannot
 *   be used for flow control between other node types
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
  }

  return null;
}

/** The default target handle a node type is connected on when auto-wiring. */
export function defaultTargetHandleFor(nodeType: NodeType): string {
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
  const all: NodeType[] = ['process', 'finish', 'mcp', 'subflow'];
  if (!sourceType || !sourceHandleId) return all;
  return all.filter(
    t => getConnectionError(sourceType, sourceHandleId, t, defaultTargetHandleFor(t)) === null
  );
}
