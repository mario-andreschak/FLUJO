import { useState, useEffect, useCallback } from 'react';
import { mcpService } from '@/frontend/services/mcp';
import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig, EnvVarValue } from '@/shared/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/hooks/useServerStatus');

// Type guard to check if a config is a StdioConfig
function isStdioConfig(config: MCPServerConfig): config is MCPStdioConfig {
  return config.transport === 'stdio';
}

// Type guard to check if a config is a WebSocketConfig
function isWebSocketConfig(config: MCPServerConfig): config is MCPWebSocketConfig {
  return config.transport === 'websocket';
}

// Define ServerState as an intersection type instead of extending MCPServerConfig 
// but with the updated environment variable type
type ServerState = Omit<MCPServerConfig, 'env'> & {
  status: 'connected' | 'disconnected' | 'error' | 'connecting' | 'starting';
  path: string;
  error?: string;
  stderrOutput?: string;
  env: Record<string, EnvVarValue>;
};

/**
 * Custom hook for managing server status
 * 
 * This simplified version focuses on providing a clean interface for server management
 * without complex state management or caching.
 */
export function useServerStatus() {
  const [servers, setServers] = useState<ServerState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectingServers, setConnectingServers] = useState<Set<string>>(new Set());

  /**
   * Load server configurations from the service
   */
  const loadServers = useCallback(async () => {
    log.debug('Loading servers');
    setIsLoading(true);
    setLoadError(null);
    
    try {
      // Step 1: Load server configurations
      const configs = await mcpService.loadServerConfigs();

      if (!configs || 'error' in configs) {
        log.warn('Failed to load server configurations:', configs?.error);
        setLoadError(configs?.error || 'Failed to load server configurations');
        setIsLoading(false);
        return;
      }

      // Step 2: Get the current status of all servers
      const serverStates = await Promise.all(
        configs.map(async (config: MCPServerConfig) => {
          log.debug(`Getting status for server: ${config.name}`);
          const statusData = await mcpService.getServerStatus(config.name);
          const status = typeof statusData === 'string' ? statusData : statusData.status;
          const errorMessage = typeof statusData === 'object' && statusData.message ? statusData.message : undefined;
          const stderrOutput = typeof statusData === 'object' && statusData.stderrOutput ? statusData.stderrOutput : undefined;

          // Get the path based on the server type
          const path = isStdioConfig(config) 
            ? (config.args && config.args.length > 0 ? config.args[0] : 'Unknown path') 
            : config.websocketUrl || 'Unknown URL';
            
          return {
            ...config,
            path,
            status: status as 'connected' | 'disconnected' | 'error' | 'starting',
            error: errorMessage,
            stderrOutput,
          };
        })
      );

      log.debug('Final server states:', serverStates);
      setServers(serverStates);
      setIsLoading(false);
    } catch (error) {
      log.warn('Failed to load servers:', error);
      setLoadError('Failed to load servers');
      setIsLoading(false);
    }
  }, []);

  /**
   * Toggle server enabled/disabled state
   */
  const toggleServer = useCallback(async (serverName: string, enabled: boolean) => {
    log.debug(`Toggling server ${serverName} to ${enabled ? 'enabled' : 'disabled'}`);
    try {
      const server = servers.find((s) => s.name === serverName);
      if (!server) {
        log.warn(`Server not found: ${serverName}`);
        return false;
      }
      
      log.debug(`Found server ${serverName}, current disabled state: ${server.disabled}`);
      
      // Update the server config in the backend
      const updateResult = await mcpService.updateServerConfig(serverName, { disabled: !enabled });
      if (updateResult.error) {
        log.warn('Failed to update server config:', [ updateResult.error, serverName ]);
        return false;
      }
      
      // Config update was successful, update the UI immediately
      log.debug(`Updating server ${serverName} state in UI, new disabled state: ${!enabled}`);
      setServers((prev) =>
        prev.map((s) =>
          s.name === serverName
            ? { 
                ...s, 
                disabled: !enabled
              }
            : s
        )
      );
      
      log.info(`Successfully toggled server ${serverName} to ${enabled ? 'enabled' : 'disabled'}`);
      
      // Get the updated status separately - this doesn't affect toggle success
      try {
        const statusData = await mcpService.getServerStatus(serverName);
        const status = typeof statusData === 'string' ? statusData : statusData.status;
        const errorMessage = typeof statusData === 'object' && statusData.message ? statusData.message : undefined;
        const stderrOutput = typeof statusData === 'object' && statusData.stderrOutput ? statusData.stderrOutput : undefined;

        // Update the UI with the new status
        setServers((prev) =>
          prev.map((s) =>
            s.name === serverName
              ? { 
                  ...s, 
                  status: status as 'connected' | 'disconnected' | 'error' | 'starting', 
                  error: errorMessage,
                  stderrOutput
                }
              : s
          )
        );
      } catch (statusError) {
        // Even if getting status fails, the toggle was still successful
        log.warn(`Failed to get status for server ${serverName} after toggle:`, statusError);
      }
      
      return true;
    } catch (error) {
      log.warn('Failed to toggle server:', error);
      return false;
    }
  }, [servers]);

  /**
   * Delete a server
   */
  const deleteServer = useCallback(async (serverName: string) => {
    log.debug(`Deleting server: ${serverName}`);
    try {
      const server = servers.find((s) => s.name === serverName);
      if (!server) {
        log.warn('Server not found:', serverName);
        return false;
      }
      
      // Remove from persistent storage
      const deleteResult = await mcpService.deleteServerConfig(serverName);
      if(deleteResult.error){
        log.warn('Failed to delete server config:', deleteResult.error);
        return false;
      }
      
      setServers((prev) => prev.filter((server) => server.name !== serverName));
      return true;
    } catch (error) {
      log.warn('Failed to delete server:', error);
      return false;
    }
  }, [servers]);

  /**
   * Add a new server
   */
  const addServer = useCallback(async (config: MCPServerConfig) => {
    log.debug('Adding server:', config);
    try {
      // First add the server with a connecting status
      // Get the path based on the server type
      const path = isStdioConfig(config) 
        ? (config.args && config.args.length > 0 ? config.args[0] : 'Unknown path') 
        : config.websocketUrl || 'Unknown URL';
        
      const newServer = {
        ...config,
        path,
        status: 'connecting' as const,
        tools: [],
        env: config.env || {},
      };
      
      setServers((prev) => [...prev, newServer]);
      
      // Mark this server as connecting
      setConnectingServers(prev => new Set(prev).add(config.name));
      
      // Update the server config in the backend
      const updateResult = await mcpService.updateServerConfig(config.name, config);
      if (updateResult.error) {
        log.warn('Failed to update server config:', updateResult.error);
        // Update the server with error status
        setServers((prev) =>
          prev.map((s) =>
            s.name === config.name
              ? { ...s, status: 'error', error: updateResult.error }
              : s
          )
        );
        
        // Remove from connecting servers
        setConnectingServers(prev => {
          const newSet = new Set(prev);
          newSet.delete(config.name);
          return newSet;
        });
        
        return false;
      }
      
      // Config update was successful, update the UI
      log.info(`Successfully added server ${config.name}`);
      
      // Get the server status separately - this doesn't affect add success
      try {
        const statusData = await mcpService.getServerStatus(config.name);
        const status = typeof statusData === 'string' ? statusData : statusData.status;
        const errorMessage = typeof statusData === 'object' && statusData.message ? statusData.message : undefined;
        const stderrOutput = typeof statusData === 'object' && statusData.stderrOutput ? statusData.stderrOutput : undefined;
        
        // Update the server with the latest status
        setServers((prev) =>
          prev.map((s) =>
            s.name === config.name
              ? { 
                  ...s, 
                  status: status as 'connected' | 'disconnected' | 'error' | 'starting', 
                  error: errorMessage,
                  stderrOutput
                }
              : s
          )
        );
      } catch (statusError) {
        // Even if getting status fails, the server add was still successful
        log.warn(`Failed to get status for server ${config.name} after adding:`, statusError);
      }
      
      // Remove from connecting servers
      setConnectingServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(config.name);
        return newSet;
      });
      
      return true;
    } catch (error) {
      log.warn('Failed to add server:', error);
      // Update the server with error status if it exists in the list
      setServers((prev) =>
        prev.map((s) =>
          s.name === config.name
            ? { 
                ...s, 
                status: 'error', 
                error: error instanceof Error ? error.message : 'Unknown error during server addition'
              }
            : s
        )
      );
      
      // Remove from connecting servers
      setConnectingServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(config.name);
        return newSet;
      });
      
      return false;
    }
  }, []);

  /**
   * Update a server configuration
   */
  const updateServer = useCallback(async (config: MCPServerConfig) => {
    log.debug('Updating server:', config);
    try {
      // First, update the UI with the new configuration immediately
      setServers((prev) =>
        prev.map((server) =>
          server.name === config.name
            ? {
                ...config,
                path: isStdioConfig(config) 
                  ? (config.args && config.args.length > 0 ? config.args[0] : 'Unknown path') 
                  : config.websocketUrl || 'Unknown URL',
                status: server.status, // Keep current status until we know more
                error: server.error, // Keep current error until we know more
                stderrOutput: server.stderrOutput
              }
            : server
        )
      );
      
      // Now update the server config in the backend
      const updateResult = await mcpService.updateServerConfig(config.name, config);
      if (updateResult.error) {
        log.warn('Failed to update server config:', updateResult.error);
        // Update the UI to show the error
        setServers((prev) =>
          prev.map((server) =>
            server.name === config.name
              ? { ...server, status: 'error', error: updateResult.error }
              : server
          )
        );
        return false;
      }
      
      // Config update was successful, regardless of connection status
      log.info(`Successfully updated config for server ${config.name}`);
      
      // Get the updated status separately - this doesn't affect config update success
      try {
        const statusData = await mcpService.getServerStatus(config.name);
        const status = typeof statusData === 'string' ? statusData : statusData.status;
        const errorMessage = typeof statusData === 'object' && statusData.message ? statusData.message : undefined;
        const stderrOutput = typeof statusData === 'object' && statusData.stderrOutput ? statusData.stderrOutput : undefined;
  
        // Update the UI with the new status
        setServers((prev) =>
          prev.map((server) =>
            server.name === config.name
              ? { 
                  ...server, 
                  status: status as 'connected' | 'disconnected' | 'error' | 'starting', 
                  error: errorMessage,
                  stderrOutput
                }
              : server
          )
        );
      } catch (statusError) {
        // Even if getting status fails, the config update was still successful
        log.warn(`Failed to get status for server ${config.name} after config update:`, statusError);
      }
      
      // Return true because the config update succeeded
      return true;
    } catch (error) {
      log.warn('Failed to update server:', error);
      // Update the UI to show the error
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during update';
      setServers((prev) =>
        prev.map((server) =>
          server.name === config.name
            ? { ...server, status: 'error', error: errorMessage }
            : server
        )
      );
      return false;
    }
  }, []);

  /**
   * Save environment variables for a server
   */
  const saveEnv = useCallback(async (
    serverName: string, 
    env: Record<string, { value: string, metadata: { isSecret: boolean } } | string>
  ) => {
    log.debug(`Saving environment variables for server: ${serverName}`, env);
    try {
      const server = servers.find((s) => s.name === serverName);
      if (!server) {
        log.warn(`Server not found: ${serverName}`);
        return false;
      }
      
      const updateResult = await mcpService.updateServerConfig(serverName, { env });
      if(updateResult.error){
        log.warn('Failed to update server config:', updateResult.error);
        return false;
      }
      
      log.debug(`Updating environment variables in UI for server: ${serverName}`);
      setServers((prev) =>
        prev.map((server) => (server.name === serverName ? { ...server, env } : server))
      );
      
      log.info(`Successfully saved environment variables for server: ${serverName}`);
      return true;
    } catch (error) {
      log.warn('Failed to save environment variables:', error);
      return false;
    }
  }, [servers]);

  // Load servers when the hook is first used
  useEffect(() => {
    loadServers();
  }, [loadServers]);

  /**
   * Retry getting server status
   */
  const retryServer = useCallback(async (serverName: string) => {
    log.debug(`Retrying server status for: ${serverName}`);
    try {
      const statusData = await mcpService.getServerStatus(serverName);
      const status = typeof statusData === 'string' ? statusData : statusData.status;
      const errorMessage = typeof statusData === 'object' && statusData.message ? statusData.message : undefined;
      const stderrOutput = typeof statusData === 'object' && statusData.stderrOutput ? statusData.stderrOutput : undefined;
      
      setServers((prev) =>
        prev.map((s) =>
          s.name === serverName
            ? { 
                ...s, 
                status: status as 'connected' | 'disconnected' | 'error' | 'starting', 
                error: errorMessage,
                stderrOutput
              }
            : s
        )
      );
      return true;
    } catch (error) {
      log.warn('Failed to retry server status:', error);
      return false;
    }
  }, []);

  return {
    servers,
    isLoading,
    loadError,
    connectingServers,
    loadServers,
    toggleServer,
    retryServer,
    deleteServer,
    addServer,
    updateServer,
    saveEnv
  };
}
