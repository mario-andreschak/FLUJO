// Tool handling functionality for ProcessNode
import { createLogger } from '@/utils/logger';
import { MCPNodeUtility } from '../util/MCPNodeUtility';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/handlers/ProcessNodeToolHandler');

export class ProcessNodeToolHandler {
  /**
   * Prepare tools for OpenAI function calling
   */
  static prepareTools(prepResult: any): any[] {
    // Add verbose logging of the input
    log.verbose('prepareTools input', JSON.stringify(prepResult));
    
    // Check if we have available tools
    if (!prepResult.availableTools || !Array.isArray(prepResult.availableTools) || prepResult.availableTools.length === 0) {
      log.debug('No available tools found in prepResult', {
        hasAvailableTools: !!prepResult.availableTools,
        isArray: Array.isArray(prepResult.availableTools),
        toolsCount: prepResult.availableTools?.length || 0
      });
      
      // Add verbose logging of the empty result
      log.verbose('prepareTools empty result', JSON.stringify([]));
      
      return [];
    }
    
    const availableTools = prepResult.availableTools;
    log.info(`Preparing ${availableTools.length} tools for model`);
    log.info(` ${availableTools.map((tool: any) => tool.name).join(', ')}`);
    
    // Log more detailed information about the tools
    log.debug('Available tools details:', JSON.stringify(availableTools, null, 2));
    
    // Log information about tools in mcpContext if available
    if (prepResult.mcpContext && prepResult.mcpContext.availableTools) {
      log.debug('Tools in mcpContext:', {
        count: prepResult.mcpContext.availableTools.length,
        names: prepResult.mcpContext.availableTools.map((tool: any) => ({
          original: tool.originalName,
          formatted: tool.name
        }))
      });
    }
    // Validate that all tools have the required properties before mapping
    for (const tool of availableTools) {
      if (!tool.name) {
        const errorMsg = `Tool missing required 'name' property: ${JSON.stringify(tool)}`;
        log.error(errorMsg);
        
        // Create an error object with additional properties to signal this is a critical error
        const error = new Error(errorMsg);
        (error as any).isCriticalToolError = true;
        throw error;
      }
      
      if (!tool.inputSchema) {
        const errorMsg = `Tool '${tool.name}' missing required 'inputSchema' property`;
        log.error(errorMsg);
        
        // Create an error object with additional properties to signal this is a critical error
        const error = new Error(errorMsg);
        (error as any).isCriticalToolError = true;
        throw error;
      }
    }
    
    // Map tools to OpenAI function calling format
    const mapped_tools = availableTools.map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || `Tool: ${tool.name}`,
        parameters: tool.inputSchema,
        strict: true
      }
    }));
    
    log.debug(`mapped tools: ${JSON.stringify(mapped_tools)}`);
    
    // Convert MCP tools to OpenAI function calling format
    // Add verbose logging of the mapped tools
    log.verbose('prepareTools mapped tools', JSON.stringify(mapped_tools));
    
    return mapped_tools;
  }

  /**
   * Process MCP nodes and collect available tools
   */
  static async processMCPNodes(mcpNodes: any[], sharedState: any): Promise<void> {
    // Add verbose logging of the input
    log.verbose('processMCPNodes input', JSON.stringify({
      mcpNodes,
      sharedState: {
        // Only log relevant parts of sharedState to avoid excessive logging
        mcpContext: sharedState.mcpContext,
        availableTools: sharedState.availableTools
      }
    }));
    
    if (!mcpNodes || mcpNodes.length === 0) {
      log.debug('No MCP nodes to process');
      
      // Add verbose logging of the empty result
      log.verbose('processMCPNodes empty result', JSON.stringify(null));
      
      return;
    }

    log.info(`Found ${mcpNodes.length} associated MCP nodes`);
    
    // Array to collect all available tools
    const allAvailableTools: any[] = [];
    
    // Process each MCP node
    for (const mcpNode of mcpNodes) {
      const mcpNodeProperties = mcpNode.properties;
      
      if (mcpNodeProperties) {
        // Extract MCP configuration
        const boundServer = mcpNodeProperties.boundServer;
        const enabledTools = mcpNodeProperties.enabledTools || [];
        const env = mcpNodeProperties.env || {};
        
        log.info(`Processing MCP node ${mcpNode.id}`, {
          boundServer,
          enabledToolsCount: enabledTools.length
        });
        
        if (boundServer) {
          try {
            // Create a temporary shared state for this MCP node
            const tempSharedState = { 
              mcpServer: boundServer,
              enabledTools: enabledTools,
              mcpEnv: env
            };
            
            // Use MCPNodeUtility to connect to server and get tools
            const mcpResult = await MCPNodeUtility.executeNode(tempSharedState);
            
            // Filter available tools based on enabled tools
            const availableTools = mcpResult.tools
              .filter((tool: any) => mcpResult.enabledTools.includes(tool.name))
              .map((tool: any) => {
                // Create a copy of the tool with the modified name format
                return {
                  ...tool,
                  // Store original name for reference
                  originalName: tool.name,
                  // Format: tool:server_name:tool_name
                  name: `-_-_-${boundServer}-_-_-${tool.name}`
                };
              });
            
            log.debug(`MCP node ${mcpNode.id} - Filtering tools:`, {
              totalToolsFromServer: mcpResult.tools.length,
              enabledToolsInConfig: enabledTools.length,
              filteredToolsCount: availableTools.length,
              enabledToolNames: enabledTools,
              availableToolNames: availableTools.map((t: any) => ({
                original: t.originalName,
                formatted: t.name
              }))
            });
            
            // Add to our collection of all tools, ensuring no duplicates by name
            for (const tool of availableTools) {
              // Check if this tool is already in allAvailableTools
              const existingToolIndex = allAvailableTools.findIndex(t => t.name === tool.name);
              if (existingToolIndex === -1) {
                // Tool doesn't exist yet, add it
                allAvailableTools.push(tool);
                log.debug(`Added new tool: ${tool.name} (original: ${tool.originalName})`);
              } else {
                log.debug(`Skipped duplicate tool: ${tool.name} (original: ${tool.originalName})`);
              }
            }
            
            log.info(`Added unique tools from MCP ${mcpNodeProperties.boundServer} node ${mcpNode.id}, total unique tools now: ${allAvailableTools.length}`);
          } catch (error) {
            log.warn(`Failed to connect to MCP server for node ${mcpNode.id}:`, error);
            // Continue with other MCP nodes even if one fails
          }
        }
      }
    }
    
    // Store all collected tools in shared state
    if (allAvailableTools.length > 0) {
      sharedState.availableTools = allAvailableTools;
      
      // Also store in mcpContext for consistency
      sharedState.mcpContext = {
        availableTools: allAvailableTools
      };
      
      log.info(`Stored ${allAvailableTools.length} total tools from all MCP nodes`);
      
      // Add verbose logging of the final result
      log.verbose('processMCPNodes final result', JSON.stringify({
        availableTools: allAvailableTools
      }));
      log.debug('Tools storage details:', {
        sharedStateToolsCount: sharedState.availableTools.length,
        mcpContextToolsCount: sharedState.mcpContext.availableTools.length,
        toolNames: allAvailableTools.map((tool: any) => ({
          original: tool.originalName,
          formatted: tool.name
        }))
      });
    }
  }

  /**
   * Add tool call tracking information
   */
  static addToolCallTracking(toolCalls: any[], nodeExecutionTracker: any[]): void {
    // Add verbose logging of the input
    log.verbose('addToolCallTracking input', JSON.stringify({
      toolCalls,
      nodeExecutionTrackerLength: nodeExecutionTracker?.length || 0
    }));
    
    if (!Array.isArray(toolCalls) || !Array.isArray(nodeExecutionTracker)) {
      return;
    }

    for (const toolCall of toolCalls) {
      try {
        const { function: { name, arguments: argsString } } = toolCall;
        const args = JSON.parse(argsString);
        
        // Add to tracking information
        nodeExecutionTracker.push({
          nodeType: 'ToolCall',
          toolName: name,
          toolArgs: args,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        log.error('Error processing tool call for tracking:', error);
      }
    }
  }
}
