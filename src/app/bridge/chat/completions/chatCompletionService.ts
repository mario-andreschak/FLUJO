import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ChatCompletionRequest } from './requestParser';

const log = createLogger('app/bridge/chat/completions/chatCompletionService');

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

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

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
    
    const result = await FlowExecutor.executeFlow(flowName, { messages });
    
    const flowDuration = Date.now() - flowStartTime;
    log.info('Flow execution completed successfully', {
      requestId,
      duration: `${flowDuration}ms`,
      hasResult: result?.result !== undefined && result?.result !== null
    });

    // Initialize retryAttempts in sharedState if it doesn't exist
    if (result.retryAttempts === undefined) {
      result.retryAttempts = 0;
    }

    // Format tracking information
    let trackingInfo = '';
    if (JSON.stringify(messages).toUpperCase().includes('~FLUJODEBUG=1')) {
      if (result.nodeExecutionTracker && Array.isArray(result.nodeExecutionTracker) && result.nodeExecutionTracker.length > 0) {
        trackingInfo = '## Flow Execution Tracking\n\n';

        result.nodeExecutionTracker.forEach((node: any) => {
          trackingInfo += `### Node: ${node.nodeName || 'Unknown'} (Type: ${node.nodeType})\n`;

          if (node.nodeType === 'ProcessNode') {
            trackingInfo += `- Model: ${node.modelDisplayName}\n`;
            trackingInfo += `- Technical Name: ${node.modelTechnicalName}\n`;
            trackingInfo += `- Allowed Tools: ${node.allowedTools}\n`;
          }
          
          if (node.nodeType === 'ModelError') {
            trackingInfo += `- Error: ${node.error}\n`;
            if (node.errorDetails) {
              if (node.errorDetails.name) trackingInfo += `- Error Type: ${node.errorDetails.name}\n`;
              if (node.errorDetails.message) trackingInfo += `- Message: ${node.errorDetails.message}\n`;
              if (node.errorDetails.stack) trackingInfo += `- Stack: ${node.errorDetails.stack.split('\n')[0]}\n`;
            }
          }

          trackingInfo += `- Timestamp: ${node.timestamp}\n\n`;
        });

        // Add model response information if available
        if (result.modelResponse) {
          trackingInfo += '### Model Response Details\n';
          trackingInfo += `- Success: ${result.modelResponse.success}\n`;
          if (!result.modelResponse.success) {
            trackingInfo += `- Error: ${result.modelResponse.error || 'Unknown error'}\n`;
            if (result.modelResponse.errorDetails) {
              const details = result.modelResponse.errorDetails;
              trackingInfo += `- Error Details: ${JSON.stringify(details, null, 2)}\n`;
            }
          }
          trackingInfo += '\n';
        }

        trackingInfo += '---\n\n';
      }
    }

    // Prepare the result content with tracking information
    let resultContent = '';
    let handlingInfo = '';

    // Log the result content type for debugging
    log.debug('Result content type:', {
      type: typeof result.result,
      isNull: result.result === null,
      preview: result.result ? (typeof result.result === 'string' ?
        result.result.substring(0, 100) :
        JSON.stringify(result.result).substring(0, 100)) : 'empty'
    });

    // Handle different types of result.result properly
    if (result.result === undefined || result.result === null) {
      // Handle missing result
      handlingInfo = '## Response Handling: Missing result\n\n';
      
      // Check if we have modelResponse with error information
      if (result.modelResponse && !result.modelResponse.success) {
        handlingInfo += `Error: ${result.modelResponse.error || 'Unknown error'}\n\n`;
        if (result.modelResponse.errorDetails) {
          handlingInfo += `Error Details: ${JSON.stringify(result.modelResponse.errorDetails, null, 2)}\n\n`;
        }
        resultContent = trackingInfo + handlingInfo + 'Model execution failed. See tracking information for details.';
      } else {
        resultContent = trackingInfo + handlingInfo + 'No result was returned from the flow execution.';
      }
    } else if (typeof result.result === 'object') {
      // Handle object result
      if (result.result.success === false && result.result.error) {
        // Case 1: Error handling
        handlingInfo = '## Response Handling: Error detected\n\n';
        handlingInfo += `Error: ${result.result.error}\n\n`;
        if (result.result.errorDetails) {
          handlingInfo += `Error Details: ${JSON.stringify(result.result.errorDetails, null, 2)}\n\n`;
        }
        resultContent = trackingInfo + handlingInfo + JSON.stringify(result.result, null, 2);
      } else {
        // Other object handling
        handlingInfo = '## Response Handling: Object response\n\n';
        resultContent = trackingInfo + handlingInfo + JSON.stringify(result.result, null, 2);
      }
    } else if (typeof result.result === 'string') {
      // ===================================================================================================
      // Now handle string results
      // Fix tool call detection - look for the correct pattern
      const hasToolUse = result.result.includes('-_-_-');
      const hasFinalResponse = result.result.includes('<final_response>');
      
      if (hasFinalResponse && hasToolUse) {
        // Case 4: Final response and tool use
        handlingInfo = '## Response Handling: Mixed final response and tool use\n\n';
        // Add message to conversation
        result.messages.push({
          role: 'user',
          content: 'Your last message contained a tool call and final_response, you can not mix this.'
        });
        // Return updated conversation to model by setting resultContent to the stringified messages
        resultContent = trackingInfo + handlingInfo + JSON.stringify(result.messages, null, 2);
      } else if (!hasFinalResponse && !hasToolUse) {
        // Case 2: No final response, no tool use
        // handlingInfo = '## Response Handling: No final response or tool use detected\n\n';
        
        // Don't enforce retry attempt logic here - allow the conversation to continue
        // We'll handle retries only for specific error cases in the API calls
        // resultContent = trackingInfo + handlingInfo + result.result;
        resultContent = trackingInfo + result.result.message;
        
        log.debug('Response has no final_response tag or tool use, but continuing without retry', {
          contentPreview: result.result.substring(0, 100) + (result.result.length > 100 ? '...' : '')
        });
      } else if (!hasFinalResponse && hasToolUse) {
        // Case 3: No final response, but has tool use
        handlingInfo = '## Response Handling: Tool use detected\n\n';
        // Let the ProcessNode handle the tool execution
        resultContent = trackingInfo + handlingInfo + result.result;
        
        log.info('Tool use detected in response', {
          hasToolUse,
          contentPreview: result.result.substring(0, 100) + (result.result.length > 100 ? '...' : '')
        });
      } else {
        // Valid final response without tool use
        handlingInfo = '## Response Handling: Valid final response\n\n';
        resultContent = trackingInfo + handlingInfo + result.result;
      }
    } else {
      // Handle other types (number, boolean, etc.)
      handlingInfo = '## Response Handling: Non-string primitive\n\n';
      resultContent = trackingInfo + handlingInfo + String(result.result);
    }

    
    log.debug('FINAL RESULT', JSON.stringify(resultContent));
    log.debug('FINAL TRACKINGINFO', JSON.stringify(trackingInfo));


    // Calculate completion tokens
    log.debug('Calculating completion tokens', { requestId });
    const completionTokens = countTokens(resultContent);
    
    // Calculate total tokens
    const totalTokens = promptTokens + completionTokens;
    log.info('Token usage calculated', {
      requestId,
      promptTokens,
      completionTokens,
      totalTokens,
      ratio: `${Math.round((completionTokens / promptTokens) * 100)}%`
    });
    
    // Create token usage object
    const usage: TokenUsage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens
    };
    
    // Check if streaming is requested
    const isStreamRequested = data.stream === true;
    
    if (isStreamRequested) {
      log.info('Streaming response requested, sending SSE', { requestId });
      // Log a truncated version of the content
      const contentLength = resultContent.length;
      const truncatedContent = contentLength > 100 ?
        resultContent.substring(0, 100) + `... (${contentLength - 100} more characters)` : resultContent;
      log.info(`Streaming content (truncated)`, {
        requestId,
        contentLength,
        content: truncatedContent
      });
      
      const totalDuration = Date.now() - startTime;
      log.info('Processing completed, sending streaming response', {
        requestId,
        processingDuration: `${totalDuration}ms`,
        tokenUsage: usage
      });
      
      return createStreamingResponse(modelParam, resultContent, usage);
    } else {
      // Return the complete response
      const responseId = `chatcmpl-${Date.now()}`;
      log.debug('Creating response object', {
        requestId,
        responseId,
        contentLength: resultContent.length
      });
      
      const responseData = {
        id: responseId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelParam,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: resultContent
            },
            finish_reason: "stop"
          }
        ],
        usage
      };

      const my_response = NextResponse.json(responseData);
      
      // Log a truncated version of the response for debugging
      const responseDataCopy = { ...responseData };
      if (responseDataCopy.choices && responseDataCopy.choices.length > 0) {
        for (let i = 0; i < responseDataCopy.choices.length; i++) {
          const content = responseDataCopy.choices[i]?.message?.content;
          if (content) {
            const contentLength = content.length;
            responseDataCopy.choices[i].message.content =
              contentLength > 100 ? content.substring(0, 100) + `... (${contentLength - 100} more characters)` : content;
          }
        }
      }
      
      const totalDuration = Date.now() - startTime;
      log.info("Returning response with usage", {
        requestId,
        responseId,
        processingDuration: `${totalDuration}ms`,
        usage: responseDataCopy.usage,
        contentLength: resultContent.length
      });
      
      return my_response;
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
    
    // Create a more detailed error response
    const errorResponse = NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Failed to process chat completion',
          type: errorType,
          code: errorCode,
          param: errorParam,
          details: errorDetails
        }
      },
      { status: errorStatus }
    );
    return errorResponse;
  }
}

// Create a streaming response using Server-Sent Events (SSE)
export function createStreamingResponse(modelParam: string, content: string, usage: TokenUsage) {
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
  const contentChunks = content.split(' ');
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
        
        // Send the final chunk with usage information
        log.debug('Sending final chunk with usage information', { streamId, usage });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
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
        })}\n\n`));
        
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
