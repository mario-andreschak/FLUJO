import OpenAI from 'openai';
import { 
  ToolDefinition, 
  ToolCallInfo 
} from '../types';

// Input for model call
export interface ModelCallInput {
  modelId: string;
  prompt: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  iteration: number;
  maxIterations: number;
}

// Result of model call
export interface ModelCallResult {
  content?: string;
  messages: OpenAI.ChatCompletionMessageParam[];
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
  toolCallMessages: OpenAI.ChatCompletionMessageParam[];
  processedToolCalls: ToolCallInfo[];
}
