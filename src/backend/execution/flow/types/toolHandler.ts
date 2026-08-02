import { ToolDefinition, MCPNodeReference } from '../types';
import { PermissionRule } from '@/shared/types/permissions';
import OpenAI from 'openai';

// Input for tool preparation
export interface ToolPreparationInput {
  availableTools: ToolDefinition[];
}

// Result of tool preparation
export interface ToolPreparationResult {
  tools: OpenAI.ChatCompletionFunctionTool[];
}

// Input for MCP node processing
export interface MCPNodeProcessingInput {
  mcpNodes: MCPNodeReference[];
  /** Permission rules from the flow / autoApprove desugaring. When provided,
   *  tools that are wholly denied (deny + resource='*') are dropped from the
   *  advertised list before sending to the model (token savings + clean context). */
  permissionRules?: PermissionRule[];
}

// Result of MCP node processing
export interface MCPNodeProcessingResult {
  availableTools: ToolDefinition[];
}
