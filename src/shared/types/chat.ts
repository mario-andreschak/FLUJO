/**
 * Defines the structure for the metadata object sent with chat completion requests,
 * particularly when using Flujo features.
 */
export interface ChatCompletionMetadata {
  /**
   * Indicates if the request is part of a Flujo execution.
   * Expected value: "true"
   */
  flujo?: "true";

  /**
   * The ID of the conversation this request belongs to, allowing state resumption.
   */
  conversationId?: string;

  /**
   * Indicates if tool calls within a Flujo execution require user approval before proceeding.
   * Expected value: "true"
   */
  requireApproval?: "true";

  /**
   * Indicates if the request should be executed in debug mode (step-by-step).
   * Expected value: "true"
   */
  flujodebug?: "true";

  // Add other potential metadata fields here if needed in the future
}

import OpenAI from 'openai';

/**
 * Extends OpenAI's chat completion message parameter type to include additional fields
 * needed for Flujo's chat functionality.
 */
export type FlujoChatMessage = OpenAI.ChatCompletionMessageParam & {
  /** Unique identifier for the message */
  id: string;
  
  /** Timestamp in milliseconds since epoch when the message was created/added */
  timestamp: number;
  
  /** Flag to indicate if the message should be excluded from processing */
  disabled?: boolean;
  
  /** The ID of the process node that generated or handled this message */
  processNodeId?: string;
};
