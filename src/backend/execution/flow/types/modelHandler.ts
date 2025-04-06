import OpenAI from 'openai';
import {
  ToolDefinition,
  ToolCallInfo
} from '../types';
import { FlujoChatMessage } from '@/shared/types/chat'; // Correct import path

// Input for model call
export interface ModelCallInput {
  modelId: string;
  prompt: string;
  messages: FlujoChatMessage[]; // Use FlujoChatMessage
  tools?: OpenAI.ChatCompletionTool[];
  iteration: number;
  maxIterations: number;
  nodeName: string; // Name of the process node for display purposes
  nodeId: string; // ID of the process node
}

// Result of model call
export interface ModelCallResult {
  content?: string;
  messages: FlujoChatMessage[]; // Use FlujoChatMessage
  toolCalls?: ToolCallInfo[];
  fullResponse?: OpenAI.ChatCompletion;
}

// Tool call processing input
export interface ToolCallProcessingInput {
  toolCalls: OpenAI.ChatCompletionMessageToolCall[];
  content?: string;
}

// Tool call processing result
export interface ToolCallProcessingResult {
  toolCallMessages: FlujoChatMessage[]; // Use FlujoChatMessage
  processedToolCalls: ToolCallInfo[];
}

// Ensure the file is treated as a module
export {};
