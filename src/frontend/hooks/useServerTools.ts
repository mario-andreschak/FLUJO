import { useState, useEffect, useCallback, useRef } from 'react';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';
import { sleep } from 'openai/core.mjs';

// Create a logger instance for this file
const log = createLogger('frontend/hooks/useServerTools');

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

interface ToolTestResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Custom hook for managing server tools
 * 
 * This version includes server tracking and retry functionality
 * to ensure tools are always displayed for the correct server.
 */
export function useServerTools(serverName: string | null) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [currentServerName, setCurrentServerName] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  /**
   * Load tools for the specified server
   */
  const loadTools = useCallback(async (force: boolean = false) => {
    if (!serverName) {
      setTools([]);
      setError(null);
      return;
    }

    // Update current server name
    setCurrentServerName(serverName);

    // Simple rate limiting to prevent excessive API calls
    if (
      !force && 
      lastRefresh && 
      (new Date().getTime() - lastRefresh.getTime() < 200) && 
      tools.length > 0 &&
      serverName === currentServerName // Only apply rate limiting if the server hasn't changed
    ) {
      log.debug(`Rate limiting tool refresh for server: ${serverName}`);
      return; // Return early to prevent the API call entirely
    }

    log.debug(`Loading tools for server: ${serverName}`);
    setIsLoading(true);
    setError(null);

    try {
      const result = await mcpService.listServerTools(serverName);
      
      // Check if the server name has changed while we were loading
      if (serverName !== currentServerName) {
        log.debug(`Server changed during tool loading from ${serverName} to ${currentServerName}`);
        return;
      }
      
      if (result.error) {
        log.warn(`Error loading tools for ${serverName}:`, result.error);
        setError(result.error);
        // Clear tools when there's an error to prevent showing tools from a previously selected server
        setTools([]);
      } else {
        // Ensure tools is always an array
        const toolsArray = result.tools || [];
        log.debug(`Loaded ${toolsArray.length} tools for ${serverName}`);
        setTools(toolsArray);
        setLastRefresh(new Date());
        // Reset retry count on success
        setRetryCount(0);
      }
    } catch (error) {
      // Check if the server name has changed while we were loading
      if (serverName !== currentServerName) {
        log.debug(`Server changed during tool loading from ${serverName} to ${currentServerName}`);
        return;
      }
      
      log.warn(`Failed to load tools for server ${serverName}:`, error);
      setError(`Failed to load tools: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Clear tools when there's an exception to prevent showing tools from a previously selected server
      setTools([]);
    } finally {
      // Only update loading state if this is still the current server
      if (serverName === currentServerName) {
        setIsLoading(false);
      }
    }
  }, [serverName, lastRefresh, tools.length, currentServerName]);

  /**
   * Retry loading tools with exponential backoff
   */
  const retryLoadTools = useCallback(() => {
    if (!serverName) return;
    
    // Clear any existing timeout
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    
    setIsRetrying(true);
    
    // Calculate backoff time (exponential with max of 10 seconds)
    const backoff = Math.min(Math.pow(2, retryCount) * 1000, 10000);
    log.debug(`Retrying tool load for ${serverName} in ${backoff}ms (attempt ${retryCount + 1})`);
    
    // Set timeout for retry
    retryTimeoutRef.current = setTimeout(() => {
      setRetryCount(prev => prev + 1);
      loadTools(true);
      setIsRetrying(false);
    }, backoff);
    
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, [serverName, retryCount, loadTools]);

  /**
   * Test a tool with the specified parameters
   */
  const testTool = useCallback(async (toolName: string, params: Record<string, any>, timeout?: number): Promise<ToolTestResult> => {
    if (!serverName) {
      return {
        success: false,
        output: '',
        error: 'No server selected'
      };
    }

    log.debug(`Testing tool ${toolName} on server ${serverName} with params:`, params);
    
    try {
      const response = await mcpService.callTool(serverName, toolName, params, timeout);
      
      if (response.error) {
        log.warn(`Error calling tool ${toolName}:`, response.error);
        return {
          success: false,
          output: '',
          error: response.error,
        };
      }
      
      log.debug(`Tool ${toolName} executed successfully:`, response);
      return {
        success: true,
        output: JSON.stringify(response, null, 2),
      };
    } catch (error) {
      log.error(`Exception calling tool ${toolName}:`, error);
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }, [serverName]);

  // Load tools when the server name changes
  useEffect(() => {
    log.debug(`Server name changed to: ${serverName || 'null'}`);
    
    // Clear any existing retry timeout
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    
    // Reset retry count when server changes
    setRetryCount(0);
    setIsRetrying(false);
    
    if (serverName) {
      // Update current server name immediately
      setCurrentServerName(serverName);
      loadTools();
    } else {
      log.debug('Clearing tools as no server is selected');
      setTools([]);
      setError(null);
      setCurrentServerName(null);
    }
  }, [serverName, loadTools]);

  return {
    tools,
    isLoading: isLoading || isRetrying,
    error,
    loadTools,
    retryLoadTools,
    isRetrying,
    retryCount,
    testTool
  };
}
