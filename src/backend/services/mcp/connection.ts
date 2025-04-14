import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport, StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport, SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { HttpSseClientTransport } from '@/utils/mcp/httpSse';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, SERVER_DIR_PREFIX } from '@/shared/types/mcp';
import { ChildProcess, spawn } from 'child_process';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('backend/services/mcp/connection');

// Map to store Docker container IDs/names for each server
// This allows us to track the actual container ID/name assigned by Docker
export const dockerContainerMap = new Map<string, string>();

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
export function createTransport(config: MCPServerConfig): StdioClientTransport | WebSocketClientTransport | StreamableHTTPClientTransport | SSEClientTransport | HttpSseClientTransport {
  log.debug('Entering createTransport method');
  
  switch (config.transport) {
    case 'websocket':
      log.info(`Creating WebSocket transport for server ${config.name} with URL ${config.websocketUrl}`);
      return new WebSocketClientTransport(new URL(config.websocketUrl));
      
    case 'streamableHttp':
      log.info(`Creating Streamable HTTP transport for server ${config.name} with endpoint ${(config as any).endpoint}`);
      return new StreamableHTTPClientTransport(new URL((config as any).endpoint));
      
    case 'httpSse':
      log.info(`Creating HTTP+SSE transport for server ${config.name}`);
      // For HTTP+SSE (legacy), we use our custom HttpSseClientTransport
      return new HttpSseClientTransport(
        new URL((config as any).sseEndpoint),
        new URL((config as any).messageEndpoint)
      );
      
    case 'docker':
      log.info(`Creating Docker transport for server ${config.name}`);
      return createDockerTransport(config);
      
    default:
      // Default to stdio transport
      return createStdioTransport(config);
  }
}

/**
 * Create a transport for a Docker-based MCP server
 */
export function createDockerTransport(config: MCPServerConfig): StdioClientTransport | WebSocketClientTransport {
  log.debug('Entering createDockerTransport method');
  
  // Ensure we're working with a docker config
  if (config.transport !== 'docker') {
    throw new Error('Cannot create docker transport for non-docker config');
  }
  
  const dockerConfig = config as import('@/shared/types/mcp/mcp').MCPDockerConfig;
  
  // Determine if we're using stdio or websocket for communication with the Docker container
  // Use explicit type check to satisfy TypeScript
  const isWebsocketTransport = dockerConfig.transportMethod === 'websocket';
  if (isWebsocketTransport) {
    // For WebSocket transport, we need to run the container and expose the WebSocket port
    const websocketPort = dockerConfig.websocketPort || 8080;
    const websocketUrl = `ws://localhost:${websocketPort}`;
    
    log.info(`Creating WebSocket transport for Docker container ${dockerConfig.name} with URL ${websocketUrl}`);
    
    // Start the Docker container with the WebSocket port exposed
    startDockerContainer(dockerConfig, websocketPort);
    
    // Return a WebSocket transport
    return new WebSocketClientTransport(new URL(websocketUrl));
  } else {
    // For stdio transport, we run the container and use its stdio directly
    log.info(`Creating stdio transport for Docker container ${dockerConfig.name}`);
    
    // Prepare the run arguments - use -i but NOT -t for proper stdio handling
    const runArgs = ['run', '-i', '--rm'];
    
    // Generate a deterministic container name
    let containerName: string;
    if (dockerConfig.containerName) {
      containerName = dockerConfig.containerName;
    } else {
      containerName = generateContainerName(dockerConfig.name);
      dockerContainerMap.set(dockerConfig.name, containerName);
    }
    
    // Add container name
    runArgs.push('--name', containerName);
    
    // Add network mode if specified
    if (dockerConfig.networkMode) {
      runArgs.push('--network', dockerConfig.networkMode);
    }
    
    // Add volumes if specified
    if (dockerConfig.volumes && dockerConfig.volumes.length > 0) {
      dockerConfig.volumes.forEach(volume => {
        runArgs.push('-v', volume);
      });
    }
    
    // Add WebSocket port mapping if using WebSocket transport
    if (isWebsocketTransport && dockerConfig.websocketPort) {
      runArgs.push('-p', `${dockerConfig.websocketPort}:${dockerConfig.websocketPort}`);
    }
    
    // Add extra arguments if specified
    if (dockerConfig.extraArgs && dockerConfig.extraArgs.length > 0) {
      runArgs.push(...dockerConfig.extraArgs);
    }
    
    // Add environment variables
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        runArgs.push('-e', key);
      }
    }
    
    // Add the image name
    runArgs.push(dockerConfig.image);
    
    log.info(`Starting Docker container for ${dockerConfig.name} with image ${dockerConfig.image}`);
    log.debug(`Docker run command: docker ${runArgs.join(' ')}`);
    
  // Create a copy of the current process environment
  // Use type assertion to ensure it's treated as Record<string, string>
  const processEnv: Record<string, string> = { ...process.env as Record<string, string> };
    
    // Add the environment variables from the configuration to the process environment
    if (config.env) {
      for (const [key, envVar] of Object.entries(config.env)) {
        // Extract the value from the environment variable
        let value: string;
        if (envVar && typeof envVar === 'object' && 'value' in envVar) {
          value = (envVar as { value: string }).value;
        } else {
          value = envVar as string;
        }
        
        // Add to the process environment
        processEnv[key] = value;
        log.debug(`Setting environment variable for Docker: ${key} (value hidden for security)`);
      }
    }
    
    // Create the transport that directly uses the docker run command
    const transport = new StdioClientTransport({
      command: 'docker',
      args: runArgs,
      env: processEnv,
      stderr: 'pipe',
    });
    
    return transport;
  }
}

/**
 * Generate a deterministic container name for Docker
 */
function generateContainerName(serverName: string): string {
  // Generate a short UUID (first 8 characters)
  const shortUuid = uuidv4().split('-')[0];
  // Create a deterministic name with the format flujo_servername_uuid
  return `flujo_${serverName}_${shortUuid}`;
}

/**
 * Start a Docker container for an MCP server with WebSocket transport
 * This is only used for WebSocket transport, as stdio transport now uses a direct approach
 */
function startDockerContainer(config: import('@/shared/types/mcp/mcp').MCPDockerConfig, websocketPort?: number): void {
  log.debug('Entering startDockerContainer method');
  
  // Check if the container is already running
  try {
    // Determine the container name to check for
    let containerNameToCheck: string;
    if (config.containerName) {
      // If a custom container name is provided, use it
      containerNameToCheck = config.containerName;
    } else {
      // Otherwise, generate a deterministic name
      containerNameToCheck = generateContainerName(config.name);
      // Store the container name in the map immediately
      dockerContainerMap.set(config.name, containerNameToCheck);
    }
    
    log.info(`Checking for existing Docker container with name: ${containerNameToCheck}`);
    const checkProcess = spawn('docker', ['ps', '-a', '-q', '-f', `name=${containerNameToCheck}`]);
    
    let output = '';
    checkProcess.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    
    checkProcess.on('close', async (code: number) => {
      if (code === 0 && output.trim() !== '') {
        log.info(`Found existing Docker containers with name ${containerNameToCheck}`);
        
        // Get the container IDs
        const containerIds = output.trim().split('\n');
        
        // Remove any existing containers with the same name
        for (const containerId of containerIds) {
          if (containerId.trim() === '') continue;
          
          try {
            log.info(`Removing existing Docker container ${containerId}`);
            
            // First try to stop it if it's running
            const stopProcess = spawn('docker', ['stop', containerId]);
            await new Promise<void>((resolve) => {
              stopProcess.on('close', () => {
                resolve();
              });
            });
            
            // Then remove it
            const rmProcess = spawn('docker', ['rm', containerId]);
            await new Promise<void>((resolve) => {
              rmProcess.on('close', () => {
                resolve();
              });
            });
            
            log.info(`Successfully removed Docker container ${containerId}`);
          } catch (error) {
            log.warn(`Failed to remove Docker container ${containerId}:`, error);
            // Continue with other containers even if one fails
          }
        }
      }
      
      // Start the container for WebSocket transport
      // Prepare the run arguments - use -d for detached mode
      const runArgs = ['run', '-d', '--rm'];
      
      // Generate a deterministic container name
      let containerName: string;
      if (config.containerName) {
        containerName = config.containerName;
      } else {
        containerName = containerNameToCheck;
      }
      
      // Add container name
      runArgs.push('--name', containerName);
      
      // Add network mode if specified
      if (config.networkMode) {
        runArgs.push('--network', config.networkMode);
      }
      
      // Add volumes if specified
      if (config.volumes && config.volumes.length > 0) {
        config.volumes.forEach(volume => {
          runArgs.push('-v', volume);
        });
      }
      
      // Add WebSocket port mapping
      if (websocketPort) {
        runArgs.push('-p', `${websocketPort}:${websocketPort}`);
      }
      
      // Add extra arguments if specified
      if (config.extraArgs && config.extraArgs.length > 0) {
        runArgs.push(...config.extraArgs);
      }
      
      // Add environment variables
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          runArgs.push('-e', key);
        }
      }
      
      // Add the image name
      runArgs.push(config.image);
      
      log.info(`Starting Docker container for ${config.name} with image ${config.image}`);
      log.debug(`Docker run command: docker ${runArgs.join(' ')}`);
      
      // Create a copy of the current process environment
      const processEnv = { ...process.env };
      
      // Add the environment variables from the configuration to the process environment
      if (config.env) {
        for (const [key, envVar] of Object.entries(config.env)) {
          // Extract the value from the environment variable
          let value: string;
          if (envVar && typeof envVar === 'object' && 'value' in envVar) {
            value = (envVar as { value: string }).value;
          } else {
            value = envVar as string;
          }
          
          // Add to the process environment
          processEnv[key] = value;
          log.debug(`Setting environment variable for Docker: ${key} (value hidden for security)`);
        }
      }
      
      // Use the updated process environment when spawning the Docker process
      const runProcess = spawn('docker', runArgs, { env: processEnv });
      
      let containerId = '';
      runProcess.stdout.on('data', (data: Buffer) => {
        // Capture the container ID from stdout
        containerId += data.toString().trim();
        log.debug(`Docker stdout: ${data.toString().trim()}`);
      });
      
      runProcess.stderr.on('data', (data: Buffer) => {
        log.warn(`Docker stderr: ${data.toString().trim()}`);
      });
      
      runProcess.on('close', (code: number) => {
        if (code === 0 && containerId) {
          log.info(`Docker container started successfully with ID: ${containerId}`);
          
          // Store the container ID for this server
          dockerContainerMap.set(config.name, containerId);
        } else {
          log.error(`Failed to start Docker container for ${config.name}, exit code: ${code}`);
        }
      });
    });
  } catch (error) {
    log.error(`Error starting Docker container for ${config.name}:`, error);
    throw error;
  }
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
  const cwd = config.rootPath || config.cwd || `${SERVER_DIR_PREFIX}/${config.name}`;
  log.debug(`cwd: ${cwd}`);
  log.debug(`env: ${JSON.stringify(config.env)}`);

  // Create the transport with stderr capture
  log.info(`Creating StdioClientTransport for ${config.name} with stderr: 'pipe'`);
  
  // Define the type for environment variables that may have metadata
  interface EnvVarWithMetadata {
    value: string;
    metadata?: {
      isSecret?: boolean;
      [key: string]: unknown;
    };
  }

  // Transform the env object to extract only the value part from each key
  const transformedEnv: Record<string, string> = {};
  if (config.env) {
    for (const [key, envVar] of Object.entries(config.env)) {
      // Check if the env variable is an object with a 'value' property
      if (envVar && typeof envVar === 'object' && 'value' in (envVar as EnvVarWithMetadata)) {
        const typedEnvVar = envVar as EnvVarWithMetadata;
        transformedEnv[key] = typedEnvVar.value;
      } else {
        // If it's already a simple value, use it as is
        transformedEnv[key] = envVar as string;
      }
    }
  }
  
  log.verbose('Transformed environment variables', JSON.stringify(transformedEnv));
  
  const transport = new StdioClientTransport({
    command: command,
    args: args,
    env: transformedEnv,
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
        reason: 'Transport type changed to websocket',
      };
    }

    // // For WebSocket, check if URL has changed
    // const transport = client.transport as WebSocketClientTransport;
    // if (transport._url?.toString() !== config.websocketUrl) { // Property '_url' is private and only accessible within class 'WebSocketClientTransport'.
    //   return { needsNewClient: true, reason: 'WebSocket URL changed' };
    // }
  } else if (config.transport === 'streamableHttp') {
    if (!(client.transport instanceof StreamableHTTPClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to streamableHttp',
      };
    }
    
    // Check if endpoint has changed
    // We can't directly access private properties, but we can assume if the transport type
    // is the same but the endpoint is different, we need to recreate the client
  } else if (config.transport === 'httpSse') {
    if (!(client.transport instanceof HttpSseClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to httpSse',
      };
    }
    
    // Check if endpoints have changed
    // We can't directly access private properties, but we can assume if the transport type
    // is the same but the endpoints are different, we need to recreate the client
  } else if (config.transport === 'docker') {
    // For Docker transport, we need to check if the Docker-specific parameters have changed
    const dockerConfig = config as import('@/shared/types/mcp/mcp').MCPDockerConfig;
    
    // If the current transport is not the expected type based on transportMethod, recreate
    if (dockerConfig.transportMethod === 'websocket') {
      if (!(client.transport instanceof WebSocketClientTransport)) {
        return {
          needsNewClient: true,
          reason: 'Docker transport method changed to websocket',
        };
      }
    } else {
      // For stdio Docker transport
      if (!(client.transport instanceof StdioClientTransport)) {
        return {
          needsNewClient: true,
          reason: 'Docker transport method changed to stdio',
        };
      }
      
      // Check Docker-specific parameters
      const transport = client.transport as StdioClientTransport;
      const serverParams: StdioTransportParameters | undefined = (transport as unknown as { _serverParams: StdioTransportParameters })._serverParams;
      
      if (!serverParams) {
        return { needsNewClient: true, reason: 'Cannot access transport options' };
      }
      
      // Check if Docker command parameters have changed
      // With the new approach, we're using 'docker run' directly
      const isDockerRun = serverParams.command === 'docker' && 
                          serverParams.args && 
                          serverParams.args.length >= 2 && 
                          serverParams.args[0] === 'run';
      
      if (!isDockerRun) {
        return {
          needsNewClient: true,
          reason: 'Docker command parameters changed',
        };
      }
      
      // Find the container name in the args (it should be after '--name')
      let currentContainerName = '';
      if (serverParams.args) {
        for (let i = 0; i < serverParams.args.length - 1; i++) {
          if (serverParams.args[i] === '--name') {
            currentContainerName = serverParams.args[i + 1];
            break;
          }
        }
      }
      
      // Get the expected container name
      let expectedContainerName: string;
      const mappedContainerName = dockerContainerMap.get(dockerConfig.name);
      
      if (mappedContainerName) {
        // Use the mapped container name if available
        expectedContainerName = mappedContainerName;
      } else if (dockerConfig.containerName) {
        // Use the custom container name if provided
        expectedContainerName = dockerConfig.containerName;
      } else {
        // Generate a deterministic name as a fallback
        expectedContainerName = generateContainerName(dockerConfig.name);
      }
      
      if (currentContainerName !== expectedContainerName) {
        return {
          needsNewClient: true,
          reason: 'Docker container name changed',
        };
      }
    }
  } else {
    // Default is stdio transport
    if (!(client.transport instanceof StdioClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to stdio',
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
      return { needsNewClient: true, reason: 'Transport type changed from stdio' };
    }

    // Check if connection parameters have changed
    const commandChanged = serverParams.command !== config.command;
    const argsChanged =
      JSON.stringify(serverParams.args) !== JSON.stringify(config.args);
      
    // Transform the env object to extract only the value part from each key for comparison
    const transformedEnv: Record<string, string> = {};
    if (config.env) {
      for (const [key, envVar] of Object.entries(config.env)) {
        // Check if the env variable is an object with a 'value' property
        if (envVar && typeof envVar === 'object' && 'value' in (envVar as any)) {
          transformedEnv[key] = (envVar as any).value;
        } else {
          // If it's already a simple value, use it as is
          transformedEnv[key] = envVar as string;
        }
      }
    }
    
    const envChanged =
      JSON.stringify(serverParams.env) !== JSON.stringify(transformedEnv);

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
 * Stop a Docker container for an MCP server
 */
async function stopDockerContainer(serverName: string, containerName: string): Promise<void> {
  log.debug(`Stopping Docker container ${containerName} for server ${serverName}`);
  
  try {
    // Check if we have a container ID/name in the map
    const mappedContainerName = dockerContainerMap.get(serverName);
    if (mappedContainerName) {
      log.info(`Using mapped container name for stopping: ${mappedContainerName}`);
      containerName = mappedContainerName;
    }
    
    const stopProcess = spawn('docker', ['stop', containerName]);
    
    stopProcess.stdout.on('data', (data: Buffer) => {
      log.debug(`Docker stop stdout: ${data.toString().trim()}`);
    });
    
    stopProcess.stderr.on('data', (data: Buffer) => {
      log.warn(`Docker stop stderr: ${data.toString().trim()}`);
    });
    
    return new Promise((resolve, reject) => {
      stopProcess.on('close', (code: number) => {
        if (code === 0) {
          log.info(`Docker container ${containerName} stopped successfully`);
          
          // Remove the container from the map
          dockerContainerMap.delete(serverName);
          
          resolve();
        } else {
          const error = new Error(`Failed to stop Docker container ${containerName}, exit code: ${code}`);
          log.error(error.message);
          reject(error);
        }
      });
    });
  } catch (error) {
    log.error(`Error stopping Docker container ${containerName}:`, error);
    throw error;
  }
}

/**
 * Safely close a client connection following the MCP shutdown sequence
 */
export async function safelyCloseClient(client: Client, serverName: string, config?: MCPServerConfig): Promise<void> {
  log.debug('Entering safelyCloseClient method');
  try {
    // Check if this is a Docker-based MCP server
    if (config && config.transport === 'docker') {
      // Get the container name from the map, or use the custom name if provided, or generate a deterministic name
      let containerName: string;
      const mappedContainerName = dockerContainerMap.get(serverName);
      
      if (mappedContainerName) {
        // Use the mapped container name if available
        containerName = mappedContainerName;
      } else if (config.containerName) {
        // Use the custom container name if provided
        containerName = config.containerName;
      } else {
        // Generate a deterministic name as a fallback
        containerName = generateContainerName(serverName);
      }
      
      log.info(`Using container name for stopping: ${containerName}`);
      
      // Stop the Docker container
      try {
        await stopDockerContainer(serverName, containerName);
      } catch (dockerError) {
        log.warn(`Error stopping Docker container for ${serverName}:`, dockerError);
        // Continue with client close even if Docker stop fails
      }
    }
    // Handle different transport types
    else if (client.transport instanceof StreamableHTTPClientTransport || 
             client.transport instanceof SSEClientTransport ||
             client.transport instanceof HttpSseClientTransport) {
      // For HTTP-based transports, just close the client normally
      // No special cleanup needed
      log.info(`Closing HTTP-based transport for ${serverName}`);
    }
    // Check if the transport is stdio
    else if (client.transport instanceof StdioClientTransport) {
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
