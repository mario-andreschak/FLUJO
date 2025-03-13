import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  WebSocketClientTransport,
} from '@modelcontextprotocol/sdk/client/websocket.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { mcpService } from '@/backend/services/mcp';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { FEATURES } from '@/config/features'; // Import the feature flags

const log = createLogger('app/api/sse/route');

export async function GET(request: NextRequest) { 
  // Check if SSE is enabled
  if (!FEATURES.SSE_ENABLED) {
    log.info('SSE route disabled via feature flag');
    return new NextResponse('SSE functionality temporarily disabled via feature flag', { 
      status: 503,
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
        'Connection': 'close',
      },
    });
  }

  const requestId = uuidv4();
  log.info(`Handling GET request [RequestID: ${requestId}]`);
  const searchParams = request.nextUrl.searchParams;
  
  // Get parameters from the request
  const transportType = searchParams.get('transportType');
  const command = searchParams.get('command');
  const args = searchParams.get('args');
  const envStr = searchParams.get('env');
  const serverName = searchParams.get('serverName');
  const url = searchParams.get('url');
  
  log.debug(`Request parameters [${requestId}]`, {
    transportType,
    command: command ? `${command.substring(0, 30)}${command.length > 30 ? '...' : ''}` : null,
    args: args ? `${args.substring(0, 30)}${args.length > 30 ? '...' : ''}` : null,
    serverName,
    url
  });
  
  let client: Client | undefined;
  let transport: StdioClientTransport | WebSocketClientTransport | undefined;
  
  // First, try to get an existing client if serverName is provided
  if (serverName) {
    log.info(`Looking for existing client for server: ${serverName} [${requestId}]`);
    client = mcpService.getClient(serverName);
    
    if (client) {
      log.info(`Found existing client for server: ${serverName} [${requestId}]`);
      transport = client.transport as StdioClientTransport | WebSocketClientTransport;
      
      // Log transport details
      const transportType = transport instanceof StdioClientTransport ? 'stdio' : 
                           transport instanceof WebSocketClientTransport ? 'websocket' : 'unknown';
      log.debug(`Client transport type: ${transportType} [${requestId}]`);
    } else {
      log.warn(`No existing client found for server: ${serverName} [${requestId}]`);
      
      // Log all available clients for debugging
      const availableClients = await mcpService.getAvailableClients();
      log.debug(`Available clients [${requestId}]`, availableClients);
      
      return new NextResponse(`Server "${serverName}" not found or not connected`, { status: 404 });
    }
  } 
  // If no serverName or client not found, try to create a new client with provided parameters
  else if (transportType) {
    log.info(`Creating new client with transport type: ${transportType} [${requestId}]`);
    
    // Check required parameters based on transport type
    if (transportType === 'websocket' && !url) {
      log.error(`Missing url parameter for websocket transport [${requestId}]`);
      return new NextResponse('Missing url parameter for websocket transport', { status: 400 });
    } else if (transportType === 'stdio' && !command) {
      log.error(`Missing command parameter for stdio transport [${requestId}]`);
      return new NextResponse('Missing command parameter for stdio transport', { status: 400 });
    }
    
    // Parse environment variables if provided
    let env: Record<string, string> = {};
    if (envStr) {
      try {
        env = JSON.parse(envStr);
        log.debug(`Parsed environment variables [${requestId}]`, 
          Object.keys(env).map(key => `${key}: ${env[key].substring(0, 20)}${env[key].length > 20 ? '...' : ''}`));
      } catch (error) {
        log.error(`Invalid env JSON [${requestId}]`, error);
        return new NextResponse('Invalid env JSON', { status: 400 });
      }
    }
    
    // Create a new client
    log.debug(`Creating new client instance [${requestId}]`);
    client = new Client(
      {
        name: serverName || `flujo-mcp-client-${requestId}`,
        version: '0.1.1',
      },
      {
        capabilities: {
          resources: {},
          tools: {}
        }
      }
    );
    
    // Create a transport based on the type
    log.debug(`Creating transport for type: ${transportType} [${requestId}]`);
    if (transportType === 'websocket' && url) {
      log.info(`Creating WebSocket transport with URL: ${url} [${requestId}]`);
      transport = new WebSocketClientTransport(new URL(url));
    } else if (transportType === 'stdio') {
      log.info(`Creating stdio transport with command: ${command} [${requestId}]`);
      transport = new StdioClientTransport({
        command: command!,
        args: args ? args.split(' ') : [],
        env: env,
        stderr: 'pipe',
      });
    }
    
    // Connect the client
    try {
      if (!transport) {
        log.error(`Failed to create transport [${requestId}]`);
        return new NextResponse('Failed to create transport', { status: 500 });
      }
      
      log.info(`Connecting client [${requestId}]`);
      await client.connect(transport);
      
      // Note: The MCP SDK Client doesn't expose the initialize method directly
      // We're already connected at this point, which should have performed initialization
      log.info(`Client connected successfully [${requestId}]`);
    } catch (error) {
      log.error(`Failed to connect client [${requestId}]`, error);
      return new NextResponse(`Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`, { status: 500 });
    }
  } else {
    log.error(`Missing required parameters (transportType or serverName) [${requestId}]`);
    return new NextResponse('Missing required parameters (transportType or serverName)', { status: 400 });
  }
  
  // At this point, we should have a valid client and transport
  if (!client || !transport) {
    log.error(`Failed to get or create client [${requestId}]`);
    return new NextResponse('Failed to get or create client', { status: 500 });
  }

  log.info(`Creating SSE stream for client [${requestId}]`);
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      log.debug(`Stream started [${requestId}]`);

      // Send the endpoint event as required by the MCP specification
      const endpoint = `${request.nextUrl.origin}/api/mcp/message?serverName=${encodeURIComponent(serverName || requestId)}`;
      const endpointEvent = `data: ${JSON.stringify({ type: 'endpoint', endpoint })}\n\n`;
      controller.enqueue(encoder.encode(endpointEvent));
      log.debug(`Sent endpoint event [${requestId}]: ${endpoint}`);

      // Define a named function for the message handler
      function messageHandler(event: JSONRPCMessage) {
        try {
          log.debug(`Received message [${requestId}]`, event);
          
          // Format all messages as SSE events, not just notifications
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
          log.debug(`Pushed message to stream [${requestId}]`);
          
          // For backward compatibility, also push notification params separately
          if ('method' in event && event.method && !('id' in event) && event.params) {
            const notificationData = `data: ${JSON.stringify(event.params)}\n\n`;
            controller.enqueue(encoder.encode(notificationData));
            log.debug(`Pushed notification params to stream [${requestId}]`, event.params);
          }
        } catch (error) {
          log.error(`Error processing message [${requestId}]`, error);
        }
      }

      if (transport instanceof StdioClientTransport || transport instanceof WebSocketClientTransport) {
        log.debug(`Setting up message handler [${requestId}]`);
        transport.onmessage = messageHandler;
      }

      // Handle stderr if available for stdio transport
      if (transport instanceof StdioClientTransport && transport.stderr) {
        log.debug(`Setting up stderr handler [${requestId}]`);
        transport.stderr.on('data', (data: Buffer) => {
          const stderrMessage = data.toString();
          log.info(`Stderr output [${requestId}]`, stderrMessage);
          
          // We don't send all stderr as SSE events since servers often print debug info to stderr
          // However, we can check for specific error patterns that should be propagated
          
          // First, check for our custom TOOL_TIMEOUT_ERROR format
          if (stderrMessage.includes("TOOL_TIMEOUT_ERROR")) {
            try {
              // Extract the JSON part from the log message
              const jsonStart = stderrMessage.indexOf('{');
              const jsonEnd = stderrMessage.lastIndexOf('}') + 1;
              
              if (jsonStart >= 0 && jsonEnd > jsonStart) {
                const jsonStr = stderrMessage.substring(jsonStart, jsonEnd);
                const errorData = JSON.parse(jsonStr);
                
                // Send the parsed error data as an SSE event
                const errorEvent = `data: ${JSON.stringify(errorData)}\n\n`;
                controller.enqueue(encoder.encode(errorEvent));
                log.warn(`Propagated timeout error to client [${requestId}]`, errorData);
              }
            } catch (parseError) {
              log.error(`Failed to parse timeout error JSON [${requestId}]`, parseError);
              // Fall back to sending the raw message
              const errorEvent = `data: ${JSON.stringify({ 
                type: 'error', 
                source: 'stderr',
                message: stderrMessage.trim(),
                serverName: serverName
              })}\n\n`;
              controller.enqueue(encoder.encode(errorEvent));
            }
          }
          // Then check for other critical errors
          else if (stderrMessage.includes("Error:") || 
              stderrMessage.includes("Exception:") || 
              stderrMessage.includes("Failed:") ||
              stderrMessage.includes("timed out")) {
            
            const errorEvent = `data: ${JSON.stringify({ 
              type: 'error', 
              source: 'stderr',
              message: stderrMessage.trim(),
              serverName: serverName
            })}\n\n`;
            
            controller.enqueue(encoder.encode(errorEvent));
            log.warn(`Propagated stderr error to client [${requestId}]`, stderrMessage);
          }
        });
      }

      // Handle client disconnection
      log.debug(`Setting up abort handler [${requestId}]`);
      request.signal.addEventListener('abort', () => {
        log.info(`abort event [${requestId}]`);
        
        // Also here:
        // Do NOT Send stderr as an SSE event, while not in production! 
        // Servers usually print debug information into stderr, so it's not an error here and we cant propagate that
        // to SSE because there is no error. (hopefully. We rely on onAbort handling)

        log.info(`Request aborted, cleaning up [${requestId}]`);
        if (transport instanceof StdioClientTransport || transport instanceof WebSocketClientTransport) {
          transport.onmessage = null as unknown as (event: JSONRPCMessage) => void; // Type assertion to null
        }
        
        // Implement proper shutdown sequence according to MCP specification
        log.info(`Initiating proper shutdown sequence [${requestId}]`);
        
        // For stdio transport, follow the proper shutdown sequence
        if (transport instanceof StdioClientTransport) {
          const stdioTransport = transport as StdioClientTransport;
          // Define a type for the internal structure of StdioClientTransport with _process
          interface StdioTransportWithProcess {
            _process: {
              stdin?: {
                end(): void;
                destroyed: boolean;
              };
              killed: boolean;
              kill(signal: string): void;
              once(event: string, listener: () => void): void;
            };
          }
          
          const process = (stdioTransport as unknown as StdioTransportWithProcess)._process;
          
          if (process && !process.killed) {
            // First try to close stdin to signal graceful shutdown
            try {
              if (process.stdin && !process.stdin.destroyed) {
                process.stdin.end();
                log.debug(`Closed stdin for graceful shutdown [${requestId}]`);
              }
            } catch (stdinError) {
              log.warn(`Error closing stdin [${requestId}]`, stdinError);
            }
            
            // Set a timeout to force terminate if needed
            const terminateTimeout = setTimeout(() => {
              try {
                if (process && !process.killed) {
                  log.warn(`Process did not exit gracefully, sending SIGTERM [${requestId}]`);
                  process.kill('SIGTERM');
                  
                  // Last resort: SIGKILL after another timeout
                  setTimeout(() => {
                    try {
                      if (process && !process.killed) {
                        log.warn(`Process did not respond to SIGTERM, sending SIGKILL [${requestId}]`);
                        process.kill('SIGKILL');
                      }
                    } catch (killError) {
                      log.error(`Error sending SIGKILL [${requestId}]`, killError);
                    }
                  }, 5000);
                }
              } catch (termError) {
                log.error(`Error sending SIGTERM [${requestId}]`, termError);
              }
            }, 5000);
            
            // Clear timeout if process exits naturally
            process.once('exit', () => {
              clearTimeout(terminateTimeout);
              log.info(`Process exited naturally [${requestId}]`);
            });
          }
        }
        
        // Close the client
        client.close().catch(error => {
          log.error(`Error closing client on abort [${requestId}]`, error);
        });
        
        controller.close();
        log.info(`Stream closed [${requestId}]`);
      });
    },
  });

  log.info(`Returning SSE stream [${requestId}]`);
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Create a POST endpoint for clients to send messages to the server
// This completes the HTTP with SSE transport as specified in the MCP protocol
export async function POST(request: NextRequest) {
  // Check if SSE is enabled
  if (!FEATURES.SSE_ENABLED) {
    log.info('SSE route disabled via feature flag');
    return new NextResponse('SSE functionality temporarily disabled via feature flag', { 
      status: 503,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }

  const requestId = uuidv4();
  log.info(`Handling POST request [RequestID: ${requestId}]`);
  
  try {
    const searchParams = request.nextUrl.searchParams;
    const serverName = searchParams.get('serverName');
    
    if (!serverName) {
      log.error(`Missing serverName parameter [${requestId}]`);
      return new NextResponse('Missing serverName parameter', { status: 400 });
    }
    
    // Get the client for this server
    const client = mcpService.getClient(serverName);
    if (!client) {
      log.error(`Server "${serverName}" not found or not connected [${requestId}]`);
      return new NextResponse(`Server "${serverName}" not found or not connected`, { status: 404 });
    }
    
    // Parse the message from the request body
    const message = await request.json();
    log.debug(`Received message for server ${serverName} [${requestId}]`, message);
    
    // Send the message to the server
    if ('id' in message && message.id) {
      // It's a request
      log.debug(`Sending request to server ${serverName} [${requestId}]`, message);
      // Note: The SDK doesn't expose sendRequest directly, we'd need to implement this
      // For now, return a not implemented response
      return new NextResponse('Request sending not implemented yet', { status: 501 });
    } else if ('method' in message) {
      // It's a notification
      log.debug(`Sending notification to server ${serverName} [${requestId}]`, message);
      // Note: The SDK doesn't expose sendNotification directly, we'd need to implement this
      // For now, return a not implemented response
      return new NextResponse('Notification sending not implemented yet', { status: 501 });
    } else {
      log.error(`Invalid message format [${requestId}]`, message);
      return new NextResponse('Invalid message format', { status: 400 });
    }
  } catch (error) {
    log.error(`Error handling POST request [${requestId}]`, error);
    return new NextResponse(`Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`, { status: 500 });
  }
}

