import { createHash } from 'crypto';
import { Flow as PocketFlow, BaseNode } from '../pocketflow';
import { flowService } from '@/backend/services/flow';
import { FlowConverter } from '../FlowConverter';
import { createLogger } from '@/utils/logger';
import { ExecResult, IMPLICIT_SUBFLOW_RETURN_ACTION, PrepResult, ProcessNodePrepResult, SharedState } from '../types';
import { EmitFn } from '@/shared/types/execution/events';
import { FlowEngine, ResolvedNode, RunNodeResult, HandoffResolution } from './FlowEngine';
import { getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import cloneDeep from 'lodash/cloneDeep';
import { personaCoreAppNodeId } from '@/backend/services/enduringAgents/personaCoreAppIdentity';

const log = createLogger('backend/execution/flow/engine/PocketflowEngine');

/**
 * FlowEngine backed by the embedded PocketFlow framework (pocketflow.ts).
 * All knowledge of PocketFlow's graph/node model lives here; everything above
 * it (FlowExecutor, routes, UI) talks only to the FlowEngine interface.
 */
export class PocketflowEngine implements FlowEngine {
  // Live Flows use their id; immutable snapshots add a content digest so two
  // concurrent runs pinned to different same-id definitions never share a
  // compiled graph.
  private pocketFlowCache = new Map<string, PocketFlow>();
  private snapshotDigests = new WeakMap<object, string>();

  private snapshotDigest(snapshot: NonNullable<SharedState['flowSnapshot']>): string {
    const cached = this.snapshotDigests.get(snapshot);
    if (cached) return cached;
    const digest = createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('base64url');
    this.snapshotDigests.set(snapshot, digest);
    return digest;
  }

  private trustedPersonaAppBindings(sharedState: SharedState): Map<string, string> {
    if (
      typeof sharedState.executionAuthority?.authorizePersonaCoreMcp !== 'function'
      || !sharedState.personaAttribution
      || !sharedState.personaInstructionContext
      || !sharedState.flowSnapshot
      || !Array.isArray(sharedState.personaCoreAppRefs)
    ) return new Map();

    const bindings = new Map<string, string>();
    for (const serverName of Array.from(new Set(sharedState.personaCoreAppRefs)).sort()) {
      if (typeof serverName !== 'string' || !serverName) continue;
      bindings.set(personaCoreAppNodeId(serverName), serverName);
    }
    return bindings;
  }

  private personaAppBindingsDigest(sharedState: SharedState): string | undefined {
    const entries = [...this.trustedPersonaAppBindings(sharedState).entries()];
    if (entries.length === 0) return undefined;
    return createHash('sha256').update(JSON.stringify(entries)).digest('base64url');
  }

  private cacheKey(sharedState: SharedState): string {
    if (!sharedState.flowSnapshot) return workspaceCacheKey(sharedState.flowId);
    const parts = [
      sharedState.flowId,
      'snapshot',
      this.snapshotDigest(sharedState.flowSnapshot),
    ];
    const personaAppBindingsDigest = this.personaAppBindingsDigest(sharedState);
    if (personaAppBindingsDigest) parts.push('persona-apps', personaAppBindingsDigest);
    return workspaceCacheKey(
      ...parts,
    );
  }

  clearCache(flowId?: string): void {
    if (flowId) {
      const exact = workspaceCacheKey(flowId);
      const snapshotPrefix = `${exact}\0snapshot\0`;
      this.pocketFlowCache.delete(exact);
      for (const key of this.pocketFlowCache.keys()) {
        if (key.startsWith(snapshotPrefix)) this.pocketFlowCache.delete(key);
      }
    } else {
      const prefix = `${getCurrentWorkspace()}\0`;
      for (const key of this.pocketFlowCache.keys()) {
        if (key.startsWith(prefix)) this.pocketFlowCache.delete(key);
      }
    }
  }

  /**
   * Resolve the compiled flow for a run. Quick-Chats (issue #61) carry a
   * `flowSnapshot` on the state: when present it is converted directly,
   * bypassing the flows store; otherwise we fall back to the store lookup by
   * `flowId` (the unchanged path for every saved flow). Live Flow cache entries
   * remain id-keyed. Snapshot entries additionally include a digest of their
   * exact content, which isolates concurrent same-id immutable revisions;
   * runFlow also evicts prior/successor ids when a Persona Activity changes.
   */
  private async resolveFlowDefinition(sharedState: SharedState): Promise<PocketFlow> {
    const flowId = sharedState.flowId;
    const cacheKey = this.cacheKey(sharedState);
    if (this.pocketFlowCache.has(cacheKey)) {
      log.debug(`Using cached Pocket Flow for flowId: ${flowId}`);
      // Return a clone to prevent modification of the cached instance
      return this.pocketFlowCache.get(cacheKey)!.clone() as PocketFlow;
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

    const trustedInlineMcpBindings = this.trustedPersonaAppBindings(sharedState);
    const pocketFlow = FlowConverter.convert(reactFlow, {
      ...(trustedInlineMcpBindings.size > 0 ? { trustedInlineMcpBindings } : {}),
    });
    this.pocketFlowCache.set(cacheKey, pocketFlow);
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

    // A one-way Process -> terminal Subflow is an implicit sub-agent call. The
    // Subflow has no graph successor of its own, so resolve its internal return
    // action through the caller-aware marker captured when it was entered. This
    // is deliberately validated against the compiled graph instead of trusting
    // persisted state: the current node must still be that Subflow and the
    // caller must still be a Process node in this flow.
    if (action === IMPLICIT_SUBFLOW_RETURN_ACTION) {
      const pending = sharedState.pendingSubflowReturn;
      if (
        currentNode?.node_params?.type !== 'subflow' ||
        pending?.subflowNodeId !== currentNodeId
      ) {
        return { isSuccessorEdge: false, targetNodeId: null };
      }

      const callerNode = await this.findNodeById(pocketFlow, pending.callerNodeId);
      if (callerNode?.node_params?.type !== 'process') {
        return { isSuccessorEdge: false, targetNodeId: null };
      }

      return {
        isSuccessorEdge: true,
        targetNodeId: pending.callerNodeId,
        targetNodeType: 'process',
      };
    }

    if (!currentNode || !currentNode.successors.has(action)) {
      return { isSuccessorEdge: false, targetNodeId: null };
    }

    const nextNode = currentNode.getSuccessor(action);
    const nextNodeId = nextNode?.node_params?.id;
    const nextNodeType = nextNode?.node_params?.type;
    const implicitSubflowReturn =
      currentNode.node_params?.type === 'process' &&
      nextNodeType === 'subflow' &&
      nextNode?.successors instanceof Map &&
      nextNode.successors.size === 0 &&
      typeof nextNodeId === 'string' &&
      nextNodeId.length > 0
        ? { subflowNodeId: nextNodeId, callerNodeId: currentNodeId }
        : undefined;
    return {
      isSuccessorEdge: true,
      targetNodeId: typeof nextNodeId === 'string' && nextNodeId.length > 0 ? nextNodeId : null,
      targetNodeType: typeof nextNodeType === 'string' ? nextNodeType : null,
      ...(implicitSubflowReturn ? { implicitSubflowReturn } : {}),
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
        prepResult: runResult.prepResult as PrepResult,
        execResult: runResult.execResult as ExecResult,
      };
    } finally {
      delete sharedState.emit;
    }
  }

  async previewModelInput(sharedState: SharedState) {
    const previewState = cloneDeep(sharedState);
    if (sharedState.executionAuthority) {
      Object.defineProperty(previewState, 'executionAuthority', {
        value: sharedState.executionAuthority,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    if (Array.isArray(sharedState.personaCoreAppRefs)) {
      Object.defineProperty(previewState, 'personaCoreAppRefs', {
        value: [...sharedState.personaCoreAppRefs],
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    delete previewState.emit;
    // The preview is debugger-only even if a recovered legacy state omitted the
    // flag. ProcessNode.prep gates its model-input derivation on debugMode.
    previewState.debugMode = true;

    const resolved = await this.resolveNode(previewState);
    if (resolved.type !== 'process') return null;

    const node = resolved.handle as BaseNode;
    const prepResult = await node.prep(previewState, node.node_params) as ProcessNodePrepResult;
    return prepResult.modelInput
      ? { nodeId: resolved.id, modelInput: prepResult.modelInput }
      : null;
  }
}
