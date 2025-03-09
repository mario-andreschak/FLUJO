import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';

// Global recovery map to persist clients across hot reloads
declare global {
  // eslint-disable-next-line no-var
  var __mcp_recovery: Map<string, Client> | undefined;
}

// Initialize the global recovery map if it doesn't exist
if (typeof global.__mcp_recovery === 'undefined') {
  global.__mcp_recovery = new Map<string, Client>();
}

// Import from backend modules
import { MCPServerConfig, MCPServiceResponse, MCPToolResponse as ToolResponse } from '@/shared/types/mcp';
import { loadServerConfigs, saveConfig } from './config';
import { listServerTools as listTools, callTool as callToolFunction } from './tools';
import {
  enhanceConnectionErrorMessage,
  formatErrorResponse
} from '@/utils/mcp/utils';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import {
  createNewClient,
  createTransport,
  shouldRecreateClient,
  safelyCloseClient
} from './connection';

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
  private isBackendStartingUp: boolean = true; // Flag to track backend startup state - true by default
  private recover_attempted: boolean = false; // Flag to track if recovery has been attempted
  
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
   * Check if the backend is currently starting up
   */
  isStartingUp(): boolean {
    return this.isBackendStartingUp;
  }
  
  /**
   * Set the backend startup state
   */
  private setStartingUp(value: boolean): void {
    this.isBackendStartingUp = value;
    log.info(`Backend startup state set to: ${value ? 'starting' : 'complete'}`);
  }

  /**
   * Get a client by server name
   */
  getClient(serverName: string): Client | undefined {
    // If recovery hasn't been attempted yet, try to recover
    if (!this.recover_attempted) {
      log.debug(`getClient: Recovery not yet attempted, trying to recover clients`);
      this.attemptRecovery();
    }
    
    const client = this.clients.get(serverName);
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
   * Connect to an MCP server by name
   */
  async connectServer(serverName: string): Promise<MCPServiceResponse>;
  
  /**
   * Connect to an MCP server using a configuration object
   */
  async connectServer(config: MCPServerConfig): Promise<MCPServiceResponse>;
  
  /**
   * Implementation of connectServer that handles both parameter types
   */
  async connectServer(configOrName: MCPServerConfig | string): Promise<MCPServiceResponse> {
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
    
    const requestId = uuidv4();
    log.info(`connectServer: Starting connection for server ${config.name} [RequestID: ${requestId}]`);
    
    try {
      // Clear any previous stderr logs for this server
      this.stderrLogs.set(config.name, []);

      // Check if we already have a client for this server
      let client = this.clients.get(config.name);
      
      // If we already have a client, return success
      if (client) {
        log.info(`connectServer: Server ${config.name} is already connected`);
        return { success: true };
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
          
          // Store stderr logs
          const logs = this.stderrLogs.get(serverName) || [];
          logs.push(stderrMessage);
          this.stderrLogs.set(serverName, logs);
        });
      }

      // Connect and register event handlers
      await client.connect(transport);

      transport.onclose = () => {
        log.warn(`connectServer: Connection closed for server ${config.name}`);
        this.clients.delete(config.name);
        
        // Remove from global recovery map when connection is closed
        this.removeFromGlobalRecovery(config.name);
      };

      transport.onerror = (error) => {
        log.error(`connectServer: Transport error for server ${config.name}:`, error);
      };

      // Store the new client
      this.clients.set(config.name, client);
      
      // Add to global recovery map
      this.addToGlobalRecovery(config.name, client);
      
      log.info(`connectServer: Successfully connected to ${config.name}`);
      return { success: true };
    } catch (error) {
      log.error(`connectServer: Failed to connect to server ${config.name}:`, error);
      const stderrLogs = this.stderrLogs.get(config.name) || [];
      const errorMessage = enhanceConnectionErrorMessage(error, config, stderrLogs);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectServer(serverName: string): Promise<MCPServiceResponse> {
    log.debug(`disconnectServer: Entering method for server ${serverName}`);
    
    const client = this.clients.get(serverName);
    if (!client) {
      log.warn(`disconnectServer: Server ${serverName} not found in clients map`);
      return { success: false, error: `Server ${serverName} not found` };
    }

    try {
      await client.close();
      this.clients.delete(serverName);
      
      // Remove from global recovery map
      this.removeFromGlobalRecovery(serverName);
      
      log.info(`disconnectServer: Disconnected server ${serverName}`);
      return { success: true };
    } catch (error) {
      log.warn(`disconnectServer: Failed to disconnect server ${serverName}:`, error);
      // Even if close fails, remove the client from our map
      this.clients.delete(serverName);
      
      // Remove from global recovery map
      this.removeFromGlobalRecovery(serverName);
      
      return {
        success: false,
        error: `Failed to disconnect server: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * List tools available from an MCP server
   */
  async listServerTools(serverName: string): Promise<{ tools: ToolResponse[], error?: string }> {
    log.debug(`listServerTools: Entering method for server ${serverName}`);
    
    const client = this.clients.get(serverName);
    if (!client) {
      log.warn(`listServerTools: Client not found for ${serverName}`);
    }
    
    const result = await listTools(client, serverName);
    
    if (result.error) {
      log.warn(`listServerTools: Error listing tools for ${serverName}:`, result.error);
    } else {
      log.info(`listServerTools: Listed ${result.tools.length} tools for ${serverName}`);
    }
    
    return result;
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverName: string, toolName: string, args: ToolArgs, timeout?: number): Promise<MCPServiceResponse> {
    log.debug(`callTool: Entering method for server ${serverName}, tool ${toolName}`);
    
    const client = this.clients.get(serverName);
    if (!client) {
      log.warn(`callTool: Client not found for ${serverName}`);
    }
    
    const result = await callToolFunction(client, serverName, toolName, args, timeout);
    log.info(`callTool: Called tool ${toolName} on ${serverName}`);
    
    return result;
  }

  /**
   * Update an MCP server configuration
   */
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

    // Update the config with the new values (including resolved env variables)
    let updatedConfig: MCPServerConfig = { ...config };
    updatedConfig = {
      ...config,
      ...updates,
    } as MCPServerConfig;

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

    // Handle connection state based on config changes
    await this.handleConnectionStateChange(serverName, updatedConfig);

    log.info(`updateServerConfig: Successfully updated config for ${serverName}`);
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
    
    const isCurrentlyConnected = this.clients.has(serverName);
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
    }
    // No reconnection logic for already connected servers
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
    // If backend is starting up, return a special status
    if (this.isBackendStartingUp) {
      log.debug(`getServerStatus: Backend is starting up, returning 'starting' status for ${serverName}`);
      return { 
        status: 'initialization', 
        message: 'Backend is currently initializing. Please wait...' 
      };
    }
    
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

    // Get any stderr logs for this server
    const stderrLogs = this.stderrLogs.get(serverName) || [];
    const stderrOutput = stderrLogs.join('\n').trim();

    // Check if the client exists in our map
    const clientExists = this.clients.has(serverName);

    if (clientExists) {
      log.info(`getServerStatus: Server ${serverName} is connected`);
      return {
        status: 'connected',
        stderrOutput: stderrOutput || undefined
      };
    } else {
      // If we have stderr output, use it as the primary error message
      if (stderrOutput) {
        log.info(`getServerStatus: Using stderr output as error message for ${serverName}`);
        return {
          status: 'error',
          message: stderrOutput,
          stderrOutput: stderrOutput
        };
      } else {
        // The server is configured but not connected
        log.info(`getServerStatus: No stderr output available for ${serverName}`);
        return {
          status: 'error',
          message: `Server ${serverName} is configured but not connected. The server process may have crashed or been terminated.`,
          stderrOutput: undefined
        };
      }
    }
  }

  /**
   * Start all enabled servers
   */
  async startEnabledServers(): Promise<void> {
    log.info('Starting all enabled servers');
    
    try {
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
      
      // Connect each enabled server
      for (const config of enabledServers) {
        try {
          log.info(`Starting server: ${config.name}`);
          await this.connectServer(config);
        } catch (error) {
          log.error(`Failed to start server ${config.name}:`, error);
          // Continue with other servers even if one fails
        }
      }
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
