import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import { Flow } from '@/frontend/types/flow/flow';
import { MCPServerConfig } from '@/shared/types/mcp';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useServerConnection');

// Define the structure for connected MCP nodes returned by the hook
interface ConnectedMcpNode {
  nodeId: string;
  serverName: string;
  status: string;
  enabledTools: string[];
  // Add other relevant properties if needed
}

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
  const [selectedToolServerNodeId, setSelectedToolServerNodeId] = useState<string | null>(null); // Renamed state
  // const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null); // This seems redundant now
  const [isLoadingSelectedServerTools, setIsLoadingSelectedServerTools] = useState(false);

  // Find connected MCP node IDs
  const connectedNodeIds = useMemo(() => {
    return node ? findConnectedMCPNodes(node.id, flowEdges) : [];
  }, [node, flowEdges]);

  // Prepare the list of connected MCP nodes with required details
  const connectedMcpNodes = useMemo(() => {
    if (!node || connectedNodeIds.length === 0) return [];

    // Ensure flowNodes is defined and is an array
    if (!flowNodes || !Array.isArray(flowNodes)) {
      log.warn('flowNodes is not available or not an array when filtering connected servers');
      return [];
    }

    try {
      const nodes: ConnectedMcpNode[] = [];
      const processedNodeIds = new Set<string>(); // Track processed node IDs

      connectedNodeIds.forEach(nodeId => {
        if (processedNodeIds.has(nodeId)) {
          return; // Skip if already processed (handles potential duplicates from edge filtering)
        }

        const mcpNode = flowNodes.find(n => n && n.id === nodeId);
        if (!mcpNode || !mcpNode.data || !mcpNode.data.properties) {
          log.warn(`Could not find valid MCP node data for ID ${nodeId}`);
          return;
        }

        const serverName = mcpNode.data.properties.boundServer;
        if (!serverName) {
          log.warn(`MCP node ${nodeId} is not bound to any server.`);
          return;
        }

        const serverInfo = allServers.find(s => s.name === serverName);
        const status = serverInfo?.status || 'unknown';
        const enabledTools = mcpNode.data.properties.enabledTools || [];

        nodes.push({
          nodeId: nodeId,
          serverName: serverName,
          status: status,
          enabledTools: Array.isArray(enabledTools) ? enabledTools : [],
        });
        processedNodeIds.add(nodeId); // Mark as processed
      });

      log.debug('Generated connectedMcpNodes:', JSON.stringify(nodes));
      return nodes;
    } catch (error) {
      log.error('Error preparing connected MCP nodes:', error);
      return [];
    }
  }, [node, connectedNodeIds, allServers, flowNodes]);

  // Update server statuses when connected nodes or server statuses change
  useEffect(() => {
    if (connectedMcpNodes && connectedMcpNodes.length > 0) {
      const statuses: Record<string, string> = {};
      connectedMcpNodes.forEach((mcpNode) => {
        // Update status based on the latest from useServerStatus hook if available
        const serverInfo = allServers.find(s => s.name === mcpNode.serverName);
        statuses[mcpNode.serverName] = serverInfo?.status || mcpNode.status || 'unknown';
      });
      setServerStatuses(statuses);
    }
  }, [connectedMcpNodes, allServers]); // Depend on allServers to get latest status

  // Load tools for all unique connected server names when the modal is opened or nodes change
  useEffect(() => {
    if (open && connectedMcpNodes.length > 0) {
      const uniqueServerNames = Array.from(new Set(connectedMcpNodes.map(n => n.serverName)));

      const loadToolsForServers = async () => {
        const newIsLoadingTools: Record<string, boolean> = {};
        const newServerToolsMap: Record<string, any[]> = { ...serverToolsMap }; // Keep existing tools

        // Identify servers needing tool loading/reloading
        const serversToLoad = uniqueServerNames.filter(serverName => {
          const serverInfo = allServers.find(s => s.name === serverName);
          // Load if connected and tools aren't already loaded or loading
          return serverInfo?.status === 'connected' && !serverToolsMap[serverName] && !isLoadingTools[serverName];
        });

        if (serversToLoad.length === 0) return; // No new servers to load

        // Set loading state for servers to load
        serversToLoad.forEach(serverName => {
          newIsLoadingTools[serverName] = true;
        });
        setIsLoadingTools(prev => ({ ...prev, ...newIsLoadingTools }));

        // Load tools concurrently
        await Promise.all(serversToLoad.map(async (serverName) => {
          try {
            log.debug(`Loading tools for server: ${serverName}`);
            const result = await mcpService.listServerTools(serverName);

            if (result.error) {
              log.warn(`Error loading tools for ${serverName}:`, result.error);
              newServerToolsMap[serverName] = []; // Set empty array on error?
            } else {
              const toolsArray = result.tools || [];
              log.debug(`Loaded ${toolsArray.length} tools for ${serverName}`);
              newServerToolsMap[serverName] = toolsArray;
            }
          } catch (error) {
            log.warn(`Failed to load tools for server ${serverName}:`, error);
            newServerToolsMap[serverName] = []; // Set empty array on error?
          } finally {
            // Update loading state for this server specifically
            setIsLoadingTools(prev => ({ ...prev, [serverName]: false }));
          }
        }));

        setServerToolsMap(newServerToolsMap);
      };

      loadToolsForServers();
    }
  }, [open, connectedMcpNodes, allServers]); // Depend on nodes and server statuses


  // Create a ref to store the current serverToolsMap
  const serverToolsMapRef = useRef(serverToolsMap);

  // Update the ref whenever serverToolsMap changes
  useEffect(() => {
    serverToolsMapRef.current = serverToolsMap;
  }, [serverToolsMap]);

  // Handle selecting a tool server (MCP Node instance) by its nodeId
  const handleSelectToolServer = useCallback((nodeId: string) => {
    log.debug(`Selected MCP Node ID: ${nodeId}`);
    setSelectedToolServerNodeId(nodeId); // Update state with the nodeId

    const selectedNode = connectedMcpNodes.find(n => n.nodeId === nodeId);
    const serverName = selectedNode?.serverName;

    // If we haven't loaded tools for the associated server yet, load them now
    if (serverName && !serverToolsMapRef.current[serverName] && !isLoadingTools[serverName]) {
      log.debug(`Tools not loaded for server ${serverName}, loading now.`);
      setIsLoadingSelectedServerTools(true); // Indicate loading for the selected tab
      setIsLoadingTools(prev => ({ ...prev, [serverName]: true })); // Mark server as loading

      mcpService.listServerTools(serverName)
        .then(result => {
          const toolsArray = result.tools || [];
          if (result.error) {
            log.warn(`Error loading tools for ${serverName}:`, result.error);
          } else {
            log.debug(`Loaded ${toolsArray.length} tools for ${serverName}`);
          }
          // Update the main map (ref will update automatically via useEffect)
          setServerToolsMap(prev => ({ ...prev, [serverName]: toolsArray }));
        })
        .catch(error => {
          log.warn(`Failed to load tools for server ${serverName}:`, error);
          setServerToolsMap(prev => ({ ...prev, [serverName]: [] })); // Set empty on error
        })
        .finally(() => {
          setIsLoadingSelectedServerTools(false);
          setIsLoadingTools(prev => ({ ...prev, [serverName]: false }));
        });
    } else {
       // Tools are already loaded or loading, no need to fetch again
       setIsLoadingSelectedServerTools(isLoadingTools[serverName || ''] || false);
    }
  }, [connectedMcpNodes, isLoadingTools]); // Dependencies


  // Create a ref to store the serverStatus hook result
  const serverStatusRef = useRef(serverStatus);

  // Update the ref whenever serverStatus hook result changes
  useEffect(() => {
    serverStatusRef.current = serverStatus;
  }, [serverStatus]);

  // Handle retrying a server connection with stable dependencies
  const handleRetryServer = useCallback(async (serverName: string) => {
    log.debug(`Retrying server: ${serverName}`);
    
    // Set loading state for this server
    setIsLoadingTools(prev => ({
      ...prev,
      [serverName]: true
    }));
    
    try {
      // Retry the server connection using the ref
      await serverStatusRef.current.retryServer(serverName);
      
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
        // Update the main map which triggers the ref update
        setServerToolsMap(prev => ({ ...prev, [serverName]: toolsArray }));
        return true;
      }
    } catch (error) {
      log.warn(`Failed to retry or load tools for server ${serverName}:`, error);
      return false;
    } finally {
      // Update loading state for this server
      setIsLoadingTools(prev => ({
        ...prev,
        [serverName]: false
      }));
    }
  }, []); // Empty dependency array for stable function reference

  // Handle restarting a server with stable dependencies
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
        // Update the main map which triggers the ref update
        setServerToolsMap(prev => ({ ...prev, [serverName]: toolsArray }));
        return true;
      }
    } catch (error) {
      log.warn(`Failed to restart or load tools for server ${serverName}:`, error);
      return false;
    } finally {
      // Update loading state for this server
      setIsLoadingTools(prev => ({
        ...prev,
        [serverName]: false
      }));
    }
  }, []); // Empty dependency array for stable function reference

  // Find MCP nodes connected to this Process node
  function findConnectedMCPNodes(nodeId: string, allEdges: Flow['edges']) {
    return allEdges
      .filter(edge =>
        (edge.source === nodeId && edge.data?.edgeType === 'mcp') ||
        (edge.target === nodeId && edge.data?.edgeType === 'mcp')
      )
      .map(edge => edge.source === nodeId ? edge.target : edge.source)
      // Ensure uniqueness in case of multiple edges between the same nodes
      .filter((value, index, self) => self.indexOf(value) === index);
  }

  return {
    connectedMcpNodes, // Return the processed nodes list
    isLoadingServers, // Keep overall loading state if needed
    selectedToolServerNodeId, // Return the selected node ID
    // selectedNodeId, // Removed as redundant
    serverToolsMap,
    serverStatuses,
    isLoadingTools,
    handleSelectToolServer, // Return the updated handler
    isLoadingSelectedServerTools,
    handleRetryServer,
    handleRestartServer
  };
};

export default useServerConnection;
