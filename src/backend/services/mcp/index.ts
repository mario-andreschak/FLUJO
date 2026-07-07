import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';

// Global recovery map to persist clients across hot reloads
declare global {
  // eslint-disable-next-line no-var
  var __mcp_recovery: Map<string, Client> | undefined;
  // Names of servers whose connection attempt is currently in flight (initial
  // startup sweep or a reconnect). Global-backed for the same reason as
  // __mcp_recovery: the module instance that starts the servers may not be the
  // one that later serves getServerStatus(), and the status route must still be
  // able to see that a startup is in progress so it can report "connecting"
  // instead of a misleading "configured but not connected" error.
  // eslint-disable-next-line no-var
  var __mcp_connecting: Set<string> | undefined;
  // True from process boot until startEnabledServers() finishes its first sweep.
  // eslint-disable-next-line no-var
  var __mcp_starting_up: boolean | undefined;
  // The CURRENT transport per server name. onclose/onerror handlers close over the
  // transport they were registered on and fire for ANY instance — including a zombie
  // process exiting minutes after it was replaced, and closes FLUJO itself initiated.
  // A handler may only clean up / schedule reconnection when its transport IS the one
  // registered here; FLUJO-initiated closes deregister BEFORE closing, so their close
  // events are ignored. Global-backed for the same cross-module-instance reason as
  // __mcp_recovery.
  // eslint-disable-next-line no-var
  var __mcp_active_transports: Map<string, Transport> | undefined;
}

// Initialize the global recovery map if it doesn't exist
if (typeof global.__mcp_recovery === 'undefined') {
  global.__mcp_recovery = new Map<string, Client>();
}
if (typeof global.__mcp_connecting === 'undefined') {
  global.__mcp_connecting = new Set<string>();
}
if (typeof global.__mcp_starting_up === 'undefined') {
  global.__mcp_starting_up = true;
}
if (typeof global.__mcp_active_transports === 'undefined') {
  global.__mcp_active_transports = new Map<string, Transport>();
}

// Import from backend modules
import { MCPServerConfig, MCPStreamableConfig, MCPServiceResponse, MCPToolResponse as ToolResponse } from '@/shared/types/mcp';
import { loadServerConfigs, saveConfig } from './config';
import { listServerTools as listTools, callTool as callToolFunction, ToolCallProgress } from './tools';
import {
  listServerResources as listResources,
  listServerResourceTemplates as listResourceTemplates,
  readResource as readResourceFn,
} from './resources';
import { listServerPrompts as listPrompts, getPrompt as getPromptFn } from './prompts';
import {
  MCPResource,
  MCPResourceTemplate,
  MCPReadResourceResult,
  MCPPrompt,
  MCPGetPromptResult,
} from '@/shared/types/mcp';
import {
  enhanceConnectionErrorMessage,
  formatErrorChain,
  formatErrorResponse,
  isAuthRequiredError,
  isTransientStreamError
} from '@/utils/mcp/utils';
import { encryptApiKey } from '@/backend/services/model/encryption';
import { MASKED_API_KEY } from '@/shared/types/constants';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import {
  createNewClient,
  createTransport,
  shouldRecreateClient,
  safelyCloseClient
} from './connection';
import { setNodeRoots as setNodeRootsOverlay } from './roots';

// Define a type for tool arguments
type ToolArgs = Record<string, unknown>;

// Create a logger instance for this file
const log = createLogger('backend/services/mcp/index');

/**
 * Main service class for MCP server management
 * 
 * This simplified version focuses on providing a clean interface for server management
 * while maintaining compatibility with the MCP SDK.
 */
export class MCPService {
  private clients: Map<string, Client> = new Map();
  private stderrLogs: Map<string, string[]> = new Map(); // Store stderr logs for each server
  // Last connection failure per server. Unlike stderrLogs (which is reset at the start of
  // every connection attempt to capture a fresh run), this persists until the server next
  // connects successfully, so getServerStatus() can always report why a server is down -
  // even during the brief window of an in-flight reconnect.
  private lastConnectionError: Map<string, string> = new Map();
  // De-dupes concurrent connectServer() calls for the same server (see connectServer below).
  private inFlightConnects: Map<string, Promise<MCPServiceResponse>> = new Map();
  private recover_attempted: boolean = false; // Flag to track if recovery has been attempted
  private connectionRetryTimers: Map<string, NodeJS.Timeout> = new Map(); // Track retry timers for each server
  private connectionRetryAttempts: Map<string, number> = new Map(); // Track retry attempts for each server

  // Servers with an in-flight connection attempt. Global-backed (see __mcp_connecting)
  // so the set is shared across module instances / hot reloads.
  private get connectingServers(): Set<string> {
    return global.__mcp_connecting!;
  }

  // The currently-registered transport per server. Global-backed (see
  // __mcp_active_transports) so a deregistration in one module instance is visible to
  // the onclose/onerror handlers that were registered by another.
  private get activeTransports(): Map<string, Transport> {
    return global.__mcp_active_transports!;
  }

  // Cap per-server stderr retention: a chatty or crash-looping server would otherwise
  // grow the array without bound for the lifetime of the process.
  private static readonly MAX_STDERR_LOG_ENTRIES = 200;

  /** Append a stderr/transport-error line for a server, keeping only the newest entries. */
  private appendStderrLog(serverName: string, message: string): void {
    const logs = this.stderrLogs.get(serverName) || [];
    logs.push(message);
    if (logs.length > MCPService.MAX_STDERR_LOG_ENTRIES) {
      logs.splice(0, logs.length - MCPService.MAX_STDERR_LOG_ENTRIES);
    }
    this.stderrLogs.set(serverName, logs);
  }

  /**
   * Remove every live reference to a server's client BEFORE an intentional close.
   *
   * Deregistering first is what marks the close as FLUJO-initiated: the transport's
   * onclose/onerror handlers only act when their transport is still the registered one
   * (see connectServer), so a close that follows a deregistration never schedules a
   * reconnect against ourselves.
   */
  private deregisterClient(serverName: string): void {
    this.clients.delete(serverName);
    this.removeFromGlobalRecovery(serverName);
    this.activeTransports.delete(serverName);
  }

  /**
   * Constructor - attempt to recover clients from global recovery map
   */
  constructor() {
    this.attemptRecovery();
  }
  
  /**
   * Attempt to recover clients from global recovery map
   */
  private attemptRecovery(): void {
    if (!this.recover_attempted && global.__mcp_recovery && global.__mcp_recovery.size > 0) {
      log.info(`Attempting to recover ${global.__mcp_recovery.size} clients from global recovery map`);
      
      // Copy clients from global recovery map
      global.__mcp_recovery.forEach((client, serverName) => {
        this.clients.set(serverName, client);
        log.info(`Recovered client for server: ${serverName}`);
      });
    }
    
    // Mark recovery as attempted
    this.recover_attempted = true;
  }
  
  /**
   * Add a client to the global recovery map
   */
  private addToGlobalRecovery(serverName: string, client: Client): void {
    if (!global.__mcp_recovery) {
      global.__mcp_recovery = new Map<string, Client>();
    }
    
    global.__mcp_recovery.set(serverName, client);
    log.debug(`Added client for server ${serverName} to global recovery map`);
  }

  /**
   * Remove a client from the global recovery map
   */
  private removeFromGlobalRecovery(serverName: string): void {
    if (!global.__mcp_recovery) {
      return;
    }
    
    if (global.__mcp_recovery.has(serverName)) {
      global.__mcp_recovery.delete(serverName);
      log.debug(`Removed client for server ${serverName} from global recovery map`);
    }
  }

  /**
   * Clear retry timer for a server
   */
  private clearRetryTimer(serverName: string): void {
    const timer = this.connectionRetryTimers.get(serverName);
    if (timer) {
      clearTimeout(timer);
      this.connectionRetryTimers.delete(serverName);
      log.debug(`Cleared retry timer for server ${serverName}`);
    }
  }

  /**
   * Schedule connection retry with exponential backoff
   */
  private scheduleConnectionRetry(serverName: string, config: MCPServerConfig): void {
    // Clear any existing timer
    this.clearRetryTimer(serverName);
    
    // Get current retry attempt count
    const currentAttempts = this.connectionRetryAttempts.get(serverName) || 0;
    const maxAttempts = 5; // Maximum retry attempts
    
    if (currentAttempts >= maxAttempts) {
      log.warn(`Maximum retry attempts (${maxAttempts}) reached for server ${serverName}, stopping retries`);
      this.connectionRetryAttempts.delete(serverName);
      return;
    }
    
    // Calculate delay with exponential backoff: 2^attempt * 5000ms, max 5 minutes
    const baseDelay = 5000; // 5 seconds
    const maxDelay = 300000; // 5 minutes
    const delay = Math.min(Math.pow(2, currentAttempts) * baseDelay, maxDelay);
    
    log.info(`Scheduling connection retry for server ${serverName} in ${delay}ms (attempt ${currentAttempts + 1}/${maxAttempts})`);
    
    const timer = setTimeout(async () => {
      log.info(`Attempting to reconnect server ${serverName} (attempt ${currentAttempts + 1}/${maxAttempts})`);
      
      // Check current server configuration before attempting retry
      const currentConfig = await this.getServerConfig(serverName);
      if (!currentConfig) {
        log.info(`Server ${serverName} configuration not found, stopping retry attempts`);
        this.connectionRetryAttempts.delete(serverName);
        return;
      }
      
      // Check if server is now disabled
      if (currentConfig.disabled) {
        log.info(`Server ${serverName} is now disabled, stopping retry attempts`);
        this.connectionRetryAttempts.delete(serverName);
        return;
      }

      // If the server meanwhile has a live, RESPONSIVE connection (e.g. this timer was
      // scheduled by a zombie's late close event, or another path already reconnected),
      // reconnecting here would tear the healthy server down — the exact mechanism of
      // the restart death-spiral. Verify with a real ping, not just map presence.
      const existingClient = this.getClient(serverName);
      if (existingClient) {
        try {
          await existingClient.ping({ timeout: 5000 });
          log.info(`Server ${serverName} is already connected and responsive, cancelling retry`);
          this.connectionRetryAttempts.delete(serverName);
          return;
        } catch (pingError) {
          log.warn(`Server ${serverName} has a registered client but ping failed (${pingError instanceof Error ? pingError.message : String(pingError)}); reconnecting from scratch`);
        }
      }

      // Increment retry count
      this.connectionRetryAttempts.set(serverName, currentAttempts + 1);

      try {
        // A dead-but-present client must be torn down first (connectServer would
        // short-circuit on it); with no client a plain connect is enough.
        const result = existingClient
          ? await this.forceReconnect(serverName)
          : await this.connectServer(currentConfig);
        if (result.success) {
          log.info(`Successfully reconnected server ${serverName} after ${currentAttempts + 1} attempts`);
          // Reset retry count on successful connection
          this.connectionRetryAttempts.delete(serverName);
        } else {
          log.warn(`Failed to reconnect server ${serverName}: ${result.error}`);
          // Don't retry if authentication is required
          if (result.requiresAuthentication) {
            log.info(`Server ${serverName} requires authentication, stopping retry attempts`);
            this.connectionRetryAttempts.delete(serverName);
            return;
          }
          // Schedule another retry if we haven't reached max attempts
          this.scheduleConnectionRetry(serverName, currentConfig);
        }
      } catch (error) {
        log.error(`Error during retry connection for server ${serverName}:`, error);
        // Schedule another retry if we haven't reached max attempts
        this.scheduleConnectionRetry(serverName, currentConfig);
      }
    }, delay);
    
    this.connectionRetryTimers.set(serverName, timer);
  }
  
  /**
   * Check if the backend is currently starting up
   */
  isStartingUp(): boolean {
    return global.__mcp_starting_up === true;
  }

  /**
   * Set the backend startup state
   */
  private setStartingUp(value: boolean): void {
    global.__mcp_starting_up = value;
    log.info(`Backend startup state set to: ${value ? 'starting' : 'complete'}`);
  }

  /**
   * Get a client by server name
   */
  getClient(serverName: string): Client | undefined {
    let client = this.clients.get(serverName);

    // Cross-instance bridge. In production (`next start`) the module instance that ran
    // startup and CONNECTED the servers is usually NOT the one serving this request, so
    // this.clients is empty here even though the server is connected and healthy — which
    // is why every server showed a misleading "configured but not connected" error right
    // after startup while clicking a card (which force-connects in THIS instance) fixed
    // it. The live client lives in the shared global recovery map (the same mechanism
    // that already bridges the "connecting" status across instances), so adopt it.
    // onclose/onerror delete dead clients from that map, so we never adopt a known-dead
    // one; a stale-but-present client self-heals on use via listServerTools/callTool.
    if (!client) {
      const recovered = global.__mcp_recovery?.get(serverName);
      if (recovered) {
        this.clients.set(serverName, recovered);
        client = recovered;
        log.debug(`getClient: adopted ${serverName} from the global recovery map`);
      }
    }

    log.debug(`getClient: Looking for client: ${serverName}`, client ? 'Found' : 'Not found');
    return client;
  }

  /**
   * Load MCP server configurations from storage
   */
  async loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> {
    log.debug('loadServerConfigs: Entering method');
    
    try {
      const serverConfigs = await loadServerConfigs();
      
      if (!Array.isArray(serverConfigs)) {
        log.warn('loadServerConfigs: Received non-array response', serverConfigs);
        return serverConfigs;
      }
      
      log.debug(`loadServerConfigs: Loaded ${serverConfigs.length} server configs`);
      return serverConfigs;
    } catch (error) {
      log.warn('loadServerConfigs: Failed to load server configs:', error);
      return {
        success: false,
        error: `Failed to load server configs: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Get a server configuration by name
   */
  private async getServerConfig(serverName: string): Promise<MCPServerConfig | null> {
    log.debug(`getServerConfig: Looking up config for server ${serverName}`);
    
    const configs = await this.loadServerConfigs();
    
    if (!Array.isArray(configs)) {
      log.warn(`getServerConfig: Failed to load configs for ${serverName}:`, configs.error);
      return null;
    }
    
    const config = configs.find(c => c.name === serverName);
    
    if (!config) {
      log.warn(`getServerConfig: Server ${serverName} not found in configs`);
      return null;
    }
    
    return config;
  }

  /**
   * Whether a server's stored config marks it disabled (issue #54).
   *
   * Unknown servers return false — a missing config is a different failure that is
   * surfaced elsewhere with its own message.
   */
  async isServerDisabled(serverName: string): Promise<boolean> {
    const config = await this.getServerConfig(serverName);
    return config?.disabled === true;
  }

  /**
   * Connect to an MCP server by name
   */
  async connectServer(serverName: string): Promise<MCPServiceResponse>;
  
  /**
   * Connect to an MCP server using a configuration object
   */
  async connectServer(config: MCPServerConfig): Promise<MCPServiceResponse>;
  
  /**
   * Implementation of connectServer that handles both parameter types.
   *
   * De-dupes concurrent calls for the same server name. Without this, two overlapping
   * callers (e.g. a UI-triggered reconnect racing the transport's on-close reconnect
   * handler) each build their own OAuthClientProvider from an independently-loaded config
   * snapshot and can both attempt to redeem the same single-use OAuth refresh token - the
   * second redemption is rejected by the authorization server as invalid_grant, which
   * previously left the stored refresh token permanently poisoned (see isAuthRequiredError
   * and MCPOAuthClientProvider.invalidateCredentials for the recovery half of this fix).
   */
  async connectServer(configOrName: MCPServerConfig | string): Promise<MCPServiceResponse> {
    const serverName = typeof configOrName === 'string' ? configOrName : configOrName.name;

    const inFlight = this.inFlightConnects.get(serverName);
    if (inFlight) {
      log.debug(`connectServer: reusing in-flight connection attempt for ${serverName}`);
      return inFlight;
    }

    const attempt = this.connectServerInternal(configOrName).finally(() => {
      this.inFlightConnects.delete(serverName);
    });
    this.inFlightConnects.set(serverName, attempt);
    return attempt;
  }

  private async connectServerInternal(configOrName: MCPServerConfig | string): Promise<MCPServiceResponse> {
    // Determine if we're connecting by name or by config
    let config: MCPServerConfig;
    
    if (typeof configOrName === 'string') {
      // We're connecting by server name
      const serverName = configOrName;
      log.info(`connectServer: Looking up config for server ${serverName}`);
      
      // Look up the configuration directly from storage
      const existingConfig = await this.getServerConfig(serverName);
      if (!existingConfig) {
        log.warn(`connectServer: Server ${serverName} not found in configs`);
        return {
          success: false,
          error: `Server configuration for "${serverName}" not found. The server may have been deleted or not properly configured.`
        };
      }
      
      config = existingConfig;
    } else {
      // We're connecting with a config object
      config = configOrName;
    }

    // HARD GATE (issue #54): a disabled server must never spawn. This is the single
    // choke point where clients + transports are born — createTransport() is only
    // reachable through this method — so gating here covers every caller (scheduler
    // polls, flow handlers, API routes, self-heal reconnects) and every transport
    // type. Re-resolve the STORED config by name even when the caller passed a
    // config object: flow nodes pass node-bound snapshots that may be stale, and
    // the stored config is the source of truth for `disabled`.
    const storedConfig =
      typeof configOrName === 'string' ? config : await this.getServerConfig(config.name);
    if ((storedConfig ?? config).disabled) {
      log.info(`connectServer: Server ${config.name} is disabled — refusing to create a client/transport`);
      // Disabled servers must not keep retry machinery alive either.
      this.clearRetryTimer(config.name);
      this.connectionRetryAttempts.delete(config.name);
      return {
        success: false,
        error: `Server '${config.name}' is disabled. Enable it on the MCP page to use it.`,
      };
    }

    const requestId = uuidv4();
    log.info(`connectServer: Starting connection for server ${config.name} [RequestID: ${requestId}]`);

    // Mark this server as having an in-flight connection attempt so getServerStatus()
    // reports "connecting" (spinner + auto-poll on the MCP page) instead of an error
    // while the attempt is running. Cleared in the finally below.
    this.connectingServers.add(config.name);

    try {
      // Clear any previous stderr logs for this server
      this.stderrLogs.set(config.name, []);

      // Check if we already have a client for this server
      let client = this.clients.get(config.name);

      // If we already have a client, reuse it - but only if it is still valid for the
      // current config. shouldRecreateClient catches transport-type / URL / command changes
      // that would otherwise leave us talking to a client built for a stale config.
      //
      // Note: this does NOT detect a dead transport (e.g. an expired streamable-HTTP
      // session) - the presence of a client object in the map says nothing about whether
      // the underlying connection is alive. Liveness is verified at the point of use in
      // listServerTools()/callTool(), which reconnect-and-retry on failure. Keeping this
      // check cheap (no network round-trip) preserves the fast path for the common case.
      if (client) {
        const { needsNewClient, reason } = shouldRecreateClient(client, config);
        if (!needsNewClient) {
          log.info(`connectServer: Server ${config.name} is already connected`);
          this.lastConnectionError.delete(config.name);
          // The connection is established - a pending retry (e.g. scheduled by a
          // zombie's late close) must not fire against it later.
          this.clearRetryTimer(config.name);
          this.connectionRetryAttempts.delete(config.name);
          return { success: true };
        }

        log.info(`connectServer: Existing client for ${config.name} is stale (${reason}), recreating`);
        // Deregister BEFORE closing so the transport's own close event is recognized
        // as FLUJO-initiated and does not schedule a reconnect (see deregisterClient).
        this.deregisterClient(config.name);
        try {
          await safelyCloseClient(client, config.name, config);
        } catch (closeError) {
          log.debug(`connectServer: error closing stale client for ${config.name}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
        client = undefined;
      }

      // Create a new client
      client = createNewClient(config);
      const transport = createTransport(config);

      // Add stderr capture
      if (transport instanceof StdioClientTransport && transport.stderr) {
        const serverName = config.name;
        transport.stderr.on('data', (data: Buffer) => {
          const stderrMessage = data.toString();
          log.warn(`stderr: [${serverName}]: ${stderrMessage}`);

          // Store stderr logs (capped, see appendStderrLog)
          this.appendStderrLog(serverName, stderrMessage);
        });
      }

      // Connect and register event handlers
      await client.connect(transport);

      transport.onclose = () => {
        // Only act if THIS transport is still the registered one for the server.
        // Two cases must be ignored: (a) a zombie process from a replaced connection
        // finally exiting — its late close event used to delete the CURRENT healthy
        // client from the maps and schedule a retry against it; (b) closes FLUJO
        // itself initiated (disconnect/reconnect/config change), which deregister
        // before closing and must not schedule a self-defeating reconnect.
        if (this.activeTransports.get(config.name) !== transport) {
          log.debug(`connectServer: ignoring close event from a stale/deregistered transport for ${config.name}`);
          return;
        }

        log.warn(`connectServer: Connection closed for server ${config.name}`);

        // Clean up client references for the transport that actually closed
        this.deregisterClient(config.name);

        // Check if server is still enabled before scheduling reconnection
        this.getServerConfig(config.name).then(currentConfig => {
          if (!currentConfig || currentConfig.disabled) {
            log.info(`Server ${config.name} is now disabled, skipping reconnection logic`);
            return;
          }

          // Only schedule reconnection if server is still enabled
          log.info(`Connection closed for enabled server ${config.name}, scheduling reconnection`);
          this.scheduleConnectionRetry(config.name, currentConfig);
        }).catch(error => {
          log.warn(`Error checking server config for ${config.name} during onclose:`, error);
        });
      };

      transport.onerror = (error) => {
        // The Streamable HTTP transport keeps a long-lived SSE stream open for server->client
        // notifications; servers/proxies recycle that idle stream (e.g. Cloudflare in front of
        // Asana), which surfaces here as "SSE stream disconnected: TypeError: terminated". The
        // SDK reconnects the stream on its own and tool calls keep working, so this is noise —
        // NOT a fatal error. Log it quietly and leave the client in place. Tearing it down here
        // (as the fatal path below does) would fight the SDK's own reconnection and orphan the
        // transport, whose stale reconnection loop would then keep firing this handler.
        if (isTransientStreamError(error)) {
          log.debug(
            `connectServer: transient SSE stream disconnect for ${config.name} (self-healing, ignored): ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }

        // Same stale/deregistered guard as onclose: errors surfacing from a replaced
        // or intentionally-closed transport must not tear down the CURRENT connection
        // or schedule a reconnect against it.
        if (this.activeTransports.get(config.name) !== transport) {
          log.debug(`connectServer: ignoring error event from a stale/deregistered transport for ${config.name}`);
          return;
        }

        // Enhanced error logging to capture more details about transport errors
        log.error(`connectServer: Transport error for server ${config.name}:`);
        
        // Log error details in multiple ways to capture as much information as possible
        if (error instanceof Error) {
          log.error(`Error name: ${error.name}`);
          log.error(`Error message: ${error.message}`);
          log.error(`Error stack: ${error.stack}`);
          // The MCP SDK folds the underlying error into the message string and never sets
          // `error.cause` (see StreamableHTTPClientTransport), so logging it is always
          // "undefined". Log the resolved cause chain instead, plus any HTTP status code
          // carried by StreamableHTTPError (e.g. 502 for a Bad Gateway from the proxy).
          const httpCode = (error as { code?: unknown }).code;
          if (httpCode !== undefined) {
            log.error(`Error code: ${httpCode}`);
          }
          log.error(`Error chain: ${formatErrorChain(error)}`);
        } else if (error && typeof error === 'object') {
          // Try to log individual properties of the error object
          log.error(`Error type: ${typeof error}`);
          log.error(`Error constructor: ${(error as any).constructor?.name || 'Unknown'}`);
          
          // Log all enumerable properties
          const errorProps = Object.getOwnPropertyNames(error);
          if (errorProps.length > 0) {
            log.error(`Error properties: ${errorProps.join(', ')}`);
            errorProps.forEach(prop => {
              try {
                const value = (error as any)[prop];
                log.error(`  ${prop}: ${typeof value === 'function' ? '[Function]' : JSON.stringify(value)}`);
              } catch (propError) {
                log.error(`  ${prop}: [Unable to serialize: ${propError}]`);
              }
            });
          } else {
            log.error(`Error object has no enumerable properties`);
          }
          
          // Try JSON.stringify as fallback
          try {
            const jsonError = JSON.stringify(error);
            log.error(`JSON stringified error: ${jsonError}`);
          } catch (jsonError) {
            log.error(`Cannot JSON stringify error: ${jsonError}`);
          }
        } else {
          log.error(`Error value: ${String(error)} (type: ${typeof error})`);
        }
        
        // Store more detailed error information. Walk the full cause chain so a generic
        // "fetch failed" becomes the real underlying error (e.g. TLS verification failure).
        this.appendStderrLog(config.name, `Transport error: ${formatErrorChain(error)}`);

        // Clean up client references for the transport that actually errored
        this.deregisterClient(config.name);


        // Check if server is still enabled before scheduling reconnection
        this.getServerConfig(config.name).then(currentConfig => {
          if (!currentConfig || currentConfig.disabled) {
            log.info(`Server ${config.name} is now disabled, skipping reconnection after transport error`);
            return;
          }
          
          // Only schedule reconnection if server is still enabled
          log.info(`Transport error for enabled server ${config.name}, scheduling reconnection`);
          this.scheduleConnectionRetry(config.name, currentConfig);
        }).catch(error => {
          log.warn(`Error checking server config for ${config.name} during onerror:`, error);
        });
      };

      // Store the new client and register its transport as the CURRENT one for this
      // server — the reference the onclose/onerror stale guards compare against.
      this.clients.set(config.name, client);
      this.activeTransports.set(config.name, transport);

      // Add to global recovery map
      this.addToGlobalRecovery(config.name, client);

      // Connected successfully - clear any persisted failure from previous attempts,
      // and cancel any pending retry so an old timer can't fire against the fresh
      // connection later (the retry state is orphaned once we're connected).
      this.lastConnectionError.delete(config.name);
      this.clearRetryTimer(config.name);
      this.connectionRetryAttempts.delete(config.name);

      log.info(`connectServer: Successfully connected to ${config.name}`);
      return { success: true };
    } catch (error) {
      log.error(`connectServer: Failed to connect to server ${config.name}:`, error);
      
      // Check if this is an OAuth authentication error
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : '';
      
      if (errorMessage.includes('OAuth authentication required') || errorName === 'OAuthAuthenticationRequired') {
        log.info(`OAuth authentication required for server ${config.name}`);
        
        // Store the authorization URL if available
        if (config.transport === 'streamable') {
          const streamableConfig = config as MCPStreamableConfig;
          if (streamableConfig.authorizationUrl) {
            log.info(`Authorization URL available for ${config.name}: ${streamableConfig.authorizationUrl}`);
          }
        }
        
        return { 
          success: false, 
          error: errorMessage,
          requiresAuthentication: true 
        };
      }
      
      // Check for other OAuth-related errors (401/403 indicating missing auth) - this also
      // covers a freshly-added streamable server that has no OAuth config at all yet, where
      // createTransport() never attached an auth provider and the server just rejected the
      // unauthenticated request outright (e.g. Asana's MCP V2 API).
      if (isAuthRequiredError(error)) {
        log.info(`OAuth authentication error detected for server ${config.name}: ${errorMessage}`);
        
        // For streamable servers, dynamically enable OAuth if not already configured
        if (config.transport === 'streamable') {
          const streamableConfig = config as MCPStreamableConfig;
          
          // If OAuth scopes are not set, this server needs OAuth but wasn't configured for it
          if (!streamableConfig.oauthScopes || streamableConfig.oauthScopes.length === 0) {
            log.info(`Dynamically enabling OAuth for server ${config.name} due to authentication error`);
            
            try {
              // Update the config to include OAuth scopes
              const updatedConfig = {
                ...streamableConfig,
                oauthScopes: ['read'] // Set default OAuth scope
              };
              
              // Save the updated config to storage
              const configs = await this.loadServerConfigs();
              if (Array.isArray(configs)) {
                const configIndex = configs.findIndex(c => c.name === config.name);
                if (configIndex !== -1) {
                  configs[configIndex] = updatedConfig;
                  await saveConfig(new Map(configs.map(c => [c.name, c])));
                  log.info(`Updated config for ${config.name} to enable OAuth`);
                }
              }
            } catch (updateError) {
              log.warn(`Failed to update config for ${config.name} to enable OAuth:`, updateError);
            }
          }
        }
        
        return { 
          success: false, 
          error: 'OAuth authentication failed or tokens have expired. Please re-authenticate.',
          requiresAuthentication: true 
        };
      }
      
      const stderrLogs = this.stderrLogs.get(config.name) || [];
      const enhancedErrorMessage = enhanceConnectionErrorMessage(error, config, stderrLogs);

      // Persist the failure so getServerStatus() can report a meaningful message instead of
      // the generic "configured but not connected" fallback. HTTP transports (streamable/sse)
      // fail inside client.connect(), which is caught here and does NOT necessarily fire
      // transport.onerror, so without this nothing would be recorded for the status poll.
      this.lastConnectionError.set(config.name, enhancedErrorMessage);

      return { success: false, error: enhancedErrorMessage };
    } finally {
      // The attempt has settled (connected, failed, or threw) - it is no longer
      // "connecting". A successful connection now shows as connected; a failure
      // falls through to its real error message.
      this.connectingServers.delete(config.name);
    }
  }

  /**
   * Test a connection to an MCP server WITHOUT registering it as a managed client.
   *
   * This performs a real MCP handshake (and tool listing) using the same transport,
   * TLS trust and custom headers the running server would use. It is the backend
   * counterpart of the modal's "Test Run" button: because it runs in the Next.js
   * server process (not the browser), it can reach servers behind custom CAs and send
   * the configured Authorization/X-SAP-* headers, which a browser fetch cannot.
   */
  async testConnection(config: MCPServerConfig): Promise<MCPServiceResponse> {
    log.info(`testConnection: Testing connection to ${config.name || '(unnamed)'} via ${config.transport} transport`);

    const stderrLogs: string[] = [];
    let client: Client | null = null;
    let transport: ReturnType<typeof createTransport> | null = null;

    try {
      client = createNewClient(config);
      transport = createTransport(config);

      // Capture stdio stderr (for stdio servers) and transport errors so we can build a
      // meaningful message if the handshake fails.
      if (transport instanceof StdioClientTransport && transport.stderr) {
        transport.stderr.on('data', (data: Buffer) => {
          stderrLogs.push(data.toString());
        });
      }
      transport.onerror = (err: Error) => {
        stderrLogs.push(`Transport error: ${formatErrorChain(err)}`);
      };

      const timeoutMs = 15000;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Connection timeout after ${timeoutMs / 1000}s`)),
          timeoutMs
        );
      });

      try {
        await Promise.race([client.connect(transport), timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      // Handshake succeeded — try to list tools to confirm full protocol compatibility.
      let toolCount = 0;
      try {
        const result = await client.listTools();
        toolCount = Array.isArray(result?.tools) ? result.tools.length : 0;
      } catch (listError) {
        log.debug(`testConnection: connected to ${config.name} but listTools failed: ${listError instanceof Error ? listError.message : String(listError)}`);
      }

      log.info(`testConnection: Successfully connected to ${config.name} (${toolCount} tools)`);
      return { success: true, data: { toolCount } };
    } catch (error) {
      log.warn(`testConnection: Failed to connect to ${config.name}:`, error);

      const requiresAuthentication = isAuthRequiredError(error);

      const enhancedErrorMessage = enhanceConnectionErrorMessage(error, config, stderrLogs);
      return { success: false, error: enhancedErrorMessage, requiresAuthentication };
    } finally {
      if (client) {
        try {
          // Short grace: this is a throwaway probe and the Test Run response is
          // waiting on this close - don't hold it for the full production window.
          await safelyCloseClient(client, config.name, config, { gracePeriodMs: 3000, killEscalationMs: 2000 });
        } catch (closeError) {
          log.debug(`testConnection: error closing test client for ${config.name}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
      }
    }
  }

  /**
   * Register (or clear, when `roots` is empty) the workspace-folder overlay a FlowBuilder
   * MCP node contributes to its bound server (issue 46). Connections are singletons keyed
   * by server name, so node roots are additive: roots/list answers with the union of the
   * server-level roots and all currently-registered node roots (falling back to the
   * server's rootPath when there are none at all). The roots capability is always
   * declared, so this NEVER rebuilds a connection — servers whose effective roots
   * changed are told via notifications/roots/list_changed instead.
   */
  setNodeRoots(serverName: string, nodeId: string, roots?: string[]): void {
    const changedServers = setNodeRootsOverlay(serverName, nodeId, roots);
    for (const changed of changedServers) {
      this.notifyRootsChanged(changed);
    }
  }

  /**
   * Announce a roots change to a CONNECTED server via notifications/roots/list_changed
   * (the client always declares roots.listChanged). Fire-and-forget: when the server is
   * not connected this is a no-op — the next connect serves fresh roots anyway — and
   * failures are logged, never thrown (roots are advisory).
   */
  notifyRootsChanged(serverName: string): void {
    const client = this.getClient(serverName);
    if (!client) {
      log.debug(`notifyRootsChanged: ${serverName} not connected, skipping notification`);
      return;
    }
    try {
      void client.sendRootsListChanged().catch((error: unknown) => {
        log.warn(`notifyRootsChanged: failed to notify ${serverName}:`, error);
      });
      log.debug(`notifyRootsChanged: sent roots/list_changed to ${serverName}`);
    } catch (error) {
      log.warn(`notifyRootsChanged: failed to notify ${serverName}:`, error);
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectServer(serverName: string): Promise<MCPServiceResponse> {
    log.debug(`disconnectServer: Entering method for server ${serverName}`);
    
    // Clear any retry timers for this server
    this.clearRetryTimer(serverName);
    this.connectionRetryAttempts.delete(serverName);
    
    // Resolve via getClient (not the local this.clients map): in production the
    // live client is often owned by a DIFFERENT module instance and only survives
    // in the shared global recovery map. Looking it up locally made a config/PAT
    // update's teardown a no-op, leaving the stale-token client alive in the
    // recovery map for the scheduler to adopt (-> `unauthorized`).
    const client = this.getClient(serverName);
    if (!client) {
      log.warn(`disconnectServer: Server ${serverName} not found in clients map`);
      // Even without a live client, purge any lingering global references so a
      // stale entry can never be adopted by another instance after this call.
      this.removeFromGlobalRecovery(serverName);
      this.activeTransports.delete(serverName);
      return { success: false, error: `Server ${serverName} not found` };
    }

    // Deregister BEFORE closing: this marks the close as FLUJO-initiated, so the
    // transport's close event is ignored by the stale guard instead of scheduling a
    // reconnect that would immediately undo this disconnect.
    this.deregisterClient(serverName);

    try {
      // Get the server config to pass to safelyCloseClient
      const config = await this.getServerConfig(serverName);

      // Close the client following the MCP shutdown sequence
      await safelyCloseClient(client, serverName, config || undefined);

      log.info(`disconnectServer: Disconnected server ${serverName}`);
      return { success: true };
    } catch (error) {
      log.warn(`disconnectServer: Failed to disconnect server ${serverName}:`, error);
      return {
        success: false,
        error: `Failed to disconnect server: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Tear down any existing client for a server and establish a fresh connection.
   *
   * Used to self-heal a dead/stale connection: the cached client is closed and removed
   * before reconnecting, so connectServer() is guaranteed to build a brand-new client and
   * transport rather than short-circuiting on the stale one still sitting in the map.
   */
  private async forceReconnect(serverName: string): Promise<MCPServiceResponse> {
    log.info(`forceReconnect: Forcing fresh connection for server ${serverName}`);

    const existing = this.clients.get(serverName);
    if (existing) {
      // Deregister BEFORE closing so the close event is recognized as FLUJO-initiated
      // (see deregisterClient) and does not schedule a competing reconnect.
      this.deregisterClient(serverName);
      const config = await this.getServerConfig(serverName);
      try {
        await safelyCloseClient(existing, serverName, config || undefined);
      } catch (closeError) {
        log.debug(`forceReconnect: error closing stale client for ${serverName}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
      }
    }

    return this.connectServer(serverName);
  }

  /**
   * List tools available from an MCP server.
   *
   * A client object in the map does NOT guarantee a live connection: streamable-HTTP /
   * SSE sessions expire server-side, processes die, networks blip - and the SDK only fires
   * transport.onclose/onerror for *some* of those cases, so a dead client can linger in the
   * map indefinitely. When that happens client.listTools() fails. Rather than surface an
   * empty/failed list (which upstream silently turned into "this node has no MCP tools"),
   * we force a single reconnect-and-retry. Listing tools is idempotent, so retrying is safe.
   */
  async listServerTools(serverName: string): Promise<{ tools: ToolResponse[], error?: string }> {
    log.debug(`listServerTools: Entering method for server ${serverName}`);

    // Point-of-use guard on top of the connect-time hard gate (issue #54): fail
    // loudly instead of attempting a pointless reconnect against a disabled server.
    if (await this.isServerDisabled(serverName)) {
      const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
      log.warn(`listServerTools: ${error}`);
      return { tools: [], error };
    }

    let client = this.getClient(serverName);
    if (!client) {
      log.warn(`listServerTools: Client not found for ${serverName}`);
    }

    let result = await listTools(client, serverName);

    if (result.error) {
      // The connection is likely stale/dead - reconnect from scratch and try once more
      // before giving up, so a recoverable blip does not silently strip a node's tools.
      log.warn(`listServerTools: Listing tools for ${serverName} failed (${result.error}); forcing reconnect and retrying once`);

      const reconnect = await this.forceReconnect(serverName);
      if (!reconnect.success) {
        log.warn(`listServerTools: Reconnect for ${serverName} failed: ${reconnect.error}`);
        return { tools: [], error: reconnect.error || result.error };
      }

      client = this.clients.get(serverName);
      result = await listTools(client, serverName);

      if (result.error) {
        log.warn(`listServerTools: Retry after reconnect still failed for ${serverName}:`, result.error);
      } else {
        log.info(`listServerTools: Recovered after reconnect for ${serverName}; listed ${result.tools.length} tools`);
      }
    } else {
      log.info(`listServerTools: Listed ${result.tools.length} tools for ${serverName}`);
    }

    return result;
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverName: string, toolName: string, args: ToolArgs, timeout?: number, onProgress?: (progress: ToolCallProgress) => void): Promise<MCPServiceResponse> {
    log.debug(`callTool: Entering method for server ${serverName}, tool ${toolName}`);

    // Disabled servers must never be invoked — even if a live client somehow
    // lingers after disabling (issue #54). This point-of-use guard sits on top of
    // the connect-time hard gate so callers (scheduler polls, chat tool calls) get
    // a precise error instead of a pointless reconnect attempt.
    if (await this.isServerDisabled(serverName)) {
      const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
      log.warn(`callTool: ${error}`);
      return { success: false, error };
    }

    let client = this.getClient(serverName);

    // Self-heal BEFORE invoking the tool, and only when there is NO client in the map
    // (e.g. right after a FLUJO restart, or a dropped connection that cleared the map).
    // This is the case that matters for "a flow runs right after a restart". Crucially,
    // we reconnect *before* the call, never retry *after* a failure: the tool has not run
    // yet, so this can never double-execute a side-effecting tool. We deliberately do NOT
    // try to interpret a failed result as "disconnected" — tools.ts maps MCP -32601
    // (method-not-found) and any tool whose own error text contains "not found"/"404" to
    // statusCode 404, none of which mean the connection is dead. A dead-but-present client
    // (e.g. expired HTTP session) is healed by the listServerTools reconnect that the flow
    // path runs before calling tools.
    if (!client) {
      log.warn(`callTool: No client for ${serverName}; forcing reconnect before calling ${toolName}`);
      const reconnect = await this.forceReconnect(serverName);
      if (reconnect.success) {
        client = this.clients.get(serverName);
      } else {
        log.warn(`callTool: Reconnect for ${serverName} failed: ${reconnect.error}`);
      }
    }

    const result = await callToolFunction(client, serverName, toolName, args, timeout, onProgress);
    log.info(`callTool: Called tool ${toolName} on ${serverName}`);
    return result;
  }

  /**
   * Run a list-capability call, reconnecting once if the cached client is stale/dead.
   *
   * Same rationale as listServerTools: a client object in the map does not guarantee a
   * live connection, so a recoverable blip should not silently strip a node's bound
   * resources/prompts. `lister` returns its own typed shape carrying an optional `error`;
   * a present `error` triggers a single force-reconnect-and-retry. Capability-absent
   * servers return an empty list with NO error (see resources.ts/prompts.ts), so they do
   * not trigger a pointless reconnect.
   */
  private async listWithReconnect<T extends { error?: string }>(
    serverName: string,
    lister: (client: Client | undefined, serverName: string) => Promise<T>,
    emptyResult: T
  ): Promise<T> {
    // Point-of-use guard on top of the connect-time hard gate (issue #54).
    if (await this.isServerDisabled(serverName)) {
      const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
      log.warn(`listWithReconnect: ${error}`);
      return { ...emptyResult, error };
    }

    let client = this.clients.get(serverName);
    if (!client) {
      log.warn(`listWithReconnect: Client not found for ${serverName}`);
    }

    let result = await lister(client, serverName);
    if (!result.error) {
      return result;
    }

    log.warn(`listWithReconnect: Listing for ${serverName} failed (${result.error}); forcing reconnect and retrying once`);
    const reconnect = await this.forceReconnect(serverName);
    if (!reconnect.success) {
      log.warn(`listWithReconnect: Reconnect for ${serverName} failed: ${reconnect.error}`);
      return { ...emptyResult, error: reconnect.error || result.error };
    }

    client = this.clients.get(serverName);
    result = await lister(client, serverName);
    if (result.error) {
      log.warn(`listWithReconnect: Retry after reconnect still failed for ${serverName}:`, result.error);
    } else {
      log.info(`listWithReconnect: Recovered after reconnect for ${serverName}`);
    }
    return result;
  }

  /**
   * List the resources a server publishes (#15). Reconnect-and-retry like listServerTools.
   */
  async listServerResources(serverName: string): Promise<{ resources: MCPResource[]; error?: string }> {
    log.debug(`listServerResources: Entering method for server ${serverName}`);
    return this.listWithReconnect(serverName, listResources, { resources: [] });
  }

  /**
   * List the resource templates a server publishes (#15).
   */
  async listServerResourceTemplates(serverName: string): Promise<{ resourceTemplates: MCPResourceTemplate[]; error?: string }> {
    log.debug(`listServerResourceTemplates: Entering method for server ${serverName}`);
    return this.listWithReconnect(serverName, listResourceTemplates, { resourceTemplates: [] });
  }

  /**
   * Read a resource's contents from a server (#15).
   */
  async readResource(serverName: string, uri: string): Promise<MCPServiceResponse<MCPReadResourceResult>> {
    log.debug(`readResource: Entering method for server ${serverName}, uri ${uri}`);
    const client = this.clients.get(serverName);
    if (!client) {
      log.warn(`readResource: Client not found for ${serverName}`);
    }
    const result = await readResourceFn(client, serverName, uri);
    log.info(`readResource: Read resource ${uri} on ${serverName}`);
    return result;
  }

  /**
   * List the prompt templates a server publishes (#15).
   */
  async listServerPrompts(serverName: string): Promise<{ prompts: MCPPrompt[]; error?: string }> {
    log.debug(`listServerPrompts: Entering method for server ${serverName}`);
    return this.listWithReconnect(serverName, listPrompts, { prompts: [] });
  }

  /**
   * Fetch a prompt template, expanded with arguments, from a server (#15).
   */
  async getPrompt(serverName: string, promptName: string, args?: Record<string, string>): Promise<MCPServiceResponse<MCPGetPromptResult>> {
    log.debug(`getPrompt: Entering method for server ${serverName}, prompt ${promptName}`);
    const client = this.clients.get(serverName);
    if (!client) {
      log.warn(`getPrompt: Client not found for ${serverName}`);
    }
    const result = await getPromptFn(client, serverName, promptName, args);
    log.info(`getPrompt: Got prompt ${promptName} on ${serverName}`);
    return result;
  }

  /**
   * Decide what to persist for a streamable server's OAuth client secret, given the value the
   * browser sent and the currently-stored value. Same contract as the model service's
   * API-key handling so the two behave identically:
   *   - MASKED_API_KEY        -> keep the existing stored secret (the UI never saw the real one)
   *   - "${global:VAR}"       -> a global-variable binding; store the reference verbatim
   *   - "encrypted[_failed]:"  -> already encrypted; store as-is (idempotent, no double-encrypt)
   *   - "" (empty)            -> cleared/unbound; store empty
   *   - anything else         -> a freshly typed plaintext secret; encrypt it at rest
   */
  private async resolveOAuthSecretForSave(incoming: string, existing: string | undefined): Promise<string> {
    if (incoming === MASKED_API_KEY) return existing ?? '';
    if (!incoming) return '';
    if (incoming.startsWith('${global:')) return incoming;
    if (incoming.startsWith('encrypted:') || incoming.startsWith('encrypted_failed:')) return incoming;
    return await encryptApiKey(incoming);
  }

  /**
   * Update an MCP server configuration
   */
  /**
   * Eagerly create the root dir of a remote (streamable/SSE/websocket) server (issue 52).
   * Remote servers default to mcp-servers/<name> like stdio servers, but nothing else
   * ever creates that folder for them (no clone/install step). Only safe, scoped paths
   * are created: filesystem roots are skipped, and relative paths resolve against the
   * data dir (where mcp-servers/ lives). Best-effort — failures are logged, never thrown.
   */
  private async ensureRemoteServerRootDir(config: MCPServerConfig): Promise<void> {
    try {
      if (!['streamable', 'sse', 'websocket'].includes(config.transport)) return;
      const rootPath = (config.rootPath || '').trim();
      if (!rootPath) return;
      const resolved = path.resolve(getDataDir(), rootPath);
      // Never create (or touch) a filesystem root — a root is its own parent.
      if (path.dirname(resolved) === resolved) return;
      await fs.mkdir(resolved, { recursive: true });
      log.debug(`ensureRemoteServerRootDir: ensured ${resolved} for ${config.name}`);
    } catch (error) {
      log.warn(`ensureRemoteServerRootDir: could not create root dir for ${config.name}:`, error);
    }
  }

  async updateServerConfig(serverName: string, updates: Partial<MCPServerConfig>): Promise<MCPServerConfig | MCPServiceResponse> {
    log.debug(`updateServerConfig: Entering method for server ${serverName}`);
    
    // Load all configs from storage
    const configsResult = await this.loadServerConfigs();
    if (!Array.isArray(configsResult)) {
      log.warn(`updateServerConfig: Failed to load configs:`, configsResult.error);
      return configsResult;
    }
    
    const configs = configsResult;
    let config = configs.find(c => c.name === serverName);

    // A rename arrives as a PUT whose path is the CURRENT (old) name and whose body
    // carries a different `name`. Detect it up front: the storage swap below already
    // re-keys the entry, but the live connection and per-name state are still keyed by
    // the old name and must be migrated explicitly (see the connection handling at the
    // end of this method).
    const isRename =
      !!config && typeof updates.name === 'string' && updates.name !== serverName;

    // Refuse to rename onto a name another server already uses: the configs are keyed by
    // name, so saving would silently drop one of the two. Surface it as an error instead.
    if (isRename && configs.some(c => c.name === updates.name)) {
      log.warn(`updateServerConfig: Refusing to rename ${serverName} -> ${updates.name}: name already in use`);
      return { success: false, error: `A server named "${updates.name}" already exists` };
    }

    if (!config && updates.name) {
      // New server being added - default to stdio transport
      log.info(`updateServerConfig: Creating new server config for ${updates.name}`);
      config = {
        name: updates.name,
        transport: 'stdio',
        command: '',
        args: [],
        env: {},
        disabled: false,
        autoApprove: [],
        _buildCommand: '',
        _installCommand: '',
        rootPath: '',
      };
      configs.push(config);
    } else if (!config) {
      log.warn(`updateServerConfig: Server ${serverName} not found`);
      return { success: false, error: `Server ${serverName} not found` };
    }

    // If env variables are being updated, resolve any global variable references
    if (updates.env) {
      log.debug(`updateServerConfig: Resolving global variables in env for ${serverName}`);
      try {
        // Log the original env variables for debugging
        log.debug(`Original env variables for ${serverName}:`, JSON.stringify(updates.env, null, 2));
        
        // Resolve global variables in the environment variables and update directly
        updates.env = await resolveGlobalVars(updates.env) as Record<string, string>;
        
        // Log the resolved env variables for debugging
        log.debug(`Resolved env variables for ${serverName}:`, JSON.stringify(updates.env, null, 2));
        
        log.debug(`updateServerConfig: Successfully resolved global variables for ${serverName}`);
      } catch (error) {
        log.warn(`updateServerConfig: Error resolving global variables for ${serverName}:`, error);
        // Continue with the update even if global variable resolution fails
      }
    }

    // OAuth client secret handling, mirroring model API-key semantics. The browser only ever
    // sends MASKED_API_KEY (meaning "keep the stored secret"), a "${global:VAR}" binding, or a
    // freshly typed plaintext secret — never the real stored value. Encrypt plaintext at rest;
    // keep bindings and already-encrypted values as-is; an empty value clears it.
    const incomingSecret = (updates as Partial<MCPStreamableConfig>).oauthClientSecret;
    if (incomingSecret !== undefined) {
      const existingSecret = (config as MCPStreamableConfig).oauthClientSecret;
      (updates as Partial<MCPStreamableConfig>).oauthClientSecret =
        await this.resolveOAuthSecretForSave(incomingSecret, existingSecret);
    }

    // Update the config with the new values (including resolved env variables)
    let updatedConfig: MCPServerConfig = { ...config };
    updatedConfig = {
      ...config,
      ...updates,
    } as MCPServerConfig;

    // Did this update change the server's effective roots (configured roots list or the
    // rootPath default that roots/list falls back to)? Roots never trigger a client
    // rebuild (issue 46), so a connected server is told about the change via
    // notifications/roots/list_changed after the update is applied below.
    const effectiveRootsChanged =
      JSON.stringify((config as { roots?: string[] }).roots ?? []) !==
        JSON.stringify((updatedConfig as { roots?: string[] }).roots ?? []) ||
      (config.rootPath ?? '') !== (updatedConfig.rootPath ?? '');

    // Find and update the config in the array
    const index = configs.findIndex(c => c.name === serverName);
    if (index !== -1) {
      configs[index] = updatedConfig;
    } else if (updatedConfig.name) {
      // This is a new config
      configs.push(updatedConfig);
    }
    
    // Save all configs to storage
    const saveResult = await saveConfig(new Map(configs.map(c => [c.name, c])));
    if (!saveResult.success) {
      log.warn(`updateServerConfig: Failed to save config for ${serverName}:`, saveResult.error);
      return saveResult;
    }

    // Remote servers spawn no process, but their root dir (default mcp-servers/<name>,
    // issue 52) is where folder pickers, per-node roots and future file work point.
    // Eagerly create it so the server always has a folder to work in. Best-effort:
    // a failure here must never block the config update.
    await this.ensureRemoteServerRootDir(updatedConfig);

    // Handle connection state based on config changes.
    if (isRename) {
      // The server now lives under a new name. Tear down everything still keyed by the
      // OLD name — the live client (and its child process), the recovery entry, retry
      // timers, captured stderr and the last connection error — so the rename doesn't
      // leak a dangling process or surface stale status under the old name. Then drive
      // the connection under the NEW name.
      if (this.clients.has(serverName)) {
        await this.disconnectServer(serverName);
      } else {
        this.clearRetryTimer(serverName);
        this.connectionRetryAttempts.delete(serverName);
      }
      this.removeFromGlobalRecovery(serverName);
      this.stderrLogs.delete(serverName);
      this.lastConnectionError.delete(serverName);

      await this.handleConnectionStateChange(updatedConfig.name, updatedConfig);
    } else {
      await this.handleConnectionStateChange(serverName, updatedConfig);
    }

    if (effectiveRootsChanged) {
      this.notifyRootsChanged(updatedConfig.name);
    }

    log.info(`updateServerConfig: Successfully updated config for ${serverName}${isRename ? ` (renamed to ${updatedConfig.name})` : ''}`);
    return updatedConfig;
  }

  /**
   * Handle connection state changes when a server config is updated
   * 
   * This function is called after a server config is updated in storage.
   * It manages the connection state based on the updated config:
   * - If the server is enabled (disabled=false), it attempts to connect it
   * - If the server is disabled (disabled=true), it disconnects it if currently connected
   * 
   * Note: This function does not affect whether the config update itself was successful.
   * The config update can succeed even if the server fails to connect with the new config.
   * This separation allows users to fix configuration issues without being blocked by
   * connection failures.
   */
  private async handleConnectionStateChange(serverName: string, config: MCPServerConfig): Promise<void> {
    log.debug(`handleConnectionStateChange: Entering method for server ${serverName}`);
    
    // Global-aware: the live client may exist only in the shared recovery map
    // (owned by another module instance). A local this.clients.has() check would
    // miss it and skip the "re-apply config to connected server" path that a PAT/
    // header edit needs to rebuild the connection.
    const isCurrentlyConnected = !!this.getClient(serverName);
    const shouldBeConnected = !config.disabled;

    if (isCurrentlyConnected && !shouldBeConnected) {
      // If server should be disabled, disconnect it
      log.info(`handleConnectionStateChange: Disconnecting disabled server ${serverName}`);
      try {
        await this.disconnectServer(serverName);
      } catch (error) {
        log.warn(`handleConnectionStateChange: Failed to disconnect server ${serverName} during update:`, error);
      }
    } else if (!isCurrentlyConnected && shouldBeConnected) {
      // If the server should be enabled but isn't connected, connect it
      log.info(`handleConnectionStateChange: Connecting previously disabled server ${serverName}`);
      await this.connectServer(config);
    } else if (isCurrentlyConnected && shouldBeConnected) {
      // Server stays enabled, but its config may have changed (command, args, env,
      // URL, auth material...). Re-run connectServer: shouldRecreateClient rebuilds the
      // connection only when something meaningful actually changed (otherwise it's a
      // cheap no-op). Roots changes alone never rebuild (issue 46) — they are announced
      // via notifications/roots/list_changed by updateServerConfig instead.
      log.info(`handleConnectionStateChange: Re-applying config to connected server ${serverName}`);
      await this.connectServer(config);
    } else if (!shouldBeConnected) {
      // If server should be disabled, also clear any pending retry timers
      log.info(`handleConnectionStateChange: Clearing retry timers for disabled server ${serverName}`);
      this.clearRetryTimer(serverName);
      this.connectionRetryAttempts.delete(serverName);
    }
  }

  /**
   * Clear all retry timers for disabled servers
   */
  private async clearRetryTimersForDisabledServers(): Promise<void> {
    log.debug('clearRetryTimersForDisabledServers: Checking for disabled servers with active retry timers');
    
    try {
      // Load current configs from storage
      const configs = await this.loadServerConfigs();
      
      if (!Array.isArray(configs)) {
        log.warn('clearRetryTimersForDisabledServers: Failed to load server configs');
        return;
      }
      
      // Find all disabled servers
      const disabledServers = configs.filter(config => config.disabled);
      
      // Clear retry timers for disabled servers
      for (const config of disabledServers) {
        if (this.connectionRetryTimers.has(config.name)) {
          log.info(`clearRetryTimersForDisabledServers: Clearing retry timer for disabled server ${config.name}`);
          this.clearRetryTimer(config.name);
          this.connectionRetryAttempts.delete(config.name);
        }
      }
    } catch (error) {
      log.error('clearRetryTimersForDisabledServers: Error clearing retry timers:', error);
    }
  }

  /**
   * Delete an MCP server configuration
   */
  async deleteServerConfig(serverName: string): Promise<MCPServiceResponse> {
    log.debug(`deleteServerConfig: Entering method for server ${serverName}`);
    
    // First disconnect if connected
    if (this.clients.has(serverName)) {
      log.info(`deleteServerConfig: Disconnecting server ${serverName} before deletion`);
      await this.disconnectServer(serverName);
    }

    // Load all configs from storage
    const configsResult = await this.loadServerConfigs();
    if (!Array.isArray(configsResult)) {
      log.warn(`deleteServerConfig: Failed to load configs:`, configsResult.error);
      return configsResult;
    }
    
    const configs = configsResult;
    
    // Find the config to delete
    const index = configs.findIndex(c => c.name === serverName);
    if (index === -1) {
      log.warn(`deleteServerConfig: Server ${serverName} not found in configs`);
      return { success: false, error: `Server ${serverName} not found` };
    }
    
    // Remove the config from the array
    configs.splice(index, 1);
    
    // Save updated configs
    log.debug(`deleteServerConfig: Saving updated configs after deleting ${serverName}`);
    const saveResult = await saveConfig(new Map(configs.map(c => [c.name, c])));
    
    if (saveResult.success) {
      log.info(`deleteServerConfig: Successfully deleted server ${serverName}`);
    } else {
      log.warn(`deleteServerConfig: Error saving configs after deleting ${serverName}:`, saveResult.error);
    }
    
    return saveResult;
  }

  /**
   * Get the connection status of an MCP server
   */
  async getServerStatus(serverName: string): Promise<{ status: string; message?: string; stderrOutput?: string }> {
    // force recovery
    this.getClient(serverName);

    // Get the config directly from storage
    const config = await this.getServerConfig(serverName);
    if (!config) {
      log.warn(`getServerStatus: Server ${serverName} not found`);
      return { 
        status: 'error', 
        message: `Server ${serverName} configuration not found. The server may have been deleted or not properly configured.` 
      };
    }

    if (config.disabled) {
      log.debug(`getServerStatus: Server ${serverName} is disabled`);
      return { status: 'disconnected' };
    }

    // Check if this is a streamable server that requires OAuth but has no tokens
    if (config.transport === 'streamable') {
      const streamableConfig = config as MCPStreamableConfig;
      if (streamableConfig.oauthScopes && streamableConfig.oauthScopes.length > 0) {
        // This server requires OAuth authentication
        if (!streamableConfig.oauthTokens || !streamableConfig.oauthTokens.access_token) {
          log.info(`getServerStatus: Server ${serverName} requires OAuth authentication but has no valid tokens`);
          return {
            status: 'requires_authentication',
            message: 'OAuth authentication required. Click the authenticate button to complete the OAuth flow.'
          };
        }
        
        // An expired access token only means "re-authenticate" when there is no refresh
        // token to renew it with. With a refresh_token stored, the next connection attempt
        // refreshes silently (see MCPOAuthClientProvider.tokens), so fall through to the
        // real connection state instead of flashing the auth badge after every restart.
        if (
          !streamableConfig.oauthTokens.refresh_token &&
          streamableConfig.oauthTokens.expires_in &&
          (streamableConfig.oauthTokens as any).issued_at
        ) {
          const issuedAt = (streamableConfig.oauthTokens as any).issued_at;
          const expiresIn = streamableConfig.oauthTokens.expires_in;
          const currentTime = Math.floor(Date.now() / 1000);
          const expirationTime = issuedAt + expiresIn;

          if (currentTime >= expirationTime) {
            log.info(`getServerStatus: OAuth tokens for ${serverName} have expired and no refresh token is available`);
            return {
              status: 'requires_authentication',
              message: 'OAuth tokens have expired. Please re-authenticate.'
            };
          }
        }
      }
    }

    // Get any stderr logs for this server
    const stderrLogs = this.stderrLogs.get(serverName) || [];
    const stderrOutput = stderrLogs.join('\n').trim();
    // The last persisted connection failure (survives the per-attempt stderr buffer reset).
    const persistedError = this.lastConnectionError.get(serverName);

    // Check if the client exists — via getClient so we adopt a client connected by the
    // startup module instance (the global recovery map), not just one in THIS instance's
    // local map. Without this, a freshly started server shows "not connected" on the page
    // even though startup connected it in a different instance.
    const clientExists = !!this.getClient(serverName);

    if (clientExists) {
      log.info(`getServerStatus: Server ${serverName} is connected`);
      return {
        status: 'connected',
        stderrOutput: stderrOutput || undefined
      };
    } else {
      // The backend may still be bringing this server up - either an attempt is
      // in flight right now, or the initial startup sweep hasn't reached it yet
      // (it's still queued). Report a transient "connecting" state so the MCP page
      // shows a spinner and keeps polling, instead of the misleading
      // "configured but not connected" error the user would otherwise see for the
      // first few seconds after launch. A server that has already recorded a real
      // connection failure falls through to that error even during startup.
      const startupPending = this.isStartingUp() && !this.lastConnectionError.has(serverName);
      if (this.connectingServers.has(serverName) || startupPending) {
        log.info(`getServerStatus: Server ${serverName} is still connecting`);
        return {
          status: 'connecting',
          message: 'Server is starting up. This may take a few moments.'
        };
      }

      // Check if stderr contains OAuth authentication errors
      if (stderrOutput && (stderrOutput.includes('OAuth authentication required') || stderrOutput.includes('invalid_token'))) {
        log.info(`getServerStatus: OAuth authentication error detected for ${serverName}`);
        return {
          status: 'requires_authentication',
          message: 'OAuth authentication required. Please complete the OAuth flow.',
          stderrOutput: stderrOutput
        };
      }
      
      // Use the live stderr output if present, otherwise the last persisted connection
      // error. HTTP transports fail inside connect() and produce no live stderr, so the
      // persisted error is what makes the real reason visible here.
      const effectiveError = stderrOutput || persistedError;
      if (effectiveError) {
        log.info(`getServerStatus: Using ${stderrOutput ? 'stderr output' : 'persisted connection error'} as error message for ${serverName}`);
        return {
          status: 'error',
          message: effectiveError,
          stderrOutput: stderrOutput || undefined
        };
      }

      // No stderr and no persisted error. We deliberately do NOT spawn the server process
      // here to "capture an error" — that direct-execution probe ran with a 5s timeout PER
      // disconnected stdio server and was the dominant cost of loading the /mcp page (N
      // servers x up to 5s). The connection itself (and its real error) is established by
      // connectServer / the on-demand reconnect in listServerTools & callTool, which is
      // where errors get persisted. Just report the generic state instantly.
      log.info(`getServerStatus: No specific error details available for ${serverName}`);
      return {
        status: 'error',
        message: `Server ${serverName} is configured but not connected. The server process may have crashed or been terminated.`,
        stderrOutput: undefined
      };
    }
  }

  /**
   * Start all enabled servers
   */
  async startEnabledServers(): Promise<void> {
    log.info('Starting all enabled servers');
    this.setStartingUp(true);

    try {
      // First, clear any retry timers for disabled servers
      await this.clearRetryTimersForDisabledServers();

      // Load configs directly from storage
      const configs = await this.loadServerConfigs();

      // Skip if there was an error loading configs
      if (!Array.isArray(configs)) {
        log.warn('Failed to load server configs, cannot start servers');
        return;
      }

      // Find all enabled servers
      const enabledServers = configs.filter(config => !config.disabled);
      log.info(`Found ${enabledServers.length} enabled servers to start`);
      log.debug(`${enabledServers}`);

      // Mark every enabled server as "connecting" up front so the MCP page shows a
      // spinner for all of them while the sweep runs. connectServer() clears each
      // entry as its attempt settles.
      enabledServers.forEach(config => this.connectingServers.add(config.name));

      // Connect all enabled servers in PARALLEL. Connecting sequentially made startup
      // scale with the SUM of every server's connect time (one slow/hanging server
      // delayed all the others, and the page sat in "connecting"/error far too long).
      // Each connectServer() already catches its own failures and never rejects.
      await Promise.all(
        enabledServers.map(config => {
          log.info(`Starting server: ${config.name}`);
          return this.connectServer(config).catch(error => {
            log.error(`Failed to start server ${config.name}:`, error);
            // Swallow so one failure doesn't abort the others.
          });
        })
      );
    } finally {
      // Always reset the flag when done, even if there were errors
      this.setStartingUp(false);
    }
  }

  /**
   * Get a list of all available clients for debugging purposes
   */
  async getAvailableClients(): Promise<string[]> {
    try {
      // Get all server configs directly from storage
      const configs = await this.loadServerConfigs();
      
      if (!configs || 'error' in configs) {
        log.warn('getAvailableClients: Failed to load server configs:', configs?.error);
        return [];
      }
      
      // Get the status of each server
      const serverStatuses = await Promise.all(
        (configs as MCPServerConfig[]).map(async (config: MCPServerConfig) => {
          try {
            const status = await this.getServerStatus(config.name);
            return {
              name: config.name,
              status: typeof status === 'string' ? status : status.status,
              connected: typeof status === 'string' ? 
                status === 'connected' : 
                status.status === 'connected'
            };
          } catch (error) {
            log.warn(`getAvailableClients: Error getting status for ${config.name}:`, error);
            return { name: config.name, status: 'error', connected: false };
          }
        })
      );
      
      // Return a formatted list of clients with their status
      return serverStatuses.map((s: { name: string, status: string }) => `${s.name} (${s.status})`);
    } catch (error) {
      log.error('getAvailableClients: Error getting available clients:', error);
      return [];
    }
  }
}

// Create and export the singleton instance for use in other server components
export const mcpService = new MCPService();
