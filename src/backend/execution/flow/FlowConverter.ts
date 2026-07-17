// Local implementation of PocketFlow for debugging
import { Flow, BaseNode } from './pocketflow';
import { Flow as ReactFlow, FlowNode } from '@/frontend/types/flow/flow';
import { StartNode, ProcessNode, MCPNode, FinishNode, SubflowNode, ResourceNode, SignalNode } from './nodes';
import { createLogger } from '@/utils/logger';
import {
  NodeParams,
  StartNodeParams,
  ProcessNodeParams,
  MCPNodeParams,
  FinishNodeParams,
  MCPNodeReference,
  StartNodeProperties,
  ProcessNodeProperties,
  MCPNodeProperties,
  FinishNodeProperties,
  SubflowNodeProperties,
  ResourceNodeProperties,
  SignalNodeProperties
} from './types';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/FlowConverter');

export class FlowConverter {
  /**
   * Convert a React Flow to a Pocket Flow
   */
  static convert(reactFlow: ReactFlow): Flow {
    log.info('Converting React Flow to Pocket Flow', {
      flowName: reactFlow.name,
      nodeCount: reactFlow.nodes.length,
      edgeCount: reactFlow.edges.length
    });
    
    // Add verbose logging of the input
    log.verbose('convert input', JSON.stringify({
      flowName: reactFlow.name,
      nodeCount: reactFlow.nodes.length,
      edgeCount: reactFlow.edges.length
    }));
    
    // Create a map to store nodes by ID
    const nodesMap = new Map<string, BaseNode>();
    
    // First pass: Create all nodes
    for (const node of reactFlow.nodes) {
      log.debug(`Creating node: ${node.id} (${node.type})`);
      const pocketNode = this.createNode(node);
      nodesMap.set(node.id, pocketNode);
    }
    
    // Second pass: Connect nodes based on edges
    for (const edge of reactFlow.edges) {
      log.debug(`Connecting edge: ${edge.id} (${edge.source} -> ${edge.target})`);
      const sourceNode = nodesMap.get(edge.source);
      const targetNode = nodesMap.get(edge.target);

      if (sourceNode && targetNode) {
        // Check if it's an MCP connection
        if (edge.data?.edgeType === 'mcp') {
          log.info(`Handling MCP connection: ${edge.id} (${edge.source} -> ${edge.target})`);

          // Find the Process and MCP nodes
          let processNode: BaseNode | undefined;
          let mcpNode: BaseNode | undefined;

          if (sourceNode instanceof ProcessNode) {
            processNode = sourceNode;
            mcpNode = targetNode;
          } else if (targetNode instanceof ProcessNode) {
            processNode = targetNode;
            mcpNode = sourceNode;
          }

          if (processNode && mcpNode) {
            // Initialize the MCP nodes array if it doesn't exist
            if (!processNode.node_params.properties) {
              processNode.node_params.properties = {};
            }
            if (!processNode.node_params.properties.mcpNodes) {
              processNode.node_params.properties.mcpNodes = [];
            }
            
            // Store the full MCP node properties
            processNode.node_params.properties.mcpNodes.push({
              id: mcpNode.node_params.id,
              properties: mcpNode.node_params.properties
            });
            
            log.info(`Stored MCP node in Process node properties`, {
              processNodeId: processNode.node_params.id,
              mcpNodeId: mcpNode.node_params.id
            });
          } else {
            log.warn(`Invalid MCP connection: ${edge.id}. Could not find Process and MCP nodes.`, {
                sourceNodeType: sourceNode.constructor.name,
                targetNodeType: targetNode.constructor.name
            });
          }
        } else if (edge.data?.edgeType === 'resource') {
          // Tier 3: a resource edge is DATA wiring, never a successor.
          // Direction encodes role: resource→process = the step CONSUMES the
          // artifact; process→resource = the step PRODUCES it. Fold the
          // resource node onto the process node's params like mcpNodes; a
          // produce edge onto a run artifact additionally derives
          // captureResource (unless the step set one explicitly).
          log.info(`Handling resource connection: ${edge.id} (${edge.source} -> ${edge.target})`);

          let processNode: BaseNode | undefined;
          let resourceNode: BaseNode | undefined;
          let role: 'consume' | 'produce' | undefined;

          if (sourceNode instanceof ResourceNode && targetNode instanceof ProcessNode) {
            resourceNode = sourceNode;
            processNode = targetNode;
            role = 'consume';
          } else if (sourceNode instanceof ProcessNode && targetNode instanceof ResourceNode) {
            processNode = sourceNode;
            resourceNode = targetNode;
            role = 'produce';
          }

          if (processNode && resourceNode && role) {
            if (!processNode.node_params.properties) {
              processNode.node_params.properties = {};
            }
            if (!processNode.node_params.properties.resourceNodes) {
              processNode.node_params.properties.resourceNodes = [];
            }
            const resourceProps = (resourceNode.node_params.properties ?? {}) as ResourceNodeProperties;
            processNode.node_params.properties.resourceNodes.push({
              id: resourceNode.node_params.id,
              role,
              properties: resourceProps,
            });

            // Produce edge onto a run artifact ⇒ the step's output is captured
            // under the artifact's name. An explicit captureResource wins.
            if (role === 'produce' && resourceProps.scope === 'run' && resourceProps.runName
                && !processNode.node_params.properties.captureResource) {
              processNode.node_params.properties.captureResource = resourceProps.runName;
              log.info(`Derived captureResource from produce edge`, {
                processNodeId: processNode.node_params.id,
                runName: resourceProps.runName,
              });
            }

            log.info(`Stored resource node in Process node properties`, {
              processNodeId: processNode.node_params.id,
              resourceNodeId: resourceNode.node_params.id,
              role,
            });
          } else {
            log.warn(`Invalid resource connection: ${edge.id}. Could not find Process and Resource nodes.`, {
              sourceNodeType: sourceNode.constructor.name,
              targetNodeType: targetNode.constructor.name
            });
          }
        } else {
          // Use edge ID as the action name
          // This is critical for the node to find its successor
          const action = edge.id || 'default';

          // Add the successor with the action
          sourceNode.addSuccessor(targetNode, action);

          // Tier 2b: retain a deterministic edge condition (dropped everywhere
          // else) into the SOURCE node's params, keyed by this edge's action —
          // the same string ProcessNode.post returns to route. `orderedOutgoingEdges`
          // records author order so "first matching edge wins" / "bare fallback"
          // are well-defined. Kept in node_params (deep-cloned with the node), which
          // post() already has in scope, so no orchestration change is needed.
          sourceNode.node_params.orderedOutgoingEdges = sourceNode.node_params.orderedOutgoingEdges || [];
          sourceNode.node_params.orderedOutgoingEdges.push(action);
          const condition = (edge.data as { condition?: unknown } | undefined)?.condition;
          if (condition && typeof condition === 'object') {
            sourceNode.node_params.edgeConditions = sourceNode.node_params.edgeConditions || {};
            sourceNode.node_params.edgeConditions[action] = condition;
            log.info(`Retained edge condition for routing`, { edgeId: action, source: edge.source });
          }

          // A bidirectional edge is one connector carrying both transitions:
          // register the reverse successor under a derived action so the
          // target can hand back to the source.
          if ((edge.data as { bidirectional?: boolean } | undefined)?.bidirectional) {
            const reverseAction = `${action}__reverse`;
            targetNode.addSuccessor(sourceNode, reverseAction);
            // The reverse back-edge is a bare successor the TARGET owns — record it
            // in author order so a conditioned target can use it as a fallback.
            targetNode.node_params.orderedOutgoingEdges = targetNode.node_params.orderedOutgoingEdges || [];
            targetNode.node_params.orderedOutgoingEdges.push(reverseAction);
            log.info(`Connected nodes (bidirectional): ${edge.target} -> ${edge.source} with action: ${reverseAction}`);
          }

          // Log the connection for debugging
          log.info(`Connected nodes: ${edge.source} -> ${edge.target} with action: ${action}`);

          // Log the successors map for debugging
          if (sourceNode.successors instanceof Map) {
            log.debug(`Source node successors after connection:`, {
              sourceNodeId: edge.source,
              successorsCount: sourceNode.successors.size,
              successorsKeys: Array.from(sourceNode.successors.keys()),
              hasTargetNode: sourceNode.successors.has(action)
            });
          } else {
            log.warn(`Source node successors is not a Map:`, {
              sourceNodeId: edge.source,
              successorsType: typeof sourceNode.successors
            });
          }
        }
      } else {
        log.warn(`Failed to connect edge: ${edge.id}`, {
          sourceExists: !!sourceNode,
          targetExists: !!targetNode
        });
      }
    }
    
    // Find the start node (should be only one)
    const startNode = reactFlow.nodes.find(node => node.type === 'start');
    if (!startNode) {
      log.error('No start node found in flow');
      throw new Error("Flow must have a start node");
    }
    log.debug(`Found start node: ${startNode.id}`);
    
    // Create the flow with the start node
    const pocketStartNode = nodesMap.get(startNode.id);
    if (!pocketStartNode) {
      log.error(`Failed to retrieve start node from map: ${startNode.id}`);
      throw new Error("Failed to create start node");
    }
    
    const flow = new Flow(pocketStartNode);
    log.debug('Created Pocket Flow with start node');

    log.info('Flow conversion completed successfully', {
      nodeCount: nodesMap.size
    });
    
    // Add verbose logging of the result
    log.verbose('convert result', JSON.stringify({
      flowStartNodeId: flow.node_params?.id || 'unknown',
      nodesCount: nodesMap.size
    }));

    return flow;
  }

  /**
   * Create a Pocket Flow node from a React Flow node
   */
  private static createNode(node: FlowNode): BaseNode {
    log.debug(`Creating node of type: ${node.type}`, {
      nodeId: node.id,
      label: node.data.label
    });
    
    // Add verbose logging of the input
    log.verbose('createNode input', JSON.stringify({
      nodeId: node.id,
      nodeType: node.type,
      label: node.data.label,
      properties: node.data.properties
    }));
    
    let pocketNode: BaseNode;
    let nodeParams: NodeParams;
    
    // Create the appropriate node type with properly typed parameters
    switch (node.type) {
      case 'start':
        pocketNode = new StartNode();
        nodeParams = {
          id: node.id,
          label: node.data.label,
          type: 'start',
          properties: node.data.properties as StartNodeProperties || { name: node.data.label }
        };
        break;
      case 'process':
        pocketNode = new ProcessNode();
        nodeParams = {
          id: node.id,
          label: node.data.label,
          type: 'process',
          properties: node.data.properties as ProcessNodeProperties || { name: node.data.label }
        };
        break;
      case 'mcp':
        pocketNode = new MCPNode();
        nodeParams = {
          id: node.id,
          label: node.data.label,
          type: 'mcp',
          properties: node.data.properties as MCPNodeProperties || { name: node.data.label }
        };
        break;
      case 'finish':
        pocketNode = new FinishNode();
        nodeParams = {
          id: node.id,
          label: node.data.label,
          type: 'finish',
          properties: node.data.properties as FinishNodeProperties || { name: node.data.label }
        };
        break;
      case 'subflow':
        pocketNode = new SubflowNode();
        nodeParams = {
          id: node.id,
          label: node.data.label,
          type: 'subflow',
          properties: node.data.properties as SubflowNodeProperties || { name: node.data.label }
        };
        break;
      case 'resource':
        pocketNode = new ResourceNode();
        nodeParams = {
          id: node.id,
          label: node.data.label,
          type: 'resource',
          properties: node.data.properties as ResourceNodeProperties || { name: node.data.label }
        };
        break;
      case 'signal':
        // Signal node (issue #117): a pass-through control node that emits a
        // {topic, payload} event onto the flow-run bus when traversed. Like any
        // control node it gets bare successor edges (never an attachment edge),
        // so no special edge handling is needed — only instantiation here.
        pocketNode = new SignalNode();
        nodeParams = {
          id: node.id,
          label: node.data.label,
          type: 'signal',
          properties: node.data.properties as SignalNodeProperties || { name: node.data.label }
        };
        break;
      default:
        log.error(`Unknown node type: ${node.type}`, { nodeId: node.id });
        throw new Error(`Unknown node type: ${node.type}`);
    }

    // Set node parameters with proper typing
    const flow_params = {}; // general flow params (currently unused)
    pocketNode.setParams(flow_params, nodeParams);
    
    log.debug(`Node created and parameters set`, {
      nodeId: node.id,
      type: node.type,
      propertiesKeys: Object.keys(nodeParams.properties || {})
    });
    
    // Add verbose logging of the result
    log.verbose('createNode result', JSON.stringify({
      nodeId: node.id,
      nodeType: node.type,
      nodeParams: nodeParams
    }));

    return pocketNode;
  }
}
