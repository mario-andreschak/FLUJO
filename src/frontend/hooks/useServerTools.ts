import { useState, useEffect, useCallback, useRef } from 'react';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';
import type { MCPToolResponse } from '@/shared/types/mcp';

// Create a logger instance for this file
const log = createLogger('frontend/hooks/useServerTools');

interface ToolTestResult {
  success: boolean;
  output: string;
  error?: string;
}

export type ServerTool = Omit<MCPToolResponse, 'description'> & { description: string };

/**
 * Custom hook for managing server tools
 * 
 * This version includes server tracking and retry functionality
 * to ensure tools are always displayed for the correct server.
 */
export function useServerTools(serverName: string | null) {
  const [tools, setTools] = useState<ServerTool[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolsServerName, setToolsServerName] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const selectedServerRef = useRef(serverName);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const lastRefreshRef = useRef<{
    serverName: string;
    timestamp: number;
    toolCount: number;
  } | null>(null);

  // Invalidate requests as soon as a render selects a different server. This
  // prevents a completion from an earlier A -> B -> A request from taking
  // ownership again just because the server names happen to match.
  if (selectedServerRef.current !== serverName) {
    selectedServerRef.current = serverName;
    requestGenerationRef.current += 1;
    lastRefreshRef.current = null;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, []);

  /**
   * Load tools for the specified server
   */
  const loadTools = useCallback(async (force: boolean = false) => {
    const requestedServer = serverName;
    if (selectedServerRef.current !== requestedServer) return;

    if (!requestedServer) {
      setTools([]);
      setToolsServerName(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const lastRefresh = lastRefreshRef.current;
    if (
      !force
      && lastRefresh?.serverName === requestedServer
      && Date.now() - lastRefresh.timestamp < 200
      && lastRefresh.toolCount > 0
    ) {
      log.debug(`Rate limiting tool refresh for server: ${requestedServer}`);
      return;
    }

    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    setIsRetrying(false);

    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    const ownsRequest = () => (
      mountedRef.current
      && selectedServerRef.current === requestedServer
      && requestGenerationRef.current === requestGeneration
    );

    if (force) mcpService.clearToolsCache(requestedServer);
    lastRefreshRef.current = null;

    log.debug(`Loading tools for server: ${requestedServer}`);
    setIsLoading(true);
    setTools([]);
    setToolsServerName(null);
    setError(null);

    try {
      const result = await mcpService.listServerTools(requestedServer);

      if (!ownsRequest()) {
        log.debug(`Ignoring stale tool load for server: ${requestedServer}`);
        return;
      }

      if (result.error) {
        log.warn(`Error loading tools for ${requestedServer}:`, result.error);
        setError(result.error);
        setTools([]);
        setToolsServerName(null);
      } else {
        const toolsArray: ServerTool[] = (result.tools || []).map((tool: MCPToolResponse) => ({
          ...tool,
          description: tool.description || '',
        }));
        log.debug(`Loaded ${toolsArray.length} tools for ${requestedServer}`);
        setTools(toolsArray);
        setToolsServerName(requestedServer);
        lastRefreshRef.current = {
          serverName: requestedServer,
          timestamp: Date.now(),
          toolCount: toolsArray.length,
        };
        setRetryCount(0);
      }
    } catch (loadError) {
      if (!ownsRequest()) {
        log.debug(`Ignoring stale tool load failure for server: ${requestedServer}`);
        return;
      }

      log.warn(`Failed to load tools for server ${requestedServer}:`, loadError);
      setError(`Failed to load tools: ${loadError instanceof Error ? loadError.message : 'Unknown error'}`);
      setTools([]);
      setToolsServerName(null);
    } finally {
      if (ownsRequest()) setIsLoading(false);
    }
  }, [serverName]);

  /**
   * Retry loading tools with exponential backoff
   */
  const retryLoadTools = useCallback(() => {
    if (!serverName) return;
    const retryServerName = serverName;
    if (selectedServerRef.current !== retryServerName) return;

    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    const retryGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = retryGeneration;
    setIsRetrying(true);

    const backoff = Math.min(Math.pow(2, retryCount) * 1000, 10000);
    log.debug(`Retrying tool load for ${retryServerName} in ${backoff}ms (attempt ${retryCount + 1})`);

    retryTimeoutRef.current = setTimeout(() => {
      retryTimeoutRef.current = null;
      const ownsRetry = (
        mountedRef.current
        && selectedServerRef.current === retryServerName
        && requestGenerationRef.current === retryGeneration
      );
      if (!ownsRetry) return;

      setRetryCount(prev => prev + 1);
      setIsRetrying(false);
      void loadTools(true);
    }, backoff);

    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [serverName, retryCount, loadTools]);

  /**
   * Test a tool with the specified parameters
   */
  const testTool = useCallback(async (toolName: string, params: Record<string, unknown>, timeout?: number): Promise<ToolTestResult> => {
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

    setRetryCount(0);
    setIsRetrying(false);

    if (serverName) {
      void loadTools();
    } else {
      log.debug('Clearing tools as no server is selected');
      requestGenerationRef.current += 1;
      setTools([]);
      setToolsServerName(null);
      setError(null);
      setIsLoading(false);
    }
  }, [serverName, loadTools]);

  return {
    tools,
    toolsServerName,
    isLoading: isLoading || isRetrying,
    error,
    loadTools,
    retryLoadTools,
    isRetrying,
    retryCount,
    testTool
  };
}
