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
  Alert,
  Tabs,
  Tab
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { createLogger } from '@/utils/logger';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { FlowNode } from '@/frontend/types/flow/flow';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools');

interface ServerToolsProps {
  isLoadingServers: boolean;
  connectedServers: any[];
  serverStatuses: Record<string, string>;
  serverToolsMap: Record<string, any[]>;
  isLoadingTools: Record<string, boolean>;
  handleInsertToolBinding: (serverName: string, toolName: string) => void;
  selectedToolServer: string | null;
  handleSelectToolServer: (serverName: string) => void;
  isLoadingSelectedServerTools: boolean;
  promptBuilderRef: RefObject<PromptBuilderRef | null>;
  flowNodes: FlowNode[];
  handleRetryServer?: (serverName: string) => Promise<boolean>;
  handleRestartServer?: (serverName: string) => Promise<boolean>;
}

interface Tool {
  name: string;
  description?: string;
  inputSchema?: any;
}

const ServerTools: React.FC<ServerToolsProps> = ({
  isLoadingServers,
  connectedServers,
  serverStatuses,
  serverToolsMap,
  isLoadingTools,
  handleInsertToolBinding,
  selectedToolServer,
  handleSelectToolServer,
  isLoadingSelectedServerTools,
  promptBuilderRef,
  flowNodes,
  handleRetryServer,
  handleRestartServer
}) => {
  // State to track expanded servers
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  // State to track retrying servers
  const [retryingServers, setRetryingServers] = useState<Record<string, boolean>>({});

  // Find MCP node for a server
  const findMcpNodeForServer = (serverName: string): FlowNode | undefined => {
    try {
      return flowNodes.find(node => 
        node.data.type === 'mcp' && 
        node.data.properties?.boundServer === serverName
      );
    } catch (error) {
      log.error(`Error finding MCP node for server ${serverName}:`, error);
      return undefined;
    }
  };

  // Get tools from serverToolsMap
  const getToolsForServer = (serverName: string): Tool[] => {
    try {
      const toolsMap = serverToolsMap as Record<string, any[]>;
      return toolsMap[serverName] || [];
    } catch (error) {
      log.error(`Error getting tools for server ${serverName}:`, error);
      return [];
    }
  };

  // Get enabled tools for a server
  const getEnabledToolsForServer = (serverName: string): string[] => {
    try {
      const mcpNode = findMcpNodeForServer(serverName);
      if (!mcpNode) {
        log.debug(`No MCP node found for server ${serverName}`);
        return [];
      }

      // Get the enabled tools from the MCP node's properties
      const enabledTools = mcpNode.data.properties?.enabledTools || [];
      return enabledTools;
    } catch (error) {
      log.error(`Error getting enabled tools for server ${serverName}:`, error);
      return [];
    }
  };

  // Get filtered tools (only enabled ones)
  const getFilteredTools = (serverName: string): Tool[] => {
    try {
      const allTools = getToolsForServer(serverName);
      const enabledTools = getEnabledToolsForServer(serverName);
      
      // If no enabled tools are specified, show all tools
      if (!enabledTools.length) {
        log.debug(`No enabled tools specified for server ${serverName}, showing all tools`);
        return allTools;
      }

      // Filter tools to only show enabled ones
      return allTools.filter(tool => tool && tool.name && enabledTools.includes(tool.name));
    } catch (error) {
      log.error(`Error filtering tools for server ${serverName}:`, error);
      return [];
    }
  };

  // Handle tab change
  const handleTabChange = (event: React.SyntheticEvent, newValue: string) => {
    setExpandedServer(newValue);
    handleSelectToolServer(newValue);
  };

  // Handle retry server with better UI feedback
  const handleRetry = async (serverName: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent accordion from toggling
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
    e.stopPropagation(); // Prevent accordion from toggling
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

  // Auto-select the first server when the component mounts
  useEffect(() => {
    if (connectedServers.length > 0 && !expandedServer) {
      const firstServerName = connectedServers[0].name;
      setExpandedServer(firstServerName);
      handleSelectToolServer(firstServerName);
    }
  }, [connectedServers, expandedServer, handleSelectToolServer]);

  return (
    <Box sx={{ mt: 4 }}>
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
        <Box sx={{ maxHeight: '300px', overflow: 'auto', border: '1px solid rgba(0, 0, 0, 0.12)', borderRadius: 1, p: 1 }}>
          {/* Server tabs */}
          <Tabs 
            value={expandedServer} 
            onChange={handleTabChange} 
            variant="scrollable" 
            scrollButtons="auto"
            sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
          >
            {connectedServers.map((server: any) => {
              if (!server || !server.name) {
                log.warn('Invalid server object in connectedServers');
                return null; // Skip invalid servers
              }
              
              const serverStatus = (serverStatuses as Record<string, string>)[server.name] || 'unknown';
              const statusColor = serverStatus === 'connected' ? 'success.main' : 
                                  serverStatus === 'error' ? 'error.main' : 'text.secondary';
              
              return (
                <Tab 
                  key={server.name}
                  value={server.name}
                  label={
                    <Typography variant="body2">{server.name}</Typography>
                  }
                  icon={
                    <Box
                      sx={{
                        ml: 1,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        bgcolor: statusColor,
                      }}
                    />
                  }
                  iconPosition="end"
                />
              );
            })}
          </Tabs>
          
          {/* Action buttons outside of any button elements */}
          {expandedServer && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
              <Tooltip title="Retry connection">
                <span> {/* Wrap in span to avoid button-in-button issues */}
                  <IconButton 
                    size="small" 
                    onClick={(e) => handleRetry(expandedServer, e)}
                    disabled={retryingServers[expandedServer] || isLoadingTools[expandedServer]}
                  >
                    {retryingServers[expandedServer] ? (
                      <CircularProgress size={16} />
                    ) : (
                      <RefreshIcon fontSize="small" />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              
              {(serverStatuses as Record<string, string>)[expandedServer] === 'connected' && (
                <Tooltip title="Restart server">
                  <span> {/* Wrap in span to avoid button-in-button issues */}
                    <IconButton 
                      size="small" 
                      onClick={(e) => handleRestart(expandedServer, e)}
                      disabled={retryingServers[expandedServer]}
                      sx={{ ml: 1 }}
                    >
                      <RestartAltIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
            </Box>
          )}
          
          {/* Server content */}
          {expandedServer && (
            <Box>
              {(serverStatuses as Record<string, string>)[expandedServer] === 'connected' ? (
                (isLoadingTools[expandedServer] === true) ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ml: 2 }}>
                    <CircularProgress size={16} />
                    <Typography variant="body2" color="text.secondary">
                      Loading tools...
                    </Typography>
                  </Box>
                ) : getToolsForServer(expandedServer).length > 0 ? (
                  <>
                    {!getEnabledToolsForServer(expandedServer).length && (
                      <Alert severity="info" sx={{ mb: 2 }}>
                        No tools are enabled for this server in its MCP node. 
                        Showing all available tools.
                      </Alert>
                    )}
                    
                    <List disablePadding>
                      {getFilteredTools(expandedServer).map((tool) => (
                        <ListItem
                          key={tool.name}
                          disablePadding
                          onClick={() => {
                            // First ensure the server is selected
                            if (expandedServer !== selectedToolServer) {
                              handleSelectToolServer(expandedServer);
                              // Use setTimeout to ensure the server selection is processed before inserting the tool
                              setTimeout(() => {
                                handleInsertToolBinding(expandedServer, tool.name);
                              }, 0);
                            } else {
                              // Server is already selected, just insert the tool
                              handleInsertToolBinding(expandedServer, tool.name);
                            }
                          }}
                          sx={{
                            py: 0.5,
                            px: 1,
                            cursor: 'pointer',
                            '&:hover': { bgcolor: 'action.hover', borderRadius: 1 }
                          }}
                        >
                          <ListItemText
                            primary={tool.name}
                            secondary={tool.description}
                            primaryTypographyProps={{ variant: 'body2', fontWeight: 'medium' }}
                            secondaryTypographyProps={{ variant: 'caption' }}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </>
                ) : (
                  <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
                    No tools available for this server
                  </Typography>
                )
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
                  Connect to server to view tools
                </Typography>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

export default ServerTools;
