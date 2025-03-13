import { 
  ChatCompletionMessageParam, 
  ChatCompletion,
  ChatCompletionTool,
  ChatCompletionMessageToolCall
} from 'openai/resources/chat/completions/completions';
import { 
  ToolDefinition, 
  ToolCallInfo 
} from '../types';

// Input for model call
export interface ModelCallInput {
  modelId: string;
  prompt: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  iteration: number;
  maxIterations: number;
}

// Result of model call
export interface ModelCallResult {
  content?: string;
  messages: ChatCompletionMessageParam[];
  toolCalls?: ToolCallInfo[];
  fullResponse?: ChatCompletion;
}

// Tool call processing input
export interface ToolCallProcessingInput {
  toolCalls: ChatCompletionMessageToolCall[];
  content?: string;
}

// Tool call processing result
export interface ToolCallProcessingResult {
  toolCallMessages: ChatCompletionMessageParam[];
  processedToolCalls: ToolCallInfo[];
}
