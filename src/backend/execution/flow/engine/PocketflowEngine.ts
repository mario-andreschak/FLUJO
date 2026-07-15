import { Flow as PocketFlow, BaseNode } from '../pocketflow';
import { flowService } from '@/backend/services/flow';
import { FlowConverter } from '../FlowConverter';
import { createLogger } from '@/utils/logger';
import { SharedState } from '../types';
import { EmitFn } from '@/shared/types/execution/events';
import { FlowEngine, ResolvedNode, RunNodeResult, HandoffResolution } from './FlowEngine';

const log = createLogger('backend/execution/flow/engine/PocketflowEngine');

/**
 * FlowEngine backed by the embedded PocketFlow framework (pocketflow.ts).
 * All knowledge of PocketFlow's graph/node model lives here; everything above
 * it (FlowExecutor, routes, UI) talks only to the FlowEngine interface.
 */
export class PocketflowEngine implements FlowEngine {
  // Cache of compiled PocketFlow conversions, keyed by flowId.
  private pocketFlowCache = new Map<string, PocketFlow>();

  clearCache(flowId?: string): void {
    if (flowId) {
      this.pocketFlowCache.delete(flowId);
    } else {
      this.pocketFlowCache.clear();
    }
  }

  /**
   * Resolve the compiled flow for a run. Quick-Chats (issue #61) carry a
   * `flowSnapshot` on the state: when present it is converted directly,
   * bypassing the flows store; otherwise we fall back to the store lookup by
   * `flowId` (the unchanged path for every saved flow). The compiled-flow cache
   * is keyed by flowId either way — a snapshot's `quickchat-<convId>` id can
   * never collide with a stored flow id, and the snapshot is immutable for the
   * life of the conversation so its cache entry is always safe.
   */
  private async resolveFlowDefinition(sharedState: SharedState): Promise<PocketFlow> {
    const flowId = sharedState.flowId;
    if (this.pocketFlowCache.has(flowId)) {
      log.debug(`Using cached Pocket Flow for flowId: ${flowId}`);
      // Return a clone to prevent modification of the cached instance
      return this.pocketFlowCache.get(flowId)!.clone() as PocketFlow;
    }

    let reactFlow = sharedState.flowSnapshot;
    if (reactFlow) {
      log.verbose(`Resolving flow ${flowId} from an in-memory quick-chat snapshot.`);
    } else {
      log.verbose(`Loading and converting flow for flowId: ${flowId}`);
      reactFlow = (await flowService.getFlow(flowId)) ?? undefined;
      if (!reactFlow) {
        log.error(`Flow not found for flowId: ${flowId}`);
        throw new Error(`Flow not found: ${flowId}`);
      }
    }

    log.info(`Found flow: ${reactFlow.name}`, {
      flowId: reactFlow.id,
      nodeCount: reactFlow.nodes.length,
      edgeCount: reactFlow.edges.length
    });

    const pocketFlow = FlowConverter.convert(reactFlow);
    this.pocketFlowCache.set(flowId, pocketFlow);
    log.verbose(`Flow ${flowId} converted and cached.`);
    return pocketFlow.clone() as PocketFlow;
  }

  /** BFS lookup of a node by ID within a compiled flow. */
  private async findNodeById(flow: PocketFlow, nodeId: string): Promise<BaseNode | undefined> {
    log.verbose(`Searching for node ${nodeId} in flow ${flow.node_params?.id}`);
    const startNode = await flow.getStartNode();
    const queue: BaseNode[] = [startNode];
    const visited = new Set<string>();
    const startNodeId = startNode.node_params?.id;
    if (startNodeId) {
      visited.add(startNodeId);
    } else {
      log.warn('Start node is missing an ID in its parameters.');
    }

    while (queue.length > 0) {
      const currentNode = queue.shift()!;
      const currentId = currentNode.node_params?.id;

      if (currentId === nodeId) {
        log.verbose(`Found node ${nodeId}`);
        return currentNode;
      }

      if (currentNode.successors instanceof Map) {
        for (const successor of currentNode.successors.values()) {
          const successorId = successor.node_params?.id;
          if (typeof successorId === 'string' && successorId.length > 0 && !visited.has(successorId)) {
            visited.add(successorId);
            queue.push(successor.clone());
          }
        }
      }
    }

    log.warn(`Node ${nodeId} not found in flow.`);
    return undefined;
  }

  async resolveNode(sharedState: SharedState): Promise<ResolvedNode> {
    const { conversationId, currentNodeId } = sharedState;
    const pocketFlow = await this.resolveFlowDefinition(sharedState);

    let currentNode: BaseNode | undefined;

    if (currentNodeId) {
      currentNode = await this.findNodeById(pocketFlow, currentNodeId);
      if (!currentNode) {
        log.warn(`Resuming conversation ${conversationId}, but node ${currentNodeId} not found. Starting from beginning.`);
        currentNode = await pocketFlow.getStartNode();
      } else {
        log.info(`Resuming conversation ${conversationId} at node ${currentNodeId}`);
      }
    } else {
      // Resume from the node of the last message if it carries a processNodeId
      const lastMessage = sharedState.messages.length > 0
        ? sharedState.messages[sharedState.messages.length - 1]
        : null;

      if (lastMessage?.processNodeId) {
        log.info(`Found processNodeId ${lastMessage.processNodeId} in last message. Attempting to resume from this node.`);
        currentNode = await this.findNodeById(pocketFlow, lastMessage.processNodeId);
        if (currentNode) {
          log.info(`Resuming conversation ${conversationId} from node ${lastMessage.processNodeId} based on last message.`);
        } else {
          log.warn(`Could not find node ${lastMessage.processNodeId} from last message. Starting from beginning.`);
          currentNode = await pocketFlow.getStartNode();
        }
      } else {
        currentNode = await pocketFlow.getStartNode();
        log.info(`Starting conversation ${conversationId} from the beginning.`);
      }
    }

    if (!currentNode) {
      throw new Error('Execution error: Cannot find starting node.');
    }

    const nodeId = currentNode.node_params?.id;
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      throw new Error(`Execution error: Node ${currentNode.constructor.name} is missing an ID.`);
    }

    return {
      handle: currentNode,
      id: nodeId,
      type: currentNode.node_params?.type || 'unknown',
      name: currentNode.node_params?.label || 'Unknown Node',
    };
  }

  async resolveHandoff(sharedState: SharedState, action: string): Promise<HandoffResolution> {
    const { currentNodeId } = sharedState;
    if (!currentNodeId || !action) {
      return { isSuccessorEdge: false, targetNodeId: null };
    }

    const pocketFlow = await this.resolveFlowDefinition(sharedState);
    const currentNode = await this.findNodeById(pocketFlow, currentNodeId);

    if (!currentNode || !currentNode.successors.has(action)) {
      return { isSuccessorEdge: false, targetNodeId: null };
    }

    const nextNode = currentNode.getSuccessor(action);
    const nextNodeId = nextNode?.node_params?.id;
    const nextNodeType = nextNode?.node_params?.type;
    return {
      isSuccessorEdge: true,
      targetNodeId: typeof nextNodeId === 'string' && nextNodeId.length > 0 ? nextNodeId : null,
      targetNodeType: typeof nextNodeType === 'string' ? nextNodeType : null,
    };
  }

  async runNode(node: ResolvedNode, sharedState: SharedState, emit?: EmitFn): Promise<RunNodeResult> {
    const currentNode = node.handle as BaseNode;
    // PocketFlow nodes can read `emit` off sharedState during run() (e.g. to
    // emit model/handoff events). Attach it for the duration of this step,
    // then detach so it is never persisted.
    if (emit) {
      sharedState.emit = emit;
    }
    try {
      log.debug(`[PocketflowEngine] Calling run() on node ${node.id} (${node.type})`);
      const runResult = await currentNode.run(sharedState);
      log.debug(`[PocketflowEngine] Node ${node.id} returned action: "${runResult.action}"`);
      return {
        action: runResult.action,
        prepResult: runResult.prepResult,
        execResult: runResult.execResult,
      };
    } finally {
      delete sharedState.emit;
    }
  }
}
