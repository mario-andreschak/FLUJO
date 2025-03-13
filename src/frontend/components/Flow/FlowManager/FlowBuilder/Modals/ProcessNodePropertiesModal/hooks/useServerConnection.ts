import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import { Flow } from '@/frontend/types/flow/flow';
import { MCPServerConfig } from '@/shared/types/mcp';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useServerConnection');

/**
 * Custom hook for managing MCP server connections in the Process Node Properties Modal
 * 
 * This version fetches tools from the servers and filters them based on what's enabled in the MCP nodes.
 */
const useServerConnection = (open: boolean, node: Flow['nodes'][number] | null, flowEdges: Flow['edges'], flowNodes: Flow['nodes']) => {
  // Get all server status using the hook
  const serverStatus = useServerStatus();
  const allServers = serverStatus.servers || [];
  const isLoadingServers = serverStatus.isLoading || false;
  
  const [serverStatuses, setServerStatuses] = useState<Record<string, string>>({});
  const [serverToolsMap, setServerToolsMap] = useState<Record<string, any[]>>({});
  const [isLoadingTools, setIsLoadingTools] = useState<Record<string, boolean>>({});
  const [selectedToolServer, setSelectedToolServer] = useState<string | null>(null);
  const [isLoadingSelectedServerTools, setIsLoadingSelectedServerTools] = useState(false);
  
  // Find connected MCP nodes
  const connectedNodeIds = useMemo(() => {
    return node ? findConnectedMCPNodes(node.id, flowEdges) : [];
  }, [node, flowEdges]);

  // Filter servers to only show those connected to this Process node
  const connectedServers = useMemo(() => {
    if (!node || connectedNodeIds.length === 0) return [];
    
    // Ensure flowNodes is defined and is an array
    if (!flowNodes || !Array.isArray(flowNodes)) {
      log.warn('flowNodes is not available or not an array when filtering connected servers');
      return [];
    }

    try {
      return allServers.filter((server: MCPServerConfig & { status: string }) =>
        connectedNodeIds.some(nodeId => {
          try {
            const mcpNode = flowNodes.find(n => n && n.id === nodeId);
            return mcpNode && 
                   mcpNode.data && 
                   mcpNode.data.properties && 
                   mcpNode.data.properties.boundServer === server.name;
          } catch (error) {
            log.error(`Error finding MCP node with ID ${nodeId}:`, error);
            return false;
          }
        })
      );
    } catch (error) {
      log.error('Error filtering connected servers:', error);
      return [];
    }
  }, [node, connectedNodeIds, allServers, flowNodes]);

  // Update server statuses when servers change
  useEffect(() => {
    if (connectedServers && connectedServers.length > 0) {
      const statuses: Record<string, string> = {};
      connectedServers.forEach((server: MCPServerConfig & { status: string }) => {
        statuses[server.name] = server.status;
      });
      setServerStatuses(statuses);
    }
  }, [connectedServers]);

  // Load tools for all connected servers when the modal is opened
  useEffect(() => {
    if (open && connectedServers.length > 0) {
      loadAllServerTools();
    }
  }, [open, connectedServers]);

  // Load tools for all connected servers
  const loadAllServerTools = useCallback(async () => {
    if (!connectedServers || connectedServers.length === 0) return;
    
    const newIsLoadingTools: Record<string, boolean> = {};
    const newServerToolsMap: Record<string, any[]> = { ...serverToolsMap };
    
    // Set loading state for all servers
    connectedServers.forEach((server: MCPServerConfig & { status: string }) => {
      if (server.status === 'connected') {
        newIsLoadingTools[server.name] = true;
      }
    });
    
    setIsLoadingTools(newIsLoadingTools);
    
    // Load tools for each connected server
    for (const server of connectedServers) {
      if (server.status === 'connected') {
        try {
          log.debug(`Loading tools for server: ${server.name}`);
          const result = await mcpService.listServerTools(server.name);
          
          if (result.error) {
            log.warn(`Error loading tools for ${server.name}:`, result.error);
          } else {
            // Ensure tools is always an array
            const toolsArray = result.tools || [];
            log.debug(`Loaded ${toolsArray.length} tools for ${server.name}`);
            newServerToolsMap[server.name] = toolsArray;
          }
        } catch (error) {
          log.warn(`Failed to load tools for server ${server.name}:`, error);
        } finally {
          // Update loading state for this server
          newIsLoadingTools[server.name] = false;
        }
      }
    }
    
    setServerToolsMap(newServerToolsMap);
    setIsLoadingTools(newIsLoadingTools);
  }, [connectedServers, serverToolsMap]);

  // Handle selecting a tool server
  const handleSelectToolServer = useCallback((serverName: string) => {
    setSelectedToolServer(serverName);
    
    // If we haven't loaded tools for this server yet, load them now
    if (serverName && !serverToolsMap[serverName]) {
      setIsLoadingSelectedServerTools(true);
      
      mcpService.listServerTools(serverName)
        .then(result => {
          if (result.error) {
            log.warn(`Error loading tools for ${serverName}:`, result.error);
          } else {
            // Ensure tools is always an array
            const toolsArray = result.tools || [];
            log.debug(`Loaded ${toolsArray.length} tools for ${serverName}`);
            setServerToolsMap(prev => ({
              ...prev,
              [serverName]: toolsArray
            }));
          }
        })
        .catch(error => {
          log.warn(`Failed to load tools for server ${serverName}:`, error);
        })
        .finally(() => {
          setIsLoadingSelectedServerTools(false);
        });
    }
  }, [serverToolsMap]);

  // Handle retrying a server connection
  const handleRetryServer = useCallback(async (serverName: string) => {
    log.debug(`Retrying server: ${serverName}`);
    
    // Set loading state for this server
    setIsLoadingTools(prev => ({
      ...prev,
      [serverName]: true
    }));
    
    try {
      // Retry the server connection
      await serverStatus.retryServer(serverName);
      
      // Load tools for this server
      const result = await mcpService.listServerTools(serverName);
      
      if (result.error) {
        log.warn(`Error loading tools for ${serverName} after retry:`, result.error);
        return false;
      } else {
        // Ensure tools is always an array
        const toolsArray = result.tools || [];
        log.debug(`Loaded ${toolsArray.length} tools for ${serverName} after retry`);
        setServerToolsMap(prev => ({
          ...prev,
          [serverName]: toolsArray
        }));
        return true;
      }
    } catch (error) {
      log.warn(`Failed to retry server ${serverName}:`, error);
      return false;
    } finally {
      // Update loading state for this server
      setIsLoadingTools(prev => ({
        ...prev,
        [serverName]: false
      }));
    }
  }, [serverStatus]);

  // Handle restarting a server
  const handleRestartServer = useCallback(async (serverName: string) => {
    log.debug(`Restarting server: ${serverName}`);
    
    // Set loading state for this server
    setIsLoadingTools(prev => ({
      ...prev,
      [serverName]: true
    }));
    
    try {
      // Restart the server
      await mcpService.restartServer(serverName);
      
      // Wait a bit for the server to restart
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Load tools for this server
      const result = await mcpService.listServerTools(serverName);
      
      if (result.error) {
        log.warn(`Error loading tools for ${serverName} after restart:`, result.error);
        return false;
      } else {
        // Ensure tools is always an array
        const toolsArray = result.tools || [];
        log.debug(`Loaded ${toolsArray.length} tools for ${serverName} after restart`);
        setServerToolsMap(prev => ({
          ...prev,
          [serverName]: toolsArray
        }));
        return true;
      }
    } catch (error) {
      log.warn(`Failed to restart server ${serverName}:`, error);
      return false;
    } finally {
      // Update loading state for this server
      setIsLoadingTools(prev => ({
        ...prev,
        [serverName]: false
      }));
    }
  }, []);

  // Find MCP nodes connected to this Process node
  function findConnectedMCPNodes(nodeId: string, allEdges: Flow['edges']) {
    return allEdges
      .filter(edge =>
        (edge.source === nodeId && edge.data?.edgeType === 'mcp') ||
        (edge.target === nodeId && edge.data?.edgeType === 'mcp')
      )
      .map(edge => edge.source === nodeId ? edge.target : edge.source);
  }

  return { 
    connectedServers, 
    isLoadingServers, 
    selectedToolServer, 
    serverToolsMap, 
    serverStatuses, 
    isLoadingTools, 
    handleSelectToolServer, 
    isLoadingSelectedServerTools,
    handleRetryServer,
    handleRestartServer
  };
};

export default useServerConnection;
