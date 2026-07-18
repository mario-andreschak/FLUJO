'use client';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPServerConfig } from '@/shared/types/mcp';
import { TestConnectionEvent } from '@/shared/types/streaming';
import { readNdjsonStream } from '@/frontend/utils/ndjsonReader';
import { createLogger } from '@/utils/logger';
import { FEATURES } from '@/config/features'; // Import the feature flags

// Create a logger instance for this file
const log = createLogger('frontend/services/mcp/index');

/**
 * Simplified MCP Service
 * 
 * This service provides a clean interface to interact with MCP servers
 * through the backend API.
 */
class MCPService {
  // private clients: Map<string, Client> = new Map(); // Store connected clients for direct access
  
  // Cache for tools to improve performance and reduce API calls
  private toolsCache: Map<string, { tools: any[], timestamp: number }> = new Map();
  // #15: parallel caches for resources/prompts listings (same TTL/eviction as tools).
  private resourcesCache: Map<string, { data: any, timestamp: number }> = new Map();
  private promptsCache: Map<string, { prompts: any[], timestamp: number }> = new Map();
  private CACHE_TTL = 60000; // 1 minute cache TTL

  /**
   * Load server configurations from the backend
   */
  async loadServerConfigs() {
    try {
      const response = await fetch('/api/mcp/servers');
      const data = await response.json();

      if (!response.ok || (data && data.error)) {
        const error = (data && data.error) || 'Failed to load server configs';
        log.warn('Failed to load server configs:', error);
        return { error };
      }

      // GET /api/mcp/servers returns the configs array directly.
      return data;
    } catch (error) {
      log.warn('Failed to load server configs:', error);
      return { error: 'Failed to load server configs' };
    }
  }

  // The connectServer method has been removed as part of the design to prevent
  // frontend from explicitly starting MCP servers. Servers are now automatically
  // connected when their configuration is updated with disabled=false.

  /**
   * List tools available from an MCP server with caching
   */
  async listServerTools(serverName: string) {
    try {
      // Check cache first
      const cachedData = this.toolsCache.get(serverName);
      const now = Date.now();
      
      if (cachedData && (now - cachedData.timestamp < this.CACHE_TTL)) {
        log.debug(`Using cached tools for server ${serverName}`);
        return { tools: cachedData.tools };
      }
      
      // Cache miss or expired, fetch from server
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(serverName)}/tools`);
      const data = await response.json();
      
      if (data.error) {
        log.warn(`Error listing tools for server ${serverName}:`, data.error);
        return { tools: [], error: data.error };
      }
      
      // Ensure tools is always an array
      const tools = Array.isArray(data.tools) ? data.tools : [];
      
      // Update cache
      this.toolsCache.set(serverName, { tools, timestamp: now });
      
      return { tools };
    } catch (error) {
      log.warn(`Failed to list tools for server ${serverName}:`, error);
      return { 
        tools: [], 
        error: `Failed to list tools: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }
  
  /**
   * Clear the tools cache for a specific server or all servers
   */
  clearToolsCache(serverName?: string) {
    if (serverName) {
      this.toolsCache.delete(serverName);
      log.debug(`Cleared tools cache for server ${serverName}`);
    } else {
      this.toolsCache.clear();
      log.debug('Cleared all tools cache');
    }
  }

  /**
   * List resources and resource templates published by an MCP server (#15), with caching.
   * Returns `{ resources, resourceTemplates, error? }`.
   */
  async listServerResources(serverName: string) {
    try {
      const cached = this.resourcesCache.get(serverName);
      const now = Date.now();
      if (cached && now - cached.timestamp < this.CACHE_TTL) {
        log.debug(`Using cached resources for server ${serverName}`);
        return cached.data;
      }

      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(serverName)}/resources`);
      const data = await response.json();

      const result = {
        resources: Array.isArray(data.resources) ? data.resources : [],
        resourceTemplates: Array.isArray(data.resourceTemplates) ? data.resourceTemplates : [],
        error: data.error,
      };

      if (!result.error) {
        this.resourcesCache.set(serverName, { data: result, timestamp: now });
      }
      return result;
    } catch (error) {
      log.warn(`Failed to list resources for server ${serverName}:`, error);
      return {
        resources: [],
        resourceTemplates: [],
        error: `Failed to list resources: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Read a single resource's contents from an MCP server (#15).
   */
  async readResource(serverName: string, uri: string) {
    try {
      const response = await fetch(
        `/api/mcp/servers/${encodeURIComponent(serverName)}/resources/read?uri=${encodeURIComponent(uri)}`
      );
      return await response.json();
    } catch (error) {
      log.warn(`Failed to read resource ${uri} on server ${serverName}:`, error);
      return { success: false, error: `Failed to read resource` };
    }
  }

  /**
   * List prompt templates published by an MCP server (#15), with caching.
   */
  async listServerPrompts(serverName: string) {
    try {
      const cached = this.promptsCache.get(serverName);
      const now = Date.now();
      if (cached && now - cached.timestamp < this.CACHE_TTL) {
        log.debug(`Using cached prompts for server ${serverName}`);
        return { prompts: cached.prompts };
      }

      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(serverName)}/prompts`);
      const data = await response.json();

      if (data.error) {
        log.warn(`Error listing prompts for server ${serverName}:`, data.error);
        return { prompts: [], error: data.error };
      }

      const prompts = Array.isArray(data.prompts) ? data.prompts : [];
      this.promptsCache.set(serverName, { prompts, timestamp: now });
      return { prompts };
    } catch (error) {
      log.warn(`Failed to list prompts for server ${serverName}:`, error);
      return {
        prompts: [],
        error: `Failed to list prompts: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Fetch a prompt template expanded with arguments from an MCP server (#15).
   */
  async getPrompt(serverName: string, promptName: string, args?: Record<string, string>) {
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(serverName)}/prompts/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: promptName, arguments: args }),
      });
      return await response.json();
    } catch (error) {
      log.warn(`Failed to get prompt ${promptName} on server ${serverName}:`, error);
      return { success: false, error: `Failed to get prompt` };
    }
  }

  /**
   * Clear the resources/prompts caches for a specific server or all servers.
   */
  clearCapabilitiesCache(serverName?: string) {
    if (serverName) {
      this.resourcesCache.delete(serverName);
      this.promptsCache.delete(serverName);
    } else {
      this.resourcesCache.clear();
      this.promptsCache.clear();
    }
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverName: string, toolName: string, args: Record<string, any>, timeout?: number) {
    try {
      const response = await fetch(
        `/api/mcp/servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ args, timeout }),
        }
      );

      return await response.json();
    } catch (error) {
      log.warn(`Failed to call tool ${toolName} on server ${serverName}:`, error);
      return { error: `Failed to call tool` };
    }
  }

  /**
   * Update an MCP server configuration
   * 
   * This function updates the server configuration in the backend.
   * The update is considered successful if the config is saved correctly,
   * regardless of whether the server can connect with the new configuration.
   */
  async updateServerConfig(serverName: string, updates: Partial<MCPServerConfig>) {
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(serverName)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      });

      // PUT /api/mcp/{name} returns the updated config on success, or { error } on failure.
      const data = await response.json();

      if (response.ok) {
        log.info(`Successfully updated server config for ${serverName}`);
        return { success: true, data };
      }

      // Even if the server reports an error, we'll consider it a success for toggling.
      // This prevents the UI from showing an error when toggling a server that can't connect.
      if (updates.disabled !== undefined) {
        log.info(`Config update for ${serverName} treated as success for toggle operation`);
        return {
          success: true,
          data: { ...updates, name: serverName },
          _originalError: data.error, // Store the original error for debugging
        };
      }

      log.warn(`Failed to update server config for ${serverName}:`, data.error);
      return { success: false, error: data.error };
    } catch (error) {
      log.warn(`Failed to update server config for ${serverName}:`, error);
      return { error: 'Failed to update server config' };
    }
  }

  /**
   * Test a connection to an MCP server through the backend.
   *
   * This runs the real MCP handshake in the Next.js server process rather than the
   * browser, so it can reach servers behind custom CAs (system CA trust) and send the
   * configured custom headers (Authorization, X-SAP-*), which a browser fetch cannot.
   */
  async testConnection(config: MCPServerConfig, storedName?: string): Promise<{
    success: boolean;
    error?: string;
    requiresAuthentication?: boolean;
    data?: { toolCount?: number };
  }> {
    try {
      const response = await fetch('/api/mcp/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // storedName rides alongside the config so the backend can hydrate masked secret
        // headers from the saved config, even after a rename (#137).
        body: JSON.stringify({ ...config, storedName }),
      });

      return await response.json();
    } catch (error) {
      log.warn(`Failed to test connection for ${config.name}:`, error);
      return {
        success: false,
        error: `Failed to reach the FLUJO backend to run the connection test: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Streaming variant of {@link testConnection} (issue #64).
   *
   * Runs the same real MCP handshake through the backend, but consumes an NDJSON stream
   * so the caller can render the server's stderr and lifecycle markers in the console AS
   * THEY ARRIVE (a slow cold `npx`/`uvx` start no longer looks frozen). Each parsed event
   * is passed to `onEvent`; the promise resolves with the final `result` payload.
   *
   * Gracefully degrades: on a network error, a non-OK response, or a body that cannot be
   * streamed (e.g. a proxy that buffered it into a plain JSON blob), it falls back to the
   * non-streaming {@link testConnection} so the test still works.
   */
  async testConnectionStreaming(
    config: MCPServerConfig,
    onEvent: (event: TestConnectionEvent) => void,
    storedName?: string
  ): Promise<{
    success: boolean;
    error?: string;
    requiresAuthentication?: boolean;
    data?: { toolCount?: number };
  }> {
    try {
      const response = await fetch('/api/mcp/test-connection/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // storedName rides alongside the config so the backend can hydrate masked secret
        // headers from the saved config, even after a rename (#137).
        body: JSON.stringify({ ...config, storedName }),
      });

      if (!response.ok || !response.body) {
        log.warn(`Streaming test-connection unavailable (status ${response.status}); falling back`);
        return this.testConnection(config, storedName);
      }

      let result: {
        success: boolean;
        error?: string;
        requiresAuthentication?: boolean;
        data?: { toolCount?: number };
      } | null = null;

      await readNdjsonStream(response, (event) => {
        onEvent(event);
        if (event.type === 'result') {
          result = {
            success: event.success,
            error: event.error,
            requiresAuthentication: event.requiresAuthentication,
            data: event.data,
          };
        }
      });

      if (result) {
        return result;
      }

      // Stream ended without a terminal result event — treat as a failure so the caller
      // does not hang waiting for a success it will never get.
      log.warn('Streaming test-connection ended without a result event');
      return {
        success: false,
        error: 'The connection test stream ended unexpectedly without a result.',
      };
    } catch (error) {
      log.warn(`Streaming test connection failed for ${config.name}; falling back to non-streaming:`, error);
      return this.testConnection(config, storedName);
    }
  }

  /**
   * Get the current server status
   */
  async getServerStatus(serverName: string) {
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(serverName)}/status`, {
        headers: {
          'Accept': 'application/json',
        },
      });
      
      const data = await response.json();
      
      if (data.error) {
        log.warn(`Error getting status for server ${serverName}:`, data.error);
        return { status: 'error', message: data.error };
      }
      
      return data;
    } catch (error) {
      log.warn(`Failed to get status for server ${serverName}:`, error);
      return { 
        status: 'error', 
        message: `Failed to get server status: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Delete an MCP server configuration
   */
  async deleteServerConfig(serverName: string) {
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(serverName)}`, {
        method: 'DELETE',
      });

      return await response.json();
    } catch (error) {
      log.warn(`Failed to delete server config for ${serverName}:`, error);
      return { error: 'Failed to delete server config' };
    }
  }

  /**
   * Retry connecting to a server by refreshing its status
   * This could potentially make the backend connect to a server if it's not already connected
   */
  async retryServer(serverName: string) {
    log.debug(`Retrying server status for: ${serverName}`);
    return this.getServerStatus(serverName);
  }

  /**
   * Restart a server by toggling it off and then on again
   * This forces the backend to create a new server instance because the config changed
   */
  async restartServer(serverName: string) {
    log.debug(`Restarting server: ${serverName}`);
    
    try {
      // First disable the server
      const disableResult = await this.updateServerConfig(serverName, { disabled: true });
      if (disableResult.error) {
        log.warn(`Failed to disable server ${serverName} during restart:`, disableResult.error);
        return { error: `Failed to restart server: ${disableResult.error}` };
      }
      
      // Wait a short time for the disconnect to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Then enable the server again
      const enableResult = await this.updateServerConfig(serverName, { disabled: false });
      if (enableResult.error) {
        log.warn(`Failed to enable server ${serverName} during restart:`, enableResult.error);
        return { error: `Failed to restart server: ${enableResult.error}` };
      }
      
      log.info(`Successfully restarted server ${serverName}`);
      return { success: true };
    } catch (error) {
      log.warn(`Failed to restart server ${serverName}:`, error);
      return { 
        error: `Failed to restart server: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  // Server events functionality has been removed
}

export const mcpService = new MCPService();
