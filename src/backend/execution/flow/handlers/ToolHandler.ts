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
import { encodeToolName, hashSchema } from './toolNamespace';
import { buildMCPResourceTools } from './mcpResourceTools';
import { extractUiResourceUri } from '@/shared/utils/mcpApps';
import OpenAI from 'openai';
import { hidePresetParameters, mergeToolParameterPresets } from '@/utils/shared/toolParameterPresets';
import type { MCPServerConfig } from '@/shared/types/mcp';

const log = createLogger('backend/flow/execution/handlers/ToolHandler');

export interface SanitizedToolSchema extends OpenAI.FunctionParameters {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, SanitizedToolSchema>;
  required?: string[];
  items?: SanitizedToolSchema;
  oneOf?: SanitizedToolSchema[];
  anyOf?: SanitizedToolSchema[];
  allOf?: SanitizedToolSchema[];
}

export class ToolHandler {
  /**
   * Sanitizes a JSON Schema to ensure compatibility with all LLM providers
   * Specifically removes unsupported 'format' fields from string properties
   * and filters 'required' arrays to only reference keys defined in 'properties'
   * (Google AI Studio / Gemini via OpenRouter rejects schemas where required
   * contains keys not present in properties).
   */
  static sanitizeSchema(schema: unknown): SanitizedToolSchema {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
    
    // Make a deep copy to avoid modifying the original
    const result = JSON.parse(JSON.stringify(schema)) as SanitizedToolSchema;
    
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
      const properties = result.properties;
      Object.keys(properties).forEach(key => {
        properties[key] = ToolHandler.sanitizeSchema(properties[key]);
      });
    }

    // Google AI Studio (and other strict providers) reject schemas where `required`
    // references property names not defined in `properties`. Filter required so it
    // only contains keys that are actually declared. Remove `required` entirely when
    // it would become empty or when there are no `properties` at all.
    if (Array.isArray(result.required)) {
      if (result.properties) {
        const definedKeys = new Set(Object.keys(result.properties));
        result.required = (result.required as unknown[]).filter(
          (k): k is string => typeof k === 'string' && definedKeys.has(k)
        );
        if (result.required.length === 0) {
          delete result.required;
        }
      } else {
        // No properties declared → `required` can only be invalid; drop it.
        delete result.required;
      }
    }
    
    // Process array items
    if (result.items) {
      result.items = ToolHandler.sanitizeSchema(result.items);
    }
    
    // Process oneOf, anyOf, allOf
    if (Array.isArray(result.oneOf)) result.oneOf = result.oneOf.map((item) => ToolHandler.sanitizeSchema(item));
    if (Array.isArray(result.anyOf)) result.anyOf = result.anyOf.map((item) => ToolHandler.sanitizeSchema(item));
    if (Array.isArray(result.allOf)) result.allOf = result.allOf.map((item) => ToolHandler.sanitizeSchema(item));
    
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
      
      // Deterministic tool ordering (#89). The serialized tool block is a large,
      // fixed prefix re-sent on every stateless Chat Completions turn. Providers
      // auto-cache long identical prefixes and bill the re-read at a discount,
      // but that prefix cache only keeps hitting if the bytes are byte-identical
      // turn-to-turn. Tool order otherwise derives from MCP-node iteration order
      // plus each server's tool-listing order, which is NOT guaranteed stable
      // across reconnects / re-listing. Sort by the (namespaced, unique) tool
      // name with a locale-independent comparison so the serialized block is
      // identical every turn and keeps landing on the provider's prefix cache.
      // Purely a byte-stability change: the model receives the same tools, and
      // tool names are already unique (deduped in processMCPNodes).
      const orderedTools = [...availableTools].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );

      // Map tools to OpenAI format with sanitized schemas
      const tools: OpenAI.ChatCompletionFunctionTool[] = orderedTools.map(tool => ({
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
      let serverConfigs: MCPServerConfig[] = [];
      try {
        const loadedConfigs = await mcpService.loadServerConfigs?.();
        serverConfigs = Array.isArray(loadedConfigs) ? loadedConfigs : [];
      } catch (error) {
        // Listing/using tools remains available if config storage has a
        // transient read failure; only server-wide presets are unavailable.
        log.warn('Could not load server-wide tool parameter presets', error);
      }
      
      // Process each MCP node
      for (const mcpNode of mcpNodes) {
        const properties = mcpNode.properties;
        
        if (properties && properties.boundServer) {
          const boundServer = properties.boundServer;
          const enabledTools = properties.enabledTools || [];
          const toolTimeout = properties.toolTimeout;
          const serverConfig = serverConfigs.find((config) => config.name === boundServer);

          // Node-level roots (issue 46): register this node's workspace-folder overlay
          // BEFORE connecting, so roots/list answers with the union of server-level and
          // node-level roots from the first request on. Roots never rebuild the client
          // (the capability is always declared); an already-connected server is told via
          // notifications/roots/list_changed. An empty list clears this node's overlay.
          mcpService.setNodeRoots(boundServer, mcpNode.id, properties.roots);

          // Ensure the server is connected. connectServer recreates a client whose config
          // changed; listServerTools below additionally self-heals a dead transport by
          // reconnecting and retrying. We deliberately do NOT gate this on getServerStatus:
          // that only reports map presence, not liveness, so it cannot detect a stale session.
          const connectResult = await mcpService.connectServer(boundServer);

          if (!connectResult.success) {
            // A node is explicitly wired to this MCP server, so its tools are not optional.
            // Failing loudly here is critical: otherwise the ProcessNode would proceed with
            // only its handoff tool and the model would (truthfully) report it has no tools -
            // the exact "tools randomly missing" symptom this guards against.
            return {
              success: false,
              error: createMCPError(
                'server_connection_failed',
                `Failed to connect to MCP server '${boundServer}': ${connectResult.error}`,
                boundServer,
                'connect'
              )
            };
          }

          // List server tools
          const toolsResult = await mcpService.listServerTools(boundServer);

          // Distinguish a genuine failure from a legitimately empty tool list. An error means
          // we could not retrieve the tools (even after the reconnect/retry inside
          // listServerTools) - propagate it rather than silently dropping the node's tools.
          if (toolsResult.error) {
            return {
              success: false,
              error: createMCPError(
                'list_tools_failed',
                `Failed to list tools for MCP server '${boundServer}': ${toolsResult.error}`,
                boundServer,
                'listTools'
              )
            };
          }

          // An empty list with no error is valid (server exposes none / none are enabled).
          // Filter and format tools
          const serverTools = (toolsResult.tools || [])
            .filter(tool => enabledTools.includes(tool.name))
            .map(tool => {
              const presetArgs = mergeToolParameterPresets(
                serverConfig?.toolParameterPresets,
                properties.toolParameterPresets,
                tool.name,
              );
              // Issue #255: capture the tool's identity at advertise time so a
              // later dispatch can detect that the server reconnected or the
              // schema changed. Record the current schema hash as the advertised
              // one so the dispatch-time comparison has a baseline.
              const schemaHash = hashSchema(tool.inputSchema);
              mcpService.setToolSchemaHash(boundServer, tool.name, schemaHash);
              return {
                originalName: tool.name,
                server: boundServer,
                nodeId: mcpNode.id,
                name: encodeToolName(boundServer, tool.name),
                timeout: toolTimeout,
                description: tool.description,
                inputSchema: hidePresetParameters(tool.inputSchema as Record<string, unknown>, presetArgs),
                ...(Object.keys(presetArgs).length > 0 ? { presetArgs } : {}),
                annotations: tool.annotations,
                clientGeneration: mcpService.getClientGeneration(boundServer),
                schemaHash,
                uiResourceUri: extractUiResourceUri(tool._meta),
              };
            });

          // Add unique tools
          for (const tool of serverTools) {
            if (!allTools.some(t => t.name === tool.name)) {
              allTools.push(tool);
            }
          }
        }
      }
      
      // Build the list_mcp_resources synthetic tool (issue #239).
      // This is additive (read-only); a listing failure logs a warning but does
      // NOT abort the step — tool availability must not be blocked by resources.
      try {
        const resourceTools = await buildMCPResourceTools(mcpNodes);
        for (const rt of resourceTools) {
          if (!allTools.some((t) => t.name === rt.name)) {
            allTools.push(rt);
          }
        }
      } catch (resourceErr) {
        log.warn('processMCPNodes: buildMCPResourceTools failed, skipping resource tool', { resourceErr });
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
