// Local implementation of PocketFlow for debugging
import { Flow, BaseNode } from './temp_pocket';
import { Flow as ReactFlow, FlowNode } from '@/frontend/types/flow/flow';
import { StartNode, ProcessNode, MCPNode, FinishNode } from './nodes';
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
  FinishNodeProperties
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
        } else {
          // Use edge ID as the action name
          // This is critical for the node to find its successor
          const action = edge.id || 'default';

          // Add the successor with the action
          sourceNode.addSuccessor(targetNode, action);

          // Log the connection for debugging
          log.info(`Connected nodes: ${edge.source} -> ${edge.target} with action: ${action}`);

          // Log the successors map for debugging
          if (sourceNode.successors instanceof Map) {
            log.info(`Source node successors after connection:`, {
              sourceNodeId: edge.source,
              successorsCount: sourceNode.successors.size,
              successorsKeys: Array.from(sourceNode.successors.keys()),
              hasTargetNode: sourceNode.successors.has(action)
            });
          } else {
            log.info(`Source node successors is not a Map:`, {
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
