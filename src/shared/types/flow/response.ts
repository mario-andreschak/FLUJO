import OpenAI from 'openai';
import { Flow } from './flow';

/**
 * Base response interface for flow service operations
 */
export interface FlowServiceResponse {
  success: boolean;
  error?: string;
}

/**
 * Response interface for operations that return a flow
 */
export interface FlowOperationResponse extends FlowServiceResponse {
  flow?: Flow;
}

/**
 * Response interface for operations that return a list of flows
 */
export interface FlowListResponse extends FlowServiceResponse {
  flows?: Flow[];
}

// /**
//  * OpenAI-compatible message format
//  */
// export interface ChatCompletionMessage {
//   role: string;
//   content: string;
//   name?: string;
//   tool_calls?: ToolCall[];
// }

// /**
//  * Tool call structure for OpenAI messages
//  */
// export interface ToolCall {
//   id: string;
//   function: {
//     name: string;
//     arguments: string;
//   };
// }

/**
 * Model response information
 */
export interface ModelResponse {
  success: boolean;
  content?: string;
  error?: string;
  errorDetails?: Record<string, unknown>;
  fullResponse?: OpenAI.ChatCompletionStoreMessage;
}

/**
 * Error result with success flag
 */
export interface ErrorResult {
  success: false;
  error: string;
  errorDetails?: Record<string, unknown>;
}

/**
 * Success result with success flag
 */
export interface SuccessResult {
  success: true;
  [key: string]: unknown;
}

/**
 * Message result
 */
export interface MessageResult {
  message: string;
  [key: string]: unknown;
}

/**
 * Node execution tracker entry
 */
export interface NodeExecutionTrackerEntry {
  nodeType: string;
  timestamp: string;
  // Properties for different node types
  error?: string;
  errorDetails?: Record<string, unknown>;
  content?: string;
  toolCallsCount?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  result?: string;
  nodeId?: string;
  nodeName?: string;
  modelDisplayName?: string;
  modelTechnicalName?: string;
  allowedTools?: string;
}

/**
 * Response interface for flow execution operations
 */
export interface FlowExecutionResponse extends FlowServiceResponse {
  result?: string | ErrorResult | SuccessResult | MessageResult;
  messages: OpenAI.ChatCompletionMessage[];
  executionTime: number;
  nodeExecutionTracker: NodeExecutionTrackerEntry[];
  // Additional properties used in chatCompletionService
  retryAttempts?: number;
  modelResponse?: ModelResponse;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    id: string;
    result: string;
  }>;
}
