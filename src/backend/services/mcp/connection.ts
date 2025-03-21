import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, SERVER_DIR_PREFIX } from '@/shared/types/mcp';
import { ChildProcess } from 'child_process';

const log = createLogger('backend/services/mcp/connection');

interface StdioTransportParameters {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: 'pipe' | 'ignore' | 'inherit';
}

/**
 * Create a new MCP client with proper capabilities
 */
export function createNewClient(config: MCPServerConfig): Client {
  log.debug('Entering createNewClient method');
  return new Client(
    {
      name: `flujo-${config.name}-client`,
      version: '1.0.0',
    },
    {
      capabilities: {
        // Define capabilities according to MCP specification
        resources: {}, // Ability to access resources
        tools: {},     // Ability to use tools
        // Add other capabilities as needed
        experimental: {
          // Any experimental features can be defined here
        }
      }
    }
  );
}

/**
 * Create a transport for the MCP client
 */
export function createTransport(config: MCPServerConfig): StdioClientTransport | WebSocketClientTransport {
  log.debug('Entering createTransport method');
  if (config.transport === 'websocket') {
    log.info(`Creating WebSocket transport for server ${config.name} with URL ${config.websocketUrl}`);
    return new WebSocketClientTransport(new URL(config.websocketUrl));
  }

  return createStdioTransport(config);
}

/**
 * Create a stdio transport for the MCP client
 */
export function createStdioTransport(config: MCPServerConfig): StdioClientTransport {
  log.debug('Entering createStdioTransport method');
  
  // Ensure we're working with a stdio config
  if (config.transport !== 'stdio') {
    throw new Error('Cannot create stdio transport for non-stdio config');
  }
  
  // For Windows .bat files, we need to use cmd.exe to execute them
  let command = config.command;
  let args = config.args ? [...config.args] : [];
  const serverDir = `${SERVER_DIR_PREFIX}/${config.name}`;

  log.info(`Creating stdio transport for server ${config.name}`);
  log.debug(`Original command: ${command}`);
  log.debug(`Original args: ${JSON.stringify(args)}`);
  log.debug(`Server directory: ${serverDir}`);

  // Check if the command is a relative path or just a filename
  const isRelativePath = !path.isAbsolute(command) &&
    (command.includes('/') || command.includes('\\'));
  const isJustFilename = !command.includes('/') && !command.includes('\\');

  // Log the path analysis
  log.debug(`Is relative path: ${isRelativePath}`);
  log.debug(`Is just filename: ${isJustFilename}`);

  // Check if this is a .bat file on Windows
  if (os.platform() === 'win32' && command.toLowerCase().endsWith('.bat')) {
    log.debug(`Detected .bat file on Windows: ${command}`);

    // If it's just a filename (e.g., "run.bat"), check if it exists in the server directory
    if (isJustFilename) {
      const fullPath = path.join(process.cwd(), serverDir, command);
      log.debug(`Checking if file exists at: ${fullPath}`);

      const fileExists = fs.existsSync(fullPath);
      log.debug(`File exists: ${fileExists}`);

      if (fileExists) {
        // Use the full path to the .bat file
        log.debug(`Using full path to .bat file: ${fullPath}`);
        // Use cmd.exe to execute the .bat file
        args = ['/c', fullPath, ...args];
        command = 'cmd.exe';
      } else {
        log.warn(`WARNING: .bat file not found at ${fullPath}`);
        // Still try to use cmd.exe, but log the warning
        args = ['/c', command, ...args];
        command = 'cmd.exe';
      }
    } else {
      // For relative or absolute paths, use as is with cmd.exe
      log.debug(`Using cmd.exe with path as provided: ${command}`);
      args = ['/c', command, ...args];
      command = 'cmd.exe';
    }
  }

  log.debug(`Final command: ${command}`);
  log.debug(`Final args: ${JSON.stringify(args)}`);
  let cwd = config.rootPath || config.cwd || `${SERVER_DIR_PREFIX}/${config.name}`;
  log.debug(`cwd: ${cwd}`);

  // Create the transport with stderr capture
  log.info(`Creating StdioClientTransport for ${config.name} with stderr: 'pipe'`);
  const transport = new StdioClientTransport({
    command: command,
    args: args,
    env: config.env,
    cwd: cwd, // Set working directory to the server's directory
    stderr: 'pipe', // Pipe stderr so we can capture it
  });

  // Check if stderr is available
  if (transport.stderr) {
    log.info(`Stderr stream is available for ${config.name}`);
  } else {
    log.warn(`Stderr stream is NOT available for ${config.name}`);
  }

  return transport;
}

/**
 * Check if an existing client needs to be recreated
 */
export function shouldRecreateClient(
  client: Client,
  config: MCPServerConfig
): { needsNewClient: boolean; reason?: string } {
  log.debug('Entering shouldRecreateClient method');
  // Check if transport type has changed
  if (config.transport === 'websocket') {
    if (!(client.transport instanceof WebSocketClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed from stdio to websocket',
      };
    }

    // // For WebSocket, check if URL has changed
    // const transport = client.transport as WebSocketClientTransport;
    // if (transport._url?.toString() !== config.websocketUrl) { // Property '_url' is private and only accessible within class 'WebSocketClientTransport'.
    //   return { needsNewClient: true, reason: 'WebSocket URL changed' };
    // }
  } else {
    // Default is stdio transport
    if (!(client.transport instanceof StdioClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed from websocket to stdio',
      };
    }

    // For stdio, check command parameters
    const transport = client.transport as StdioClientTransport;

    // Access the transport properties safely using type assertion to unknown first
    const serverParams: StdioTransportParameters | undefined = (transport as unknown as { _serverParams: StdioTransportParameters })._serverParams;
    if (!serverParams) {
      return { needsNewClient: true, reason: 'Cannot access transport options' };
    }

    // Ensure we're working with a stdio config
    if (config.transport !== 'stdio') {
      return { needsNewClient: true, reason: 'Transport type changed from stdio to websocket' };
    }

    // Check if connection parameters have changed
    const commandChanged = serverParams.command !== config.command;
    const argsChanged =
      JSON.stringify(serverParams.args) !== JSON.stringify(config.args);
    const envChanged =
      JSON.stringify(serverParams.env) !== JSON.stringify(config.env);

    if (commandChanged || argsChanged || envChanged) {
      return {
        needsNewClient: true,
        reason: 'Connection parameters changed',
      };
    }
  }

  return { needsNewClient: false };
}

/**
 * Safely close a client connection following the MCP shutdown sequence
 */
export async function safelyCloseClient(client: Client, serverName: string): Promise<void> {
  log.debug('Entering safelyCloseClient method');
  try {
    // First, check if the transport is stdio
    if (client.transport instanceof StdioClientTransport) {
      const stdioTransport = client.transport as StdioClientTransport;
      const process: ChildProcess | undefined = (stdioTransport as unknown as { _process: ChildProcess | undefined })._process;

      if (process && !process.killed) {
        // First try to close stdin to signal graceful shutdown
        try {
          if (process.stdin && !process.stdin.destroyed) {
            process.stdin.end();
            log.debug(`Closed stdin for graceful shutdown for ${serverName}`);
          }
        } catch (stdinError) {
          log.warn(`Error closing stdin for ${serverName}:`, stdinError);
        }
        
        // Set a timeout to force terminate if needed
        const terminateTimeout = setTimeout(() => {
          try {
            if (process && !process.killed) {
              log.warn(`Process did not exit gracefully, sending SIGTERM for ${serverName}`);
              process.kill('SIGTERM');
              
              // Last resort: SIGKILL after another timeout
              setTimeout(() => {
                try {
                  if (process && !process.killed) {
                    log.warn(`Process did not respond to SIGTERM, sending SIGKILL for ${serverName}`);
                    process.kill('SIGKILL');
                  }
                } catch (killError) {
                  log.error(`Error sending SIGKILL for ${serverName}:`, killError);
                }
              }, 5000);
            }
          } catch (termError) {
            log.error(`Error sending SIGTERM for ${serverName}:`, termError);
          }
        }, 5000);
        
        // Clear timeout if process exits naturally
        process.once('exit', () => {
          clearTimeout(terminateTimeout);
          log.info(`Process exited naturally for ${serverName}`);
        });
      }
    }
    
    // Close the client
    await client.close();
    log.info(`Client closed successfully for ${serverName}`);
  } catch (error) {
    log.warn(`Error closing client for ${serverName}:`, error);
    // We continue even if close fails
  }
}
