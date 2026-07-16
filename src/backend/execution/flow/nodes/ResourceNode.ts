// Local implementation of PocketFlow for debugging
import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import { SharedState, ResourceNodeParams } from '../types';

const log = createLogger('backend/flow/execution/nodes/ResourceNode');

/**
 * Resource node (Tier 3) — a pure config holder, like the MCP node but even
 * more so: it is NEVER executed. FlowConverter folds its binding into the
 * connected Process node's params (`properties.resourceNodes`) and resource
 * edges never call addSuccessor, so control flow can't enter this node. The
 * class exists only to satisfy FlowConverter.createNode's exhaustive switch
 * (and to fail loudly if a hand-crafted flow somehow routes into one).
 */
export class ResourceNode extends BaseNode {
  async prep(_sharedState: SharedState, node_params?: ResourceNodeParams): Promise<Record<string, never>> {
    // Reaching here means a control edge was wired into a resource node —
    // the builder/validator forbid it, but a hand-crafted flow could.
    log.warn('ResourceNode.prep() reached — resource nodes are config holders and should never execute', {
      nodeId: node_params?.id,
    });
    return {};
  }

  async execCore(): Promise<Record<string, never>> {
    return {};
  }

  async post(
    _prepResult: unknown,
    _execResult: unknown,
    _sharedState: SharedState,
    _node_params?: ResourceNodeParams
  ): Promise<string> {
    // Pass through to the first successor if one exists (mirrors MCPNode).
    const actions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});
    return actions.length > 0 ? actions[0] : 'default';
  }

  _clone(): BaseNode {
    return new ResourceNode();
  }
}
