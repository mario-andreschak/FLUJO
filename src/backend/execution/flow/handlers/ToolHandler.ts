import { createLogger } from '@/utils/logger';
import { 
  ToolPreparationInput, 
  ToolPreparationResult, 
  MCPNodeProcessingInput, 
  MCPNodeProcessingResult 
} from '../types/toolHandler';
import { Result } from '../errors';
import { createToolError, createMCPError } from '../errorFactory';
import { mcpService } from '@/backend/services/mcp';
import { ToolDefinition } from '../types';
import OpenAI from 'openai';

const log = createLogger('backend/flow/execution/handlers/ToolHandler');

export class ToolHandler {
  /**
   * Sanitizes a JSON Schema to ensure compatibility with all LLM providers
   * Specifically removes unsupported 'format' fields from string properties
   */
  static sanitizeSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    
    // Make a deep copy to avoid modifying the original
    const result = JSON.parse(JSON.stringify(schema));
    
    // Handle string type with format
    if (result.type === 'string' && result.format) {
      // Only keep enum and date-time formats as they're universally supported
      if (result.format !== 'enum' && result.format !== 'date-time') {
        // Save the format info in the description
        if (!result.description) result.description = '';
        result.description += ` (format: ${result.format})`;
        
        // Remove the unsupported format
        delete result.format;
      }
    }
    
    // Process properties recursively
    if (result.properties) {
      Object.keys(result.properties).forEach(key => {
        result.properties[key] = ToolHandler.sanitizeSchema(result.properties[key]);
      });
    }
    
    // Process array items
    if (result.items) {
      result.items = ToolHandler.sanitizeSchema(result.items);
    }
    
    // Process oneOf, anyOf, allOf
    ['oneOf', 'anyOf', 'allOf'].forEach(key => {
      if (Array.isArray(result[key])) {
        result[key] = result[key].map((item: any) => ToolHandler.sanitizeSchema(item));
      }
    });
    
    return result;
  }
  /**
   * Prepare tools for model - pure function
   * 
   * Note: This method is a pure function that formats tools for the model without reconnecting to servers.
   * It only validates and transforms the tools into the format expected by the OpenAI API.
   */
  static prepareTools(input: ToolPreparationInput): Result<ToolPreparationResult> {
    const { availableTools } = input;
    
    // Add verbose logging of the input
    log.verbose('prepareTools input', JSON.stringify(input));
    
    if (!availableTools || availableTools.length === 0) {
      const emptyResult: Result<ToolPreparationResult> = {
        success: true,
        value: { tools: [] }
      };
      
      // Add verbose logging of the empty result
      log.verbose('prepareTools empty result', JSON.stringify(emptyResult));
      
      return emptyResult;
    }
    
    try {
      // Validate tools
      for (const tool of availableTools) {
        if (!tool.name) {
          return {
            success: false,
            error: createToolError(
              'invalid_tool',
              `Tool missing required 'name' property`,
              'unknown'
            )
          };
        }
        
        if (!tool.inputSchema) {
          return {
            success: false,
            error: createToolError(
              'invalid_tool',
              `Tool '${tool.name}' missing required 'inputSchema' property`,
              tool.name
            )
          };
        }
      }
      
      // Map tools to OpenAI format with sanitized schemas
      const tools: OpenAI.ChatCompletionTool[] = availableTools.map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          parameters: ToolHandler.sanitizeSchema(tool.inputSchema)
        }
      }));
      
      const result: Result<ToolPreparationResult> = {
        success: true,
        value: { tools }
      };
      
      // Add verbose logging of the successful result
      log.verbose('prepareTools success result', JSON.stringify(result));
      
      return result;
    } catch (error) {
      const errorResult: Result<ToolPreparationResult> = {
        success: false,
        error: createToolError(
          'tool_preparation_failed',
          error instanceof Error ? error.message : String(error),
          'unknown'
        )
      };
      
      // Add verbose logging of the error result
      log.verbose('prepareTools error result', JSON.stringify(errorResult));
      
      return errorResult;
    }
  }
  
  /**
   * Process MCP nodes - pure function
   * 
   * Note: This method connects to MCP servers and fetches tools for each MCP node.
   * It should only be called when necessary, as it creates network connections.
   * If tools are already available in shared state, prefer to use those instead.
   */
  static async processMCPNodes(
    input: MCPNodeProcessingInput
  ): Promise<Result<MCPNodeProcessingResult>> {
    const { mcpNodes } = input;
    
    // Add verbose logging of the input
    log.verbose('processMCPNodes input', JSON.stringify(input));
    
    if (!mcpNodes || mcpNodes.length === 0) {
      const emptyResult: Result<MCPNodeProcessingResult> = {
        success: true,
        value: { availableTools: [] }
      };
      
      // Add verbose logging of the empty result
      log.verbose('processMCPNodes empty result', JSON.stringify(emptyResult));
      
      return emptyResult;
    }
    
    try {
      const allTools: ToolDefinition[] = [];
      
      // Process each MCP node
      for (const mcpNode of mcpNodes) {
        const properties = mcpNode.properties;
        
        if (properties && properties.boundServer) {
          const boundServer = properties.boundServer;
          const enabledTools = properties.enabledTools || [];
          
          // Get server status
          const status = await mcpService.getServerStatus(boundServer);
          
          if (status.message !== 'connected') {
            // Try to connect
            const connectResult = await mcpService.connectServer(boundServer);
            
            if (!connectResult.success) {
              log.warn(`Failed to connect to server ${boundServer}: ${connectResult.error}`);
              continue;
            }
          }
          
          // List server tools
          const toolsResult = await mcpService.listServerTools(boundServer);
          
          if (!toolsResult.tools || toolsResult.tools.length === 0) {
            continue;
          }
          
          // Filter and format tools
          const serverTools = toolsResult.tools
            .filter(tool => enabledTools.includes(tool.name))
            .map(tool => ({
              originalName: tool.name,
              name: `_-_-_${boundServer}_-_-_${tool.name}`,
              description: tool.description,
              inputSchema: tool.inputSchema
            }));
          
          // Add unique tools
          for (const tool of serverTools) {
            if (!allTools.some(t => t.name === tool.name)) {
              allTools.push(tool);
            }
          }
        }
      }
      
      const result: Result<MCPNodeProcessingResult> = {
        success: true,
        value: { availableTools: allTools }
      };
      
      // Add verbose logging of the successful result
      log.verbose('processMCPNodes success result', JSON.stringify(result));
      
      return result;
    } catch (error) {
      const errorResult: Result<MCPNodeProcessingResult> = {
        success: false,
        error: createMCPError(
          'mcp_processing_failed',
          error instanceof Error ? error.message : String(error),
          'unknown',
          'processMCPNodes'
        )
      };
      
      // Add verbose logging of the error result
      log.verbose('processMCPNodes error result', JSON.stringify(errorResult));
      
      return errorResult;
    }
  }
}
