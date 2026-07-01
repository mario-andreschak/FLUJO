import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransportOptions, StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransportOptions, SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { MCPSSEConfig } from '@/shared/types/mcp/mcp';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPStreamableConfig, SERVER_DIR_PREFIX } from '@/shared/types/mcp';
import { ChildProcess } from 'child_process';
import { createOAuthClientProvider } from './oauth';
import { resolveServerCwd } from '@/utils/mcp/resolveServerCwd';
import { resolveNodeCommand } from '@/utils/mcp/resolveNodeCommand';
import { hasRoots, registerRootsHandler, rootsConfigKey } from './roots';
import { samplingEnabled, registerSamplingHandler, samplingConfigKey } from './sampling';

// We stash a capabilities key on the client so shouldRecreateClient can detect a change to
// any client-declared MCP capability (roots, sampling) — these are negotiated at connect
// time, and the SDK doesn't expose a client's own declared capabilities publicly.
interface ClientWithCapKey { __flujoCapKey?: string }

/** Combined key of the config that drives client-declared capabilities. */
function capabilityKey(config: MCPServerConfig): string {
  return `${rootsConfigKey(config)}|${samplingConfigKey(config)}`;
}

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

  // CLIENT capabilities advertise what FLUJO (as the MCP client) offers to the server —
  // e.g. roots/sampling/elicitation. tools/resources/prompts are SERVER capabilities and
  // are consumed regardless of what we declare here, so they do not belong here.
  //
  // Roots (#15) are declared ONLY when this server has workspace folders configured.
  // Advertising roots with an empty list could make a roots-aware server refuse
  // everything, so servers without roots behave exactly as they did before. Sampling is
  // likewise declared only when the server has an enabled sampling trust policy, so a
  // server can't ask FLUJO to run LLM calls unless the user opted in.
  const serverHasRoots = hasRoots(config);
  const serverHasSampling = samplingEnabled(config);
  const client = new Client(
    {
      name: `flujo-${config.name}-client`,
      version: '0.2.8',
    },
    {
      capabilities: {
        experimental: {},
        ...(serverHasRoots ? { roots: { listChanged: true } } : {}),
        ...(serverHasSampling ? { sampling: {} } : {}),
      }
    }
  );

  if (serverHasRoots) {
    registerRootsHandler(client, config);
  }
  if (serverHasSampling) {
    registerSamplingHandler(client, config);
  }
  (client as unknown as ClientWithCapKey).__flujoCapKey = capabilityKey(config);

  return client;
}

/**
 * Create a transport for the MCP client
 */
export function createTransport(config: MCPServerConfig): StdioClientTransport | WebSocketClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
  log.debug('Entering createTransport method');

  if (config.transport === 'streamable') {
    log.info(`Creating streamable http transport for server ${config.name} with URL ${config.serverUrl}`);
    const streamableConfig = config as MCPStreamableConfig;
    
    // Create transport options.
    // Build defensively: only include object-typed options when they are actual objects.
    // Legacy persisted configs may contain empty strings (''), which would be spread into
    // the SDK's internal fetch() call and cause a generic "fetch failed" error.
    const transportoptions: StreamableHTTPClientTransportOptions = {};

    if (streamableConfig.requestInit && typeof streamableConfig.requestInit === 'object') {
      transportoptions.requestInit = streamableConfig.requestInit;
    }
    if (streamableConfig.reconnectionOptions && typeof streamableConfig.reconnectionOptions === 'object') {
      transportoptions.reconnectionOptions = streamableConfig.reconnectionOptions;
    }
    if (typeof streamableConfig.sessionId === 'string' && streamableConfig.sessionId.length > 0) {
      transportoptions.sessionId = streamableConfig.sessionId;
    }

    // Merge user-defined custom headers (e.g. Authorization, X-SAP-System-Id, X-SAP-Client)
    // into requestInit so they are sent on every request the SDK makes.
    if (streamableConfig.headers && typeof streamableConfig.headers === 'object') {
      const customHeaders = Object.fromEntries(
        Object.entries(streamableConfig.headers).filter(([key, value]) => key && typeof value === 'string')
      );
      if (Object.keys(customHeaders).length > 0) {
        transportoptions.requestInit = {
          ...(transportoptions.requestInit || {}),
          headers: {
            ...((transportoptions.requestInit?.headers as Record<string, string>) || {}),
            ...customHeaders,
          },
        };
        log.info(`Applied ${Object.keys(customHeaders).length} custom header(s) for ${config.name}: ${Object.keys(customHeaders).join(', ')}`);
      }
    }

    // Add OAuth authentication if configured
    if (streamableConfig.oauthClientId || streamableConfig.oauthClientInformation) {
      log.info(`Setting up OAuth authentication for ${config.name}`);
      const oauthProvider = createOAuthClientProvider(streamableConfig);
      
      // Always set the OAuth provider - let the transport handle the OAuth flow
      transportoptions.authProvider = oauthProvider;
      
      // Check if we have stored tokens, for logging purposes only - actual freshness/expiry
      // is resolved async by oauthProvider.tokens() when the transport uses it.
      if (streamableConfig.oauthTokens?.access_token) {
        log.debug(`OAuth provider configured for ${config.name} with existing tokens`);
        log.debug(`Token expires in: ${streamableConfig.oauthTokens.expires_in} seconds`);
      } else {
        log.debug(`OAuth provider configured for ${config.name} - will initiate OAuth flow if needed`);
      }
    } else {
      log.debug(`No OAuth configuration found for ${config.name}`);
    }
    
    return new StreamableHTTPClientTransport(new URL(config.serverUrl), transportoptions);

  } else if (config.transport === 'sse') {
    log.info(`Creating legacy sse transport for server ${config.name} with URL ${config.serverUrl}`);
    const sseConfig = config as MCPSSEConfig;

    // Build options defensively. Do NOT spread the entire config: it contains many
    // unrelated fields (and possibly empty-string options from legacy persisted data)
    // that would corrupt the SDK's internal fetch() call and cause "fetch failed".
    const transportoptions: SSEClientTransportOptions = {};

    if (sseConfig.requestInit && typeof sseConfig.requestInit === 'object') {
      transportoptions.requestInit = sseConfig.requestInit;
    }
    if (sseConfig.eventSourceInit && typeof sseConfig.eventSourceInit === 'object') {
      transportoptions.eventSourceInit = sseConfig.eventSourceInit;
    }

    // Merge user-defined custom headers (e.g. Authorization, X-SAP-System-Id, X-SAP-Client)
    // into requestInit so they are sent on every request the SDK makes.
    if (sseConfig.headers && typeof sseConfig.headers === 'object') {
      const customHeaders = Object.fromEntries(
        Object.entries(sseConfig.headers).filter(([key, value]) => key && typeof value === 'string')
      );
      if (Object.keys(customHeaders).length > 0) {
        transportoptions.requestInit = {
          ...(transportoptions.requestInit || {}),
          headers: {
            ...((transportoptions.requestInit?.headers as Record<string, string>) || {}),
            ...customHeaders,
          },
        };
        log.info(`Applied ${Object.keys(customHeaders).length} custom header(s) for ${config.name}: ${Object.keys(customHeaders).join(', ')}`);
      }
    }

    return new SSEClientTransport(new URL(config.serverUrl), transportoptions);

  } else if (config.transport === 'websocket') {
    log.info(`Creating WebSocket transport for server ${config.name} with URL ${config.websocketUrl}`);
    return new WebSocketClientTransport(new URL(config.websocketUrl));

  } else {
    return createStdioTransport(config);
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

  // #36: resolve bare `node`/`npm`/`npx` to absolute paths so spawning works even
  // when FLUJO was launched outside a shell that initialized nvm (and thus inherited
  // a PATH without the nvm Node bin dir). Runs after the .bat rewrite above so
  // `cmd.exe` is left untouched.
  const resolvedCommand = resolveNodeCommand(command, {
    execPath: process.execPath,
    platform: os.platform(),
    dirname: path.dirname,
    joinPath: path.join,
    fileExists: fs.existsSync,
  });
  if (resolvedCommand !== command) {
    log.debug(`Resolved Node toolchain command "${command}" to absolute path: ${resolvedCommand}`);
    command = resolvedCommand;
  }

  log.debug(`Final command: ${command}`);
  log.debug(`Final args: ${JSON.stringify(args)}`);
  // Use the original (pre-.bat-rewrite) command/args for runner detection so e.g.
  // `npx` isn't masked by the cmd.exe wrapper applied above for .bat files.
  const cwd = resolveServerCwd({
    command: config.command,
    args: config.args,
    rootPath: config.rootPath,
    cwd: config.cwd,
    serverName: config.name,
    defaultCwd: `${SERVER_DIR_PREFIX}/${config.name}`,
  });
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
  const transportoptions: StdioServerParameters = {
    command: command, 
    args: args,
    env: transformedEnv,
    cwd: cwd, 
    stderr: 'pipe'
  };

  const transport = new StdioClientTransport(transportoptions);

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

  // A change to any client-declared capability (roots, sampling) must rebuild the client:
  // it alters both the declared capability (none<->some) and the config the request
  // handlers close over. These are negotiated only at connect time.
  const currentCapKey = (client as unknown as ClientWithCapKey).__flujoCapKey ?? '';
  if (currentCapKey !== capabilityKey(config)) {
    return { needsNewClient: true, reason: 'Client capabilities (roots/sampling) changed' };
  }

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
  } else if (config.transport === 'streamable') {
    // For streamable HTTP transport, ensure the existing client uses the matching transport.
    if (!(client.transport instanceof StreamableHTTPClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to streamable',
      };
    }

    // Check if the server URL has changed
    const transport = client.transport as StreamableHTTPClientTransport;
    const currentUrl = (transport as unknown as { _url?: URL })._url?.toString();
    if (currentUrl !== undefined && currentUrl !== new URL(config.serverUrl).toString()) {
      return { needsNewClient: true, reason: 'Streamable server URL changed' };
    }
  } else if (config.transport === 'sse') {
    // For SSE transport, ensure the existing client uses the matching transport.
    if (!(client.transport instanceof SSEClientTransport)) {
      return {
        needsNewClient: true,
        reason: 'Transport type changed to sse',
      };
    }

    // Check if the server URL has changed
    const sseConfig = config as MCPSSEConfig;
    const transport = client.transport as SSEClientTransport;
    const currentUrl = (transport as unknown as { _url?: URL })._url?.toString();
    if (currentUrl !== undefined && currentUrl !== new URL(sseConfig.serverUrl).toString()) {
      return { needsNewClient: true, reason: 'SSE server URL changed' };
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
 * Safely close a client connection following the MCP shutdown sequence
 */
export async function safelyCloseClient(client: Client, serverName: string, config?: MCPServerConfig): Promise<void> {
  log.debug('Entering safelyCloseClient method');
  try {
    // Check if the transport is stdio
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
