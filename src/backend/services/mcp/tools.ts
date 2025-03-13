import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLogger } from '@/utils/logger';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { MCPToolResponse as ToolResponse, MCPServiceResponse } from '@/shared/types/mcp';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('backend/services/mcp/tools');

/**
 * List tools available from an MCP server
 */
export async function listServerTools(client: Client | undefined, serverName: string): Promise<{ tools: ToolResponse[], error?: string }> {
  log.debug('Entering listServerTools method');
  if (!client) {
    log.warn(`Server ${serverName} not connected`);
    return { tools: [], error: 'Server not connected' };
  }

  try {
    log.info(`Listing tools for server ${serverName}`);
    const response = await client.listTools();
    log.debug('Raw response from MCP server:', response);

    const tools = (response.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {}
    }));

    log.verbose('Processed tools:', tools);
    return { tools };
  } catch (error) {
    log.warn(`Failed to list tools for server ${serverName}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      tools: [],
      error: errorMessage.includes('Connection timeout')
        ? errorMessage
        : `Failed to list tools: ${errorMessage}`
    };
  }
}

/**
 * Call a tool on an MCP server with support for progress tracking
 */
export async function callTool(
  client: Client | undefined, 
  serverName: string, 
  toolName: string, 
  args: Record<string, unknown>, 
  timeout?: number
): Promise<MCPServiceResponse> {
  log.debug('Entering callTool method');
  if (!client) {
    log.warn(`Server ${serverName} not found`);
    return { 
      success: false, 
      error: `Server ${serverName} not found`,
      statusCode: 404
    };
  }

  try {
    // Resolve any global variable references in the arguments
    log.debug(`Original args for tool ${toolName}:`, args);
    const resolvedArgs = await resolveGlobalVars(args);
    log.debug(`Resolved args for tool ${toolName}:`, resolvedArgs);
    
    // Generate a progress token for tracking this tool call
    const progressToken = uuidv4();
    log.debug(`Generated progress token: ${progressToken} for tool ${toolName}`);
    
    // Add metadata to the tool call for progress tracking
    const toolCallParams = {
      name: toolName,
      arguments: resolvedArgs as Record<string, unknown>,
      _meta: {
        progressToken
      }
    };
    
    // Handle timeout if specified
    if (timeout !== undefined) {
      log.debug(`Using timeout: ${timeout} seconds for tool ${toolName}`);
      
      if (timeout === -1) {
        // No timeout (infinite)
        log.debug(`No timeout set for tool ${toolName}`);
        const response = await client.callTool(toolCallParams);
        return { 
          success: true, 
          data: response, 
          progressToken 
        };
      } else {
        // Set timeout in milliseconds
        const timeoutMs = timeout * 1000;
        log.debug(`Setting timeout of ${timeoutMs}ms for tool ${toolName}`);
        
        // Create an AbortController for the timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
        
        try {
          // Call the tool with timeout
          const response = await Promise.race([
            client.callTool(toolCallParams),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error(`Tool execution timed out after ${timeout} seconds`));
              });
            })
          ]);
          
          // Clear the timeout
          clearTimeout(timeoutId);
          
          return { 
            success: true, 
            data: response, 
            progressToken 
          };
        } catch (error) {
          // Clear the timeout
          clearTimeout(timeoutId);
          
          // Check if it's a timeout error
          if (error instanceof Error && error.message.includes('timed out')) {
            log.warn(`Tool ${toolName} execution timed out after ${timeout} seconds`);
            
            // Try to send a cancellation notification
            try {
              await cancelToolExecution(client, progressToken, `Execution timed out after ${timeout} seconds`);
              log.info(`Sent cancellation notification for timed out tool ${toolName}`);
            } catch (cancelError) {
              log.warn(`Failed to send cancellation notification: ${cancelError instanceof Error ? cancelError.message : 'Unknown error'}`);
            }
            
            // Create a standardized timeout error response
            const timeoutError = {
              success: false, 
              error: `Tool execution timed out after ${timeout} seconds`,
              errorType: 'timeout',
              toolName,
              timeout,
              progressToken,
              statusCode: 408
            };
            
            // We can't directly emit events from the client, but we can log the error
            // which will be captured by the stderr handler in the SSE route
            log.error(JSON.stringify({
              type: 'error',
              source: 'timeout',
              message: `Tool ${toolName} execution timed out after ${timeout} seconds`,
              toolName,
              timeout,
              progressToken
            }));
            
            return timeoutError;
          }
          
          // Re-throw other errors
          throw error;
        }
      }
    } else {
      // No timeout specified, use default behavior (no timeout)
      log.debug(`No timeout specified for tool ${toolName}, using default (no timeout)`);
      const response = await client.callTool(toolCallParams);
      return { 
        success: true, 
        data: response, 
        progressToken 
      };
    }
  } catch (error) {
    log.warn(`Failed to call tool ${toolName} on server ${serverName}:`, error);
    let errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (error instanceof McpError) {
      errorMessage = `Failed to call tool: ${errorMessage} (Code: ${error.code})`;
    } else {
      errorMessage = `Failed to call tool: ${errorMessage}`;
    }

    return { 
      success: false, 
      error: errorMessage,
      statusCode: 500
    };
  }
}

/**
 * Cancel a tool execution in progress
 */
export async function cancelToolExecution(client: Client, requestId: string, reason: string): Promise<void> {
  log.debug(`Cancelling request ${requestId}: ${reason}`);
  
  try {
    // Send a cancellation notification as per MCP specification
    // Note: This is a custom implementation since the SDK doesn't expose this directly
    const transport = client.transport;
    if (!transport) {
      throw new Error('Client has no transport');
    }
    
    // Create a cancellation notification
    const cancellationNotification = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        requestId,
        reason
      }
    };
    
    // Define a type for transports that support sending messages
    interface SendableTransport {
      send(message: string): Promise<void>;
    }
    
    // Send the notification through the transport
    if ('send' in transport) {
      await (transport as unknown as SendableTransport).send(JSON.stringify(cancellationNotification));
      log.info(`Sent cancellation notification for request ${requestId}`);
    } else {
      throw new Error('Transport does not support sending messages');
    }
  } catch (error) {
    log.error(`Failed to cancel tool execution: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

