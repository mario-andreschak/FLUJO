import { ToolDefinition, MCPNodeReference } from '../types';
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
  /** Current owner capability for protected discovery and root-update suppression. */
  executionExtensionContext?: import('@/backend/execution/extensions').ExecutionExtensionContext;
}

// Result of MCP node processing
export interface MCPNodeProcessingResult {
  availableTools: ToolDefinition[];
}
