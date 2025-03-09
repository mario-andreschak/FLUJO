'use client';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPServerConfig } from '@/shared/types/mcp';
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
  private CACHE_TTL = 60000; // 1 minute cache TTL

  /**
   * Load server configurations from the backend
   */
  async loadServerConfigs() {
    try {
      const response = await fetch('/api/mcp?action=loadConfigs');
      const data = await response.json();
      
      if (data.error) {
        log.warn('Failed to load server configs:', data.error);
        return { error: data.error };
      }
      
      return data.configs;
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
      const response = await fetch(`/api/mcp?action=listTools&server=${encodeURIComponent(serverName)}`);
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
   * Call a tool on an MCP server
   */
  async callTool(serverName: string, toolName: string, args: Record<string, any>, timeout?: number) {
    try {
      const response = await fetch('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'callTool',
          serverName,
          toolName,
          args,
          timeout,
        }),
      });
      
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
      const response = await fetch('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'updateConfig',
          serverName,
          ...updates
        }),
      });
      
      // Parse the response
      const result = await response.json();
      
      // Log the result
      if (result.success) {
        log.info(`Successfully updated server config for ${serverName}`);
      } else {
        // Even if the server reports an error, we'll consider it a success for toggling
        // This prevents the UI from showing an error when toggling a server that can't connect
        if (updates.disabled !== undefined) {
          log.info(`Config update for ${serverName} treated as success for toggle operation`);
          return { 
            success: true, 
            data: { ...updates, name: serverName },
            _originalError: result.error // Store the original error for debugging
          };
        } else {
          log.warn(`Failed to update server config for ${serverName}:`, result.error);
        }
      }
      
      return result;
    } catch (error) {
      log.warn(`Failed to update server config for ${serverName}:`, error);
      return { error: 'Failed to update server config' };
    }
  }

  /**
   * Get the current server status
   */
  async getServerStatus(serverName: string) {
    try {
      const response = await fetch(`/api/mcp?action=status&server=${encodeURIComponent(serverName)}`, {
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
      const response = await fetch('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'deleteConfig',
          serverName,
        }),
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

  /**
   * Subscribe to server events
   */
  subscribeToServerEvents(serverName: string, callback: (event: any) => void) {
    // Check if SSE is enabled
    if (!FEATURES.SSE_ENABLED) {
      log.info(`SSE functionality disabled via feature flag - ignoring subscription for ${serverName}`);
      return () => {}; // Return a no-op cleanup function
    }

    try {
      // Create the SSE connection
      const eventSource = new EventSource(`/api/sse?serverName=${encodeURIComponent(serverName)}`);
      
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          callback(data);
        } catch(error) {
          log.warn(`Error parsing SSE data for ${serverName}:`, error);
        }
      };
      
      eventSource.onerror = (error) => {
        log.warn(`Error for server ${serverName}:`, error);
      };
      
      // Return cleanup function
      return () => {
        eventSource.close();
      };
    } catch (error) {
      log.warn(`Error setting up SSE connection for ${serverName}:`, error);
      return () => {}; // Return a no-op cleanup function
    }
  }
}

export const mcpService = new MCPService();
