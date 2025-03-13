import { ToolDefinition, MCPNodeReference } from '../types';
import OpenAI from 'openai';

// Input for tool preparation
export interface ToolPreparationInput {
  availableTools: ToolDefinition[];
}

// Result of tool preparation
export interface ToolPreparationResult {
  tools: OpenAI.ChatCompletionTool[];
}

// Input for MCP node processing
export interface MCPNodeProcessingInput {
  mcpNodes: MCPNodeReference[];
}

// Result of MCP node processing
export interface MCPNodeProcessingResult {
  availableTools: ToolDefinition[];
}
