import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ChatCompletionRequest } from './requestParser';
// import { parseFlowResponse } from './FlowResponseParser';
import { FlowExecutionResponse, ErrorResult } from '@/shared/types/flow/response';
// Removed formatResponseContent import
import OpenAI from 'openai';

const log = createLogger('app/v1/chat/completions/chatCompletionService');

// Simple token counter (approximation)
// For production, consider using a proper tokenizer like 'tiktoken' or 'gpt-tokenizer'
export function countTokens(text: string): number {
  const startTime = Date.now();
  log.debug('Counting tokens for text', { textLength: text.length });
  
  // GPT models use tokens that are about 4 characters on average for English text
  // This is a simple approximation - for production, use a proper tokenizer
  const tokenCount = Math.ceil(text.length / 4);
  
  const duration = Date.now() - startTime;
  log.debug('Token counting completed', { tokenCount, duration: `${duration}ms` });
  
  return tokenCount;
}

// Using OpenAI's type for token usage
export type TokenUsage = OpenAI.CompletionUsage;

/**
 * Determines if an error is retryable based on OpenAI's error codes documentation
 * https://platform.openai.com/docs/guides/error-codes
 */
export function isRetryableError(error: any): boolean {
  log.debug('Checking if error is retryable', {
    errorType: typeof error,
    status: error.status,
    code: error.code,
    message: error.message
  });

  // Check for rate limit errors
  if (error.status === 429) {
    log.info('Retryable error: Rate limit (429)', { error });
    return true;
  }
  
  // Check for server errors
  if (error.status >= 500 && error.status < 600) {
    log.info(`Retryable error: Server error (${error.status})`, { error });
    return true;
  }
  
  // Check for timeout errors
  if (error.message?.includes('timeout') || error.code === 'ETIMEDOUT') {
    log.info('Retryable error: Timeout', { error });
    return true;
  }
  
  // Check for connection errors
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
    log.info('Retryable error: Connection issue', { error });
    return true;
  }
  
  log.debug('Error is not retryable', { error });
  return false;
}


// Process chat completion request with the given data
export async function processChatCompletion(data: ChatCompletionRequest) {
  const startTime = Date.now();
  const requestId = `proc-${Date.now()}`;
  
  log.info('Processing chat completion request', {
    requestId,
    model: data.model,
    messageCount: data.messages?.length || 0,
    temperature: data.temperature,
    stream: data.stream
  });
  
  try {
    // Extract flow name from model parameter
    // Format: "flow-FlowName"
    const modelParam = (data.model || '').trim();
    log.debug('Validating model parameter', { requestId, modelParam });
    
    if (!String(modelParam).startsWith('flow-')) {
      const errorMessage = `Invalid model format. Expected "flow-[FlowName]" but got ${modelParam}`;
      log.warn('Invalid model format', {
        requestId,
        modelParam,
        error: errorMessage
      });
      
      return NextResponse.json(
        {
          error: {
            message: errorMessage,
            type: 'invalid_request_error',
            code: 'invalid_model'
          }
        },
        { status: 400 }
      );
    }
    
    const flowName = modelParam.substring(5); // Remove "flow-" prefix
    log.info(`Flow name extracted`, { requestId, flowName });
    
    // Extract messages
    const messages = data.messages || [];
    log.info(`Messages extracted`, {
      requestId,
      count: messages.length,
      roles: messages.map(m => m.role)
    });
    
    // Calculate input tokens
    log.debug('Calculating input tokens', { requestId });
    const messagesText = messages.map(msg => `${msg.role}: ${msg.content}`).join('\n');
    const promptTokens = countTokens(messagesText);
    log.info('Input tokens calculated', { requestId, promptTokens });
    
    // Execute the flow
    const flowStartTime = Date.now();
    log.info(`Attempting to execute flow`, {
      requestId,
      flowName,
      startTime: flowStartTime,
      options: {
        temperature: data.temperature,
        max_tokens: data.max_tokens,
        top_p: data.top_p,
        frequency_penalty: data.frequency_penalty,
        presence_penalty: data.presence_penalty
      }
    });
    
    
    const inputMessages = messages.filter(msg => msg.role !== 'system');
    
    const result = await FlowExecutor.executeFlow(flowName, { messages: inputMessages });
    
    const flowDuration = Date.now() - flowStartTime;
    log.info('Flow execution completed', {
      requestId,
      duration: `${flowDuration}ms`,
      success: result.success,
      hasResult: result?.result !== undefined && result?.result !== null
    });
    log.debug('chatCompletionService - Full result : ', result);
    
    // Check if the flow execution resulted in an error
    if (!result.success) {
      // Extract error details from the result
      const errorResult = result.result as ErrorResult;
      const statusCode = 
        typeof errorResult?.errorDetails?.status === 'number' ? 
        errorResult.errorDetails.status as number : 500;
      
      // Create OpenAI-compatible error response
      log.error('Flow execution returned an error', {
        requestId,
        errorMessage: errorResult.error,
        statusCode,
        errorDetails: errorResult.errorDetails
      });
      
      const errorResponse = NextResponse.json({
        error: {
          message: errorResult.error || 'An error occurred during flow execution',
          type: errorResult.errorDetails?.type as string || 'api_error',
          code: errorResult.errorDetails?.code as string || 'internal_error',
          param: errorResult.errorDetails?.param as string,
          details: errorResult.errorDetails
        }
      }, { status: statusCode });
      
      return errorResponse;
    }
    
    // Format the response according to OpenAI API format
    const responseId = `chatcmpl-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    
    // Get all messages from the flow execution result
    const resultMessages = result.messages;
    
    // Get the last assistant message for token counting and response formatting
    const lastAssistantMessage = [...resultMessages].reverse().find(msg => msg.role === 'assistant');
    const lastMessageContent = typeof lastAssistantMessage?.content === 'string' ? lastAssistantMessage?.content : '';
    const completionTokens = countTokens(lastMessageContent);
    
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    };
    
    // Create the response message with tool calls if present
    // We'll use the last assistant message from the flow execution result
    const responseMessage: OpenAI.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: lastMessageContent
    };
    
    // Add tool calls if they exist in the result
    if (result.toolCalls && result.toolCalls.length > 0) {
      log.info('Adding tool calls to response', { toolCallsCount: result.toolCalls.length });
      
      // Convert to OpenAI format
      responseMessage.tool_calls = result.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args)
        }
      } as OpenAI.ChatCompletionMessageToolCall));
    }
    
    // Log all messages from the flow execution
    log.debug('All messages from flow execution:', { 
      messageCount: resultMessages.length,
      messageRoles: resultMessages.map(m => m.role)
    });
    
    // Include all messages from the flow execution in the response
    const responseData = {
      id: responseId,
      object: "chat.completion",
      created: timestamp,
      model: modelParam,
      choices: [
        {
          index: 0,
          message: responseMessage,
          finish_reason: "stop"
        }
      ],
      usage,
      // Add the messages array from the flow execution result
      messages: result.messages
    };
    
    // Check if streaming is requested
    if (data.stream === true) {
      log.info('Streaming response requested, sending SSE', { requestId });
      return createStreamingResponse(modelParam, lastMessageContent, usage, result.messages);
    } else {
      // Return the complete response
      log.info('Returning OpenAI-compatible response', {
        requestId,
        responseId,
        contentLength: lastMessageContent.length
      });
      
      return NextResponse.json(responseData);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Extract detailed error information if available
    const errorStatus = (error as any)?.status || 500;
    const errorCode = (error as any)?.code || 'internal_error';
    const errorType = (error as any)?.type || 'internal_error';
    const errorParam = (error as any)?.param;
    const errorDetails = (error as any)?.errorDetails;
    
    log.error('Error in processChatCompletion', {
      requestId,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        status: errorStatus,
        code: errorCode,
        type: errorType,
        param: errorParam,
        details: errorDetails
      } : error,
      duration: `${duration}ms`,
      model: data.model,
      messageCount: data.messages?.length || 0
    });
    
    // Create a more detailed error response following OpenAI error format
    // https://platform.openai.com/docs/guides/error-codes
    const errorResponse = NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Failed to process chat completion',
          type: errorType || 'api_error',
          code: errorCode || 'internal_error',
          param: errorParam,
          // Note: OpenAI doesn't include 'details' in their standard error format
          // but we'll keep it for internal debugging purposes
          details: errorDetails
        }
      },
      { status: errorStatus }
    );
    return errorResponse;
  }
}

// Create a streaming response using Server-Sent Events (SSE)
export function createStreamingResponse(modelParam: string, content: string, usage: TokenUsage, messages?: OpenAI.ChatCompletionMessageParam[]) {
  const startTime = Date.now();
  const streamId = `stream-${Date.now()}`;
  log.info('Creating streaming response', {
    streamId,
    modelParam,
    contentLength: content.length,
    tokenUsage: usage
  });
  
  const encoder = new TextEncoder();
  const responseId = `chatcmpl-${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  
  // Split content into chunks for more natural streaming
  // For simplicity, we'll split by spaces to simulate word-by-word streaming
  // In a production environment, you might want a more sophisticated chunking strategy
  const contentChunks = typeof content === 'string' ? content.split(' ') : [''];
  log.debug('Content split into chunks', {
    streamId,
    chunkCount: contentChunks.length,
    averageChunkLength: Math.round(content.length / contentChunks.length)
  });
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const controllerStartTime = Date.now();
        log.debug('Starting stream controller', { streamId, timestamp: controllerStartTime });
        
        // Send the initial chunk with role
        log.debug('Sending initial chunk with role', { streamId });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created: timestamp,
          model: modelParam,
          choices: [{
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null
          }]
        })}\n\n`));
        
        // Small delay to simulate natural typing
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Send the content in chunks
        const chunksStartTime = Date.now();
        log.debug('Starting to send content chunks', {
          streamId,
          chunkCount: contentChunks.length,
          startTime: chunksStartTime
        });
        
        let chunksSent = 0;
        const progressLogInterval = Math.max(1, Math.floor(contentChunks.length / 10)); // Log progress at 10% intervals
        
        for (let i = 0; i < contentChunks.length; i++) {
          const chunk = contentChunks[i] + (i < contentChunks.length - 1 ? ' ' : '');
          
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            created: timestamp,
            model: modelParam,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          })}\n\n`));
          
          chunksSent++;
          
          // Log progress at intervals
          if (chunksSent % progressLogInterval === 0 || i === contentChunks.length - 1) {
            const progress = Math.round((chunksSent / contentChunks.length) * 100);
            log.debug('Streaming progress', {
              streamId,
              chunksSent,
              totalChunks: contentChunks.length,
              progress: `${progress}%`,
              elapsedMs: Date.now() - chunksStartTime
            });
          }
          
          // Small delay between chunks to simulate natural typing
          // Skip delay for the last chunk
          if (i < contentChunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        
        // Send the final chunk with usage information and messages if available
        log.debug('Sending final chunk with usage information', { 
          streamId, 
          usage,
          hasMessages: !!messages && messages.length > 0
        });
        
        const finalChunk = {
          id: responseId,
          object: "chat.completion.chunk",
          created: timestamp,
          model: modelParam,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }],
          usage
        };
        
        // Add messages to the final chunk if they exist
        if (messages && messages.length > 0) {
          (finalChunk as any).messages = messages;
        }
        
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        
        // Send the [DONE] marker
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        
        // Close the stream
        const streamDuration = Date.now() - controllerStartTime;
        log.info('Closing stream', {
          streamId,
          duration: `${streamDuration}ms`,
          chunksSent,
          averageChunkTimeMs: Math.round(streamDuration / chunksSent)
        });
        controller.close();
      } catch (error) {
        log.error('Error in streaming response', {
          streamId,
          error: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack
          } : error,
          duration: `${Date.now() - startTime}ms`
        });
        controller.error(error);
      }
    }
  });
  
  const setupDuration = Date.now() - startTime;
  log.info('Returning stream response', {
    streamId,
    setupDuration: `${setupDuration}ms`,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
