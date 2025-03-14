import React, { RefObject, useState, useEffect } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  IconButton,
  Tooltip,
  List,
  ListItem,
  ListItemText,
  TextField,
  InputAdornment,
  Paper,
  Chip,
  Divider,
  Card,
  CardContent,
  Tab,
  Tabs,
  Badge,
  Grid
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SearchIcon from '@mui/icons-material/Search';
import CodeIcon from '@mui/icons-material/Code';
import { createLogger } from '@/utils/logger';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools');

interface ServerToolsProps {
  isLoadingServers: boolean;
  connectedServers: any[];
  serverToolsMap: Record<string, any[]>;
  serverStatuses: Record<string, string>;
  isLoadingTools: Record<string, boolean>;
  handleSelectToolServer: (serverName: string) => void;
  handleInsertToolBinding: (serverName: string, toolName: string) => void;
  selectedToolServer: string | null;
  selectedNodeId: string | null;
  isLoadingSelectedServerTools: boolean;
  promptBuilderRef: RefObject<PromptBuilderRef | null>;
  handleRetryServer?: (serverName: string) => Promise<boolean>;
  handleRestartServer?: (serverName: string) => Promise<boolean>;
  // New props for filtering enabled tools
  flowNodes: any[];
}

const ServerTools: React.FC<ServerToolsProps> = ({
  isLoadingServers,
  connectedServers,
  serverToolsMap,
  serverStatuses,
  isLoadingTools,
  handleSelectToolServer,
  handleInsertToolBinding,
  selectedToolServer,
  selectedNodeId,
  isLoadingSelectedServerTools,
  promptBuilderRef,
  handleRetryServer,
  handleRestartServer,
  flowNodes
}) => {
  // State to track selected server
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  // State to track retrying servers
  const [retryingServers, setRetryingServers] = useState<Record<string, boolean>>({});
  // State to track search query
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Get enabled tools for each server from the corresponding MCP node
  const getEnabledToolsForServer = (serverName: string): string[] => {
    try {
      // Ensure flowNodes is defined and is an array
      if (!flowNodes || !Array.isArray(flowNodes)) {
        log.warn(`flowNodes is not available or not an array when getting enabled tools for ${serverName}`);
        return [];
      }
      
      // Find the connected server object for this server name
      const connectedServer = connectedServers.find(server => server && server.name === serverName);
      if (!connectedServer) {
        log.debug(`No connected server found for ${serverName}`);
        return [];
      }
      
      // If the server has a nodeId, use it to find the specific MCP node
      if (connectedServer.nodeId) {
        const specificNode = flowNodes.find(node => 
          node && 
          node.id === connectedServer.nodeId && 
          node.data && 
          node.data.type === 'mcp'
        );
        
        if (specificNode) {
          const enabledTools = specificNode.data.properties.enabledTools;
          log.info(`Using specific node ${specificNode.id} enabled tools: ${JSON.stringify(enabledTools)}`);
          
          if (!enabledTools || !Array.isArray(enabledTools)) {
            log.debug(`No enabled tools found for specific node ${specificNode.id}`);
            return [];
          }
          
          return enabledTools;
        }
      }
      
      // If we couldn't find a specific node by ID, fall back to finding all nodes bound to this server
      const mcpNodes = flowNodes.filter(node => 
        node && 
        node.data && 
        node.data.type === 'mcp' && 
        node.data.properties && 
        node.data.properties.boundServer === serverName
      );
      
      if (mcpNodes.length === 0) {
        log.debug(`No MCP nodes found for server ${serverName}`);
        return [];
      }
      
      // If multiple nodes found for this server, try to find the one that's currently selected
      if (mcpNodes.length > 1) {
        // First, try to use the selectedNodeId if it's available and matches one of our nodes
        if (selectedNodeId) {
          const nodeWithSelectedId = mcpNodes.find(node => node.id === selectedNodeId);
          if (nodeWithSelectedId) {
            const enabledTools = nodeWithSelectedId.data.properties.enabledTools;
            log.info(`Using node with selected ID ${nodeWithSelectedId.id} enabled tools: ${JSON.stringify(enabledTools)}`);
            
            if (!enabledTools || !Array.isArray(enabledTools)) {
              log.debug(`No enabled tools found for node with ID ${nodeWithSelectedId.id}`);
              return [];
            }
            
            return enabledTools;
          }
        }
        
        // If the selected server matches this server, try to find a node that matches the selection
        if (selectedServer === serverName) {
          // Find the MCP node that's currently selected in the UI
          const selectedNode = mcpNodes.find(node => {
            // Try to match based on any identifying information we have
            return node.id === selectedToolServer || 
                  (node.data.properties.selectedInUI === true);
          });
          
          if (selectedNode) {
            const enabledTools = selectedNode.data.properties.enabledTools;
            log.info(`Using selected node ${selectedNode.id} enabled tools: ${JSON.stringify(enabledTools)}`);
            
            if (!enabledTools || !Array.isArray(enabledTools)) {
              log.debug(`No enabled tools found for selected node ${selectedNode.id}`);
              return [];
            }
            
            return enabledTools;
          }
        }
      }
      
      // If only one node or we couldn't find a specific node, use the first one
      const mcpNode = mcpNodes[0];
      const enabledTools = mcpNode.data.properties.enabledTools;
      
      if (!enabledTools || !Array.isArray(enabledTools)) {
        log.debug(`No enabled tools found for server ${serverName}`);
        return [];
      }
      
      log.info(`Using first node ${mcpNode.id} enabled tools: ${JSON.stringify(enabledTools)}`);
      return enabledTools;
    } catch (error) {
      log.error(`Error getting enabled tools for server ${serverName}:`, error);
      return [];
    }
  };

  // Filter tools based on enabled status and search query
  const getFilteredTools = (serverName: string, tools: any[]): any[] => {
    try {
      // Ensure tools is defined and is an array
      if (!tools || !Array.isArray(tools)) {
        log.warn(`Tools is not available or not an array for server ${serverName}`);
        return [];
      }
      
      const enabledTools = getEnabledToolsForServer(serverName);
      
      // First filter by enabled tools if any are specified
      let filteredTools = tools;
      if (enabledTools.length > 0) {
        filteredTools = tools.filter(tool => tool && tool.name && enabledTools.includes(tool.name));
      }
      
      // Then filter by search query if one exists
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        filteredTools = filteredTools.filter(tool => 
          (tool.name && tool.name.toLowerCase().includes(query)) || 
          (tool.description && tool.description.toLowerCase().includes(query)) ||
          (tool.inputSchema && JSON.stringify(tool.inputSchema).toLowerCase().includes(query))
        );
      }
      
      return filteredTools;
    } catch (error) {
      log.error(`Error filtering tools for server ${serverName}:`, error);
      return tools; // Return all tools on error as a fallback
    }
  };

  // Handle server selection
  const handleServerSelect = (serverName: string) => {
    setSelectedServer(serverName);
    handleSelectToolServer(serverName);
  };

  // Handle retry server with better UI feedback
  const handleRetry = async (serverName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug(`Retry button clicked for server: ${serverName}`);
    
    // Set retrying state for this server
    setRetryingServers(prev => ({
      ...prev,
      [serverName]: true
    }));
    
    try {
      if (handleRetryServer) {
        await handleRetryServer(serverName);
      }
    } finally {
      // Reset retrying state after a short delay
      setTimeout(() => {
        setRetryingServers(prev => ({
          ...prev,
          [serverName]: false
        }));
      }, 500);
    }
  };

  // Handle restart server with better UI feedback
  const handleRestart = async (serverName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug(`Restart button clicked for server: ${serverName}`);
    
    // Set retrying state for this server
    setRetryingServers(prev => ({
      ...prev,
      [serverName]: true
    }));
    
    try {
      if (handleRestartServer) {
        await handleRestartServer(serverName);
      }
    } finally {
      // Reset retrying state after a short delay
      setTimeout(() => {
        setRetryingServers(prev => ({
          ...prev,
          [serverName]: false
        }));
      }, 500);
    }
  };

  // Format parameter schema for display
  const formatParameterSchema = (inputSchema: any) => {
    if (!inputSchema || !inputSchema.properties) {
      return null;
    }

    return (
      <Box sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'medium' }}>
          Parameters:
        </Typography>
        <Box sx={{ pl: 1, mt: 0.5 }}>
          {Object.entries(inputSchema.properties).map(([paramName, paramDetails]: [string, any]) => (
            <Box key={paramName} sx={{ mb: 0.5 }}>
              <Typography variant="caption" component="span" sx={{ fontWeight: 'medium' }}>
                {paramName}
                {inputSchema.required?.includes(paramName) && 
                  <Typography variant="caption" component="span" color="error.main"> *</Typography>
                }
                {': '}
              </Typography>
              <Typography variant="caption" component="span" color="text.secondary">
                {paramDetails.description || paramDetails.type || 'No description'}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>
    );
  };

  // Auto-select the first server when the component mounts
  useEffect(() => {
    if (connectedServers.length > 0 && !selectedServer) {
      setSelectedServer(connectedServers[0].name);
      if (!selectedToolServer) {
        handleSelectToolServer(connectedServers[0].name);
      }
    }
  }, [connectedServers, selectedServer, selectedToolServer, handleSelectToolServer]);

  return (
    <Box sx={{ mt: 4, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Typography variant="subtitle1" gutterBottom>
        Connected MCP Servers and Tools
      </Typography>

      {isLoadingServers ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={20} />
          <Typography color="text.secondary">Loading servers...</Typography>
        </Box>
      ) : connectedServers.length === 0 ? (
        <Box sx={{ p: 2, border: '1px dashed rgba(0, 0, 0, 0.12)', borderRadius: 1 }}>
          <Typography color="text.secondary" align="center">
            No MCP servers connected to this node.
          </Typography>
          <Typography variant="caption" color="text.secondary" align="center" display="block" sx={{ mt: 1 }}>
            Connect MCP nodes to this Process node to access their tools.
            <br />
            Use the left or right handles of this Process node to create MCP connections.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, height: 'calc(100% - 40px)' }}>
          {/* Server tabs */}
          <Tabs 
            value={selectedServer || connectedServers[0]?.name || ''} 
            onChange={(_, value) => handleServerSelect(value)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
          >
            {connectedServers.map((server: any) => {
              if (!server || !server.name) {
                return null;
              }
              
              const isRetrying = retryingServers[server.name] || isLoadingTools[server.name];
              const enabledTools = getEnabledToolsForServer(server.name);
              const toolCount = serverToolsMap[server.name]?.length || 0;
              
              return (
                <Tab 
                  key={server.name} 
                  value={server.name}
                  label={
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <Typography 
                        variant="body2"
                        sx={{
                          color: server.status === 'connected' ? 'success.main' :
                            server.status === 'error' ? 'error.main' : 'text.secondary'
                        }}
                      >
                        {server.name}
                      </Typography>
                      {toolCount > 0 && (
                        <Badge 
                          badgeContent={toolCount} 
                          color="primary" 
                          sx={{ ml: 1 }}
                        />
                      )}
                    </Box>
                  }
                  sx={{ 
                    textTransform: 'none',
                    minHeight: '48px',
                    opacity: server.status !== 'connected' ? 0.7 : 1
                  }}
                />
              );
            })}
          </Tabs>
          
          {/* Server actions */}
          {selectedServer && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
              <Tooltip title="Retry connection">
                <span>
                  <IconButton 
                    size="small" 
                    onClick={(e) => handleRetry(selectedServer, e)}
                    disabled={retryingServers[selectedServer] || isLoadingTools[selectedServer]}
                  >
                    {retryingServers[selectedServer] ? (
                      <CircularProgress size={16} />
                    ) : (
                      <RefreshIcon fontSize="small" />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              
              {serverStatuses[selectedServer] === 'connected' && (
                <Tooltip title="Restart server">
                  <span>
                    <IconButton 
                      size="small" 
                      onClick={(e) => handleRestart(selectedServer, e)}
                      disabled={retryingServers[selectedServer]}
                      sx={{ ml: 1 }}
                    >
                      <RestartAltIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
            </Box>
          )}
          
          {/* Search input */}
          <TextField
            placeholder="Search tools..."
            variant="outlined"
            size="small"
            fullWidth
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{ mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          
          {/* Tool list */}
          <Paper 
            variant="outlined" 
            sx={{ 
              flexGrow: 1,
              overflow: 'auto', 
              p: 0,
              height: 'calc(100% - 100px)' // Subtract the height of tabs and search field
            }}
          >
            {connectedServers.map((server: any) => {
              if (!server || !server.name || server.name !== (selectedServer || connectedServers[0]?.name)) {
                return null;
              }
              
              if (server.status !== 'connected') {
                return (
                  <Box key={server.name} sx={{ p: 2, textAlign: 'center' }}>
                    <Typography color="text.secondary">
                      Server is not connected. Connect to view tools.
                    </Typography>
                  </Box>
                );
              }
              
              if (isLoadingTools[server.name]) {
                return (
                  <Box key={server.name} sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                    <CircularProgress size={24} />
                  </Box>
                );
              }
              
              const tools = (() => {
                try {
                  return getFilteredTools(server.name, serverToolsMap[server.name] || []);
                } catch (error) {
                  log.error(`Error getting filtered tools for ${server.name}:`, error);
                  return [];
                }
              })();
              
              if (tools.length === 0) {
                return (
                  <Box key={server.name} sx={{ p: 2, textAlign: 'center' }}>
                    <Typography color="text.secondary">
                      {searchQuery.trim() 
                        ? `No tools match "${searchQuery}" for this server.` 
                        : "No tools available for this server."}
                    </Typography>
                  </Box>
                );
              }
              
              return (
                <List key={server.name} disablePadding>
                  {tools.map((tool) => (
                    <Card 
                      key={tool.name} 
                      variant="outlined" 
                      onClick={() => {
                        // First ensure the server is selected
                        if (server.name !== selectedToolServer) {
                          log.debug('Server not selected, selecting server first', { 
                            serverName: server.name, 
                            toolName: tool.name 
                          });
                          handleSelectToolServer(server.name);
                          // Don't insert the tool on first click, let the user click again
                          // This prevents the "undefined undefined" issue
                        } else {
                          // Server is already selected, check if tool name is defined before inserting
                          if (server.name && tool.name) {
                            log.debug('Inserting tool binding', { 
                              serverName: server.name, 
                              toolName: tool.name 
                            });
                            handleInsertToolBinding(server.name, tool.name);
                          } else {
                            log.warn('Cannot insert tool binding, server or tool name is undefined', {
                              serverName: server.name,
                              toolName: tool.name
                            });
                          }
                        }
                      }}
                      sx={{ 
                        mb: 1, 
                        mx: 1, 
                        mt: 1,
                        cursor: 'pointer',
                        position: 'relative',
                        '&:hover': { 
                          boxShadow: 1,
                          bgcolor: 'action.hover' 
                        }
                      }}
                    >
                      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <Box sx={{ width: '100%' }}>
                            <Typography variant="subtitle2" component="div" sx={{ display: 'flex', alignItems: 'center' }}>
                              <CodeIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
                              {tool.name}
                            </Typography>
                            
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                              {tool.description || "No description available"}
                            </Typography>
                            
                            {tool.inputSchema && formatParameterSchema(tool.inputSchema)}
                          </Box>
                        </Box>
                      </CardContent>
                      <Tooltip title={`Add ${tool.name} to prompt`}>
                        <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
                      </Tooltip>
                    </Card>
                  ))}
                </List>
              );
            })}
          </Paper>
        </Box>
      )}
    </Box>
  );
};

export default ServerTools;
