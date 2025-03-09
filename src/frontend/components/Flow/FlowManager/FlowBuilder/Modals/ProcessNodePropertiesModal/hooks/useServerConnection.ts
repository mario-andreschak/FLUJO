import { useState, useEffect, useMemo, useCallback } from 'react';
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
 * This simplified version focuses on providing a clean interface for the component
 * without complex state management.
 */
const useServerConnection = (open: boolean, node: Flow['nodes'][number] | null, flowEdges: Flow['edges'], flowNodes: Flow['nodes']) => {
  // Get all server status using the hook
  const serverStatus = useServerStatus();
  const allServers = serverStatus.servers || [];
  const isLoadingServers = serverStatus.isLoading || false;
  
  const [serverToolsMap, setServerToolsMap] = useState<Record<string, any[]>>({});
  const [serverStatuses, setServerStatuses] = useState<Record<string, string>>({});
  const [isLoadingTools, setIsLoadingTools] = useState<Record<string, boolean>>({});
  
  // Find connected MCP nodes
  const connectedNodeIds = useMemo(() => {
    return node ? findConnectedMCPNodes(node.id, flowEdges) : [];
  }, [node, flowEdges]);

  // Filter servers to only show those connected to this Process node
  const connectedServers = useMemo(() => {
    if (!node || connectedNodeIds.length === 0) return [];

    return allServers.filter((server: MCPServerConfig & { status: string }) =>
      connectedNodeIds.some(nodeId => {
        const mcpNode = flowNodes.find(n => n.id === nodeId);
        return mcpNode?.data?.properties?.boundServer === server.name;
      })
    );
  }, [node, connectedNodeIds, allServers, flowNodes]);

  // State for selected server for tool insertion
  const [selectedToolServer, setSelectedToolServer] = useState<string | null>(null);

  // Get tools for the selected server using the hook
  const serverToolsResult = useServerTools(selectedToolServer);
  const serverTools = serverToolsResult.tools || [];
  const isLoadingSelectedServerTools = serverToolsResult.isLoading || false;

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

  // Load tools for all connected servers when the modal opens
  useEffect(() => {
    if (open && connectedServers.length > 0) {
      // Initialize loading state for all servers
      const loadingState: Record<string, boolean> = {};
      connectedServers.forEach((server: MCPServerConfig) => {
        loadingState[server.name] = true;
      });
      setIsLoadingTools(loadingState);
    }
  }, [open, connectedServers]);

  // Set the first server as selected by default when modal opens or connected servers change
  useEffect(() => {
    if (open && connectedServers.length > 0 && !selectedToolServer) {
      setSelectedToolServer(connectedServers[0].name);
    }
  }, [open, connectedServers, selectedToolServer]);

  // Handle selecting a server for tool loading
  const handleSelectToolServer = useCallback((serverName: string) => {
    // Only update if it's a different server
    if (serverName !== selectedToolServer) {
      setSelectedToolServer(serverName);

      // Mark this server as loading
      setIsLoadingTools(prev => ({
        ...prev,
        [serverName]: true
      }));
    }
  }, [selectedToolServer]);

  // Update server tools when serverTools changes
  useEffect(() => {
    if (selectedToolServer && serverTools.length > 0) {
      // Update the tools map
      setServerToolsMap(prev => ({
        ...prev,
        [selectedToolServer]: serverTools
      }));

      // Set loading to false
      setIsLoadingTools(prev => ({
        ...prev,
        [selectedToolServer]: false
      }));
    }
  }, [serverTools, selectedToolServer]);

  // Handle retrying a server connection
  const handleRetryServer = useCallback(async (serverName: string) => {
    log.debug(`Retrying server status for: ${serverName}`);
    
    // Set loading state for this server
    setIsLoadingTools(prev => ({
      ...prev,
      [serverName]: true
    }));
    
    try {
      // Call the service method
      const result = await mcpService.retryServer(serverName);
      
      // Update the server status
      if (typeof result === 'string') {
        setServerStatuses(prev => ({
          ...prev,
          [serverName]: result
        }));
      } else if (result.status) {
        setServerStatuses(prev => ({
          ...prev,
          [serverName]: result.status
        }));
      }
      
      // If the server is now connected, refresh its tools
      if (result.status === 'connected' && serverName === selectedToolServer) {
        // This will trigger the useEffect that loads tools
      }
      
      return true;
    } catch (error) {
      log.warn(`Failed to retry server ${serverName}:`, error);
      return false;
    } finally {
      // Reset loading state after a short delay
      setTimeout(() => {
        setIsLoadingTools(prev => ({
          ...prev,
          [serverName]: false
        }));
      }, 500);
    }
  }, [selectedToolServer]);

  // Handle restarting a server
  const handleRestartServer = useCallback(async (serverName: string) => {
    log.debug(`Restarting server: ${serverName}`);
    
    // Set loading state for this server
    setIsLoadingTools(prev => ({
      ...prev,
      [serverName]: true
    }));
    
    try {
      // Call the service method
      const result = await mcpService.restartServer(serverName);
      
      if (result.error) {
        log.warn(`Failed to restart server ${serverName}:`, result.error);
        return false;
      }
      
      // The server status will be updated through the normal status polling
      return true;
    } catch (error) {
      log.warn(`Failed to restart server ${serverName}:`, error);
      return false;
    }
    // Don't reset loading state here, as we want it to show until the server is connected again
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
