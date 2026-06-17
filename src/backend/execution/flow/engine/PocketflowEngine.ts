import { Flow as PocketFlow, BaseNode } from '../temp_pocket';
import { flowService } from '@/backend/services/flow';
import { FlowConverter } from '../FlowConverter';
import { createLogger } from '@/utils/logger';
import { SharedState } from '../types';
import { EmitFn } from '@/shared/types/execution/events';
import { FlowEngine, ResolvedNode, RunNodeResult, HandoffResolution } from './FlowEngine';

const log = createLogger('backend/execution/flow/engine/PocketflowEngine');

/**
 * FlowEngine backed by the embedded PocketFlow framework (temp_pocket.ts).
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

  private async loadAndConvertFlow(flowId: string): Promise<PocketFlow> {
    if (this.pocketFlowCache.has(flowId)) {
      log.debug(`Using cached Pocket Flow for flowId: ${flowId}`);
      // Return a clone to prevent modification of the cached instance
      return this.pocketFlowCache.get(flowId)!.clone() as PocketFlow;
    }

    log.verbose(`Loading and converting flow for flowId: ${flowId}`);
    const reactFlow = await flowService.getFlow(flowId);
    if (!reactFlow) {
      log.error(`Flow not found for flowId: ${flowId}`);
      throw new Error(`Flow not found: ${flowId}`);
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
    const { conversationId, flowId, currentNodeId } = sharedState;
    const pocketFlow = await this.loadAndConvertFlow(flowId);

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
    const { flowId, currentNodeId } = sharedState;
    if (!currentNodeId || !action) {
      return { isSuccessorEdge: false, targetNodeId: null };
    }

    const pocketFlow = await this.loadAndConvertFlow(flowId);
    const currentNode = await this.findNodeById(pocketFlow, currentNodeId);

    if (!currentNode || !currentNode.successors.has(action)) {
      return { isSuccessorEdge: false, targetNodeId: null };
    }

    const nextNode = currentNode.getSuccessor(action);
    const nextNodeId = nextNode?.node_params?.id;
    return {
      isSuccessorEdge: true,
      targetNodeId: typeof nextNodeId === 'string' && nextNodeId.length > 0 ? nextNodeId : null,
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
