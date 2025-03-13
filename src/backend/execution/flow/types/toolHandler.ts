import { ToolDefinition, MCPNodeReference } from '../types';
import { ChatCompletionTool } from 'openai/resources/chat/completions/completions';

// Input for tool preparation
export interface ToolPreparationInput {
  availableTools: ToolDefinition[];
}

// Result of tool preparation
export interface ToolPreparationResult {
  tools: ChatCompletionTool[];
}

// Input for MCP node processing
export interface MCPNodeProcessingInput {
  mcpNodes: MCPNodeReference[];
}

// Result of MCP node processing
export interface MCPNodeProcessingResult {
  availableTools: ToolDefinition[];
}
