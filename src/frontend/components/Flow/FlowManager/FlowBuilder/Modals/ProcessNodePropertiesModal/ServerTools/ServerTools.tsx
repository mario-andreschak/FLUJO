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
  Grid,
  Button
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SearchIcon from '@mui/icons-material/Search';
import CodeIcon from '@mui/icons-material/Code';
import { createLogger } from '@/utils/logger';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools');

// Define the structure for connected MCP nodes passed as props
interface ConnectedMcpNode {
  nodeId: string;
  serverName: string;
  status: string;
  enabledTools: string[];
  // Add other relevant properties if needed
}

interface ServerToolsProps {
  isLoadingServers: boolean; // Keep for overall loading state if needed, or remove if handled per node
  connectedMcpNodes: ConnectedMcpNode[]; // Use this instead of connectedServers
  /**
   * Every configured MCP server, for the connect-a-server shortcut. The
   * runtime value is a full server config, so extra fields are accepted (and
   * used to render the picker's ServerCards).
   */
  availableServers?: Array<{
    name: string;
    status?: string;
    transport?: string;
    rootPath?: string;
    disabled?: boolean;
  }>;
  /** Adds an MCP node for the given server and wires it to this Process node. */
  onConnectMcpServer?: (serverName: string) => void;
  serverToolsMap: Record<string, any[]>; // Map tools by serverName (might need adjustment if tools are fetched per nodeId)
  serverStatuses: Record<string, string>; // Map status by serverName (might need adjustment)
  isLoadingTools: Record<string, boolean>; // Map loading by serverName (might need adjustment)
  handleSelectToolServer: (nodeId: string) => void; // Pass nodeId instead of serverName
  handleInsertToolBinding: (serverName: string, toolName: string) => void; // Keep serverName here for the binding string
  selectedToolServerNodeId: string | null; // Use nodeId for selection state
  selectedNodeId: string | null; // ID of the parent ProcessNode
  isLoadingSelectedServerTools: boolean; // Keep or adjust based on loading logic
  promptBuilderRef: RefObject<PromptBuilderRef | null>;
  handleRetryServer?: (serverName: string) => Promise<boolean>; // Keep serverName for API call
  handleRestartServer?: (serverName: string) => Promise<boolean>; // Keep serverName for API call
  // flowNodes prop might not be needed here if enabledTools comes via connectedMcpNodes
  // flowNodes: any[];
}

const ServerTools: React.FC<ServerToolsProps> = ({
  isLoadingServers,
  connectedMcpNodes, // Use connectedMcpNodes
  availableServers,
  onConnectMcpServer,
  serverToolsMap,
  serverStatuses,
  isLoadingTools,
  handleSelectToolServer,
  handleInsertToolBinding,
  selectedToolServerNodeId, // Use selectedToolServerNodeId
  selectedNodeId,
  isLoadingSelectedServerTools,
  promptBuilderRef,
  handleRetryServer,
  handleRestartServer,
  // flowNodes // Removed if not needed
}) => {
  // The selected server node is derived — the parent owns the selection, and
  // the first connected node is the default (no mirrored local state to
  // drift).
  const selectedServerNodeId = selectedToolServerNodeId ?? connectedMcpNodes[0]?.nodeId ?? null;
  // State to track retrying servers (use serverName as key for API calls)
  const [retryingServers, setRetryingServers] = useState<Record<string, boolean>>({});
  // Whether the connect-a-server picker dialog is open.
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);

  // Servers the user could still connect to this node (already-connected
  // ones are hidden — the shortcut is a friction reducer, not a way to wire
  // the same server twice).
  const connectableServers = (availableServers ?? []).filter(
    server => !connectedMcpNodes.some(node => node.serverName === server.name)
  );
  const canConnectServer = !!onConnectMcpServer && connectableServers.length > 0;

  const handleConnectServer = (serverName: string) => {
    setConnectPickerOpen(false);
    onConnectMcpServer?.(serverName);
  };

  // Connect-a-server picker (#92): reuses the MCP Server Manager card layout so
  // choosing a server here looks exactly like the MCP Servers page.
  const connectServerPicker = (
    <CardPickerDialog
      open={connectPickerOpen}
      onClose={() => setConnectPickerOpen(false)}
      title="Connect an MCP server"
      description="Pick a server to add to this flow and wire to this Process node."
      emptyMessage="No more servers to connect."
      items={connectableServers.map(server => ({
        key: server.name,
        content: (
          <ServerCard
            name={server.name}
            status={(server.status as any) || 'disconnected'}
            path={server.rootPath || ''}
            enabled={!server.disabled}
            transport={(server.transport as any) || 'stdio'}
            pickerMode
            onClick={() => handleConnectServer(server.name)}
          />
        ),
      }))}
    />
  );
  // State to track search query
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Get enabled tools for a specific MCP node instance
  const getEnabledToolsForNode = (nodeId: string): string[] => {
    try {
      const mcpNode = connectedMcpNodes.find(node => node.nodeId === nodeId);
      if (!mcpNode) {
        log.warn(`Could not find connected MCP node with ID ${nodeId}`);
        return [];
      }
      const enabledTools = mcpNode.enabledTools || [];
      log.debug(`Enabled tools for node ${nodeId}: ${JSON.stringify(enabledTools)}`);
      return Array.isArray(enabledTools) ? enabledTools : [];
    } catch (error) {
      log.error(`Error getting enabled tools for node ${nodeId}:`, error);
      return [];
    }
  };

  // Filter tools based on enabled status for a specific node and search query
  const getFilteredTools = (nodeId: string, serverName: string, allToolsForServer: any[]): any[] => {
    try {
      // Ensure allToolsForServer is defined and is an array
      if (!allToolsForServer || !Array.isArray(allToolsForServer)) {
        log.warn(`Tools array is not available or not an array for server ${serverName}`);
        return [];
      }

      const enabledTools = getEnabledToolsForNode(nodeId);

      // First filter by enabled tools if any are specified for this node
      let filteredTools = allToolsForServer;
      if (enabledTools.length > 0) {
        filteredTools = allToolsForServer.filter(tool => tool && tool.name && enabledTools.includes(tool.name));
      } else {
        // If no tools are explicitly enabled for this node, maybe show none or all?
        // Current behavior: Show none if enabledTools is empty.
        // If you want to show all when none are specified, remove this else block
        // or change the logic in getEnabledToolsForNode.
        log.debug(`No tools explicitly enabled for node ${nodeId}, showing none.`);
        filteredTools = [];
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
      log.error(`Error filtering tools for node ${nodeId} (server ${serverName}):`, error);
      return allToolsForServer || []; // Return all tools for the server on error as a fallback
    }
  };

  // Handle server tab selection (by nodeId) — the parent owns the selection
  const handleServerSelect = (nodeId: string) => {
    handleSelectToolServer(nodeId);
  };

  // Handle retry server with better UI feedback
  const handleRetry = async (serverName: string, e: React.MouseEvent) => {
    // Need serverName for the API call
    e.stopPropagation();
    log.debug(`Retry button clicked for server: ${serverName}`);

    // Set retrying state using serverName as key
    setRetryingServers(prev => ({ ...prev, [serverName]: true }));

    try {
      if (handleRetryServer) {
        await handleRetryServer(serverName);
      }
    } finally {
      // Reset retrying state after a short delay
      setTimeout(() => {
        setRetryingServers(prev => ({ ...prev, [serverName]: false }));
      }, 500);
    }
  };

  // Handle restart server with better UI feedback
  const handleRestart = async (serverName: string, e: React.MouseEvent) => {
    // Need serverName for the API call
    e.stopPropagation();
    log.debug(`Restart button clicked for server: ${serverName}`);

    // Set retrying state using serverName as key
    setRetryingServers(prev => ({ ...prev, [serverName]: true }));

    try {
      if (handleRestartServer) {
        await handleRestartServer(serverName);
      }
    } finally {
      // Reset retrying state after a short delay
      setTimeout(() => {
        setRetryingServers(prev => ({ ...prev, [serverName]: false }));
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


  // Tell the parent about the default selection so it loads that server's
  // tools (the rendered selection is already derived above).
  useEffect(() => {
    if (connectedMcpNodes.length > 0 && !selectedToolServerNodeId) {
      handleSelectToolServer(connectedMcpNodes[0].nodeId);
    }
  }, [connectedMcpNodes, selectedToolServerNodeId, handleSelectToolServer]);

  // Determine the currently selected node details
  const currentSelectedMcpNode = connectedMcpNodes.find(node => node.nodeId === selectedServerNodeId);
  const currentSelectedServerName = currentSelectedMcpNode?.serverName;

  return (
    <Box sx={{ mt: 4, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Typography variant="subtitle1" gutterBottom>
        Connected MCP Servers and Tools
      </Typography>

      {isLoadingServers ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={20} />
          <Typography color="text.secondary">Loading connected MCP nodes...</Typography>
        </Box>
      ) : connectedMcpNodes.length === 0 ? (
        <Box sx={{ p: 2, border: '1px dashed rgba(0, 0, 0, 0.12)', borderRadius: 1 }}>
          <Typography color="text.secondary" align="center">
            No MCP nodes connected to this Process node.
          </Typography>
          <Typography variant="caption" color="text.secondary" align="center" display="block" sx={{ mt: 1 }}>
            {canConnectServer
              ? 'Pick a server below — the MCP node is added to the flow and wired up for you.'
              : 'Connect MCP nodes to this Process node using the side handles to access their tools.'}
          </Typography>
          {canConnectServer && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <Button
                variant="contained"
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setConnectPickerOpen(true)}
              >
                Connect MCP Server
              </Button>
            </Box>
          )}
          {connectServerPicker}
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, height: 'calc(100% - 40px)' }}>
          {/* Server tabs (using nodeId), plus the connect-a-server shortcut */}
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tabs
            value={selectedServerNodeId || connectedMcpNodes[0]?.nodeId || ''}
            onChange={(_, value) => handleServerSelect(value)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ flexGrow: 1 }}
          >
            {connectedMcpNodes.map((mcpNode: ConnectedMcpNode) => {
              if (!mcpNode || !mcpNode.nodeId || !mcpNode.serverName) {
                log.warn('Skipping invalid MCP node in tabs:', mcpNode);
                return null;
              }

              const serverName = mcpNode.serverName;
              const nodeId = mcpNode.nodeId;
              const status = mcpNode.status; // Use status from the node object
              const isRetrying = retryingServers[serverName]; // Retry state still keyed by serverName
              const isLoadingNodeTools = isLoadingTools[serverName]; // Loading state keyed by serverName (adjust if needed)
              const allToolsForServer = serverToolsMap[serverName] || [];
              const enabledToolsForNode = getEnabledToolsForNode(nodeId);
              const filteredToolCount = getFilteredTools(nodeId, serverName, allToolsForServer).length;

              return (
                <Tab
                  key={nodeId} // Use unique nodeId
                  value={nodeId} // Use unique nodeId
                  label={
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <Typography
                        variant="body2"
                        sx={{
                          color: status === 'connected' ? 'success.main' :
                                 status === 'error' ? 'error.main' : 'text.secondary'
                        }}
                      >
                        {/* Maybe add part of nodeId if names are identical? */}
                        {serverName}
                      </Typography>
                      {/* Show count of *enabled* tools for this node */}
                      {enabledToolsForNode.length > 0 && (
                        <Badge
                          badgeContent={enabledToolsForNode.length}
                          color="primary"
                          sx={{ ml: 1 }}
                        />
                      )}
                    </Box>
                  }
                  sx={{
                    textTransform: 'none',
                    minHeight: '48px',
                    opacity: status !== 'connected' ? 0.7 : 1
                  }}
                />
              );
            })}
          </Tabs>
          {canConnectServer && (
            <Tooltip title="Connect another MCP server">
              <IconButton size="small" onClick={() => setConnectPickerOpen(true)} sx={{ ml: 1 }}>
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {connectServerPicker}
          </Box>

          {/* Server actions for the selected node */}
          {currentSelectedMcpNode && currentSelectedServerName && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
              <Tooltip title={`Retry connection for ${currentSelectedServerName}`}>
                <span>
                  <IconButton
                    size="small"
                    onClick={(e) => handleRetry(currentSelectedServerName, e)}
                    disabled={retryingServers[currentSelectedServerName] || isLoadingTools[currentSelectedServerName]}
                  >
                    {retryingServers[currentSelectedServerName] ? (
                      <CircularProgress size={16} />
                    ) : (
                      <RefreshIcon fontSize="small" />
                    )}
                  </IconButton>
                </span>
              </Tooltip>

              {currentSelectedMcpNode.status === 'connected' && handleRestartServer && (
                <Tooltip title={`Restart server ${currentSelectedServerName}`}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={(e) => handleRestart(currentSelectedServerName, e)}
                      disabled={retryingServers[currentSelectedServerName]}
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
            placeholder="Search enabled tools..."
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
              height: 'calc(100% - 140px)' // Adjust height considering tabs, actions, search
            }}
          >
            {/* Render tools for the selected MCP node */}
            {currentSelectedMcpNode && currentSelectedServerName && (() => {
              const nodeId = currentSelectedMcpNode.nodeId;
              const serverName = currentSelectedMcpNode.serverName;
              const status = currentSelectedMcpNode.status;

              if (status !== 'connected') {
                return (
                  <Box key={nodeId} sx={{ p: 2, textAlign: 'center' }}>
                    <Typography color="text.secondary">
                      Server '{serverName}' is not connected. Connect to view tools.
                    </Typography>
                  </Box>
                );
              }

              if (isLoadingTools[serverName]) {
                return (
                  <Box key={nodeId} sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                    <CircularProgress size={24} />
                  </Box>
                );
              }

              const allToolsForServer = serverToolsMap[serverName] || [];
              const tools = getFilteredTools(nodeId, serverName, allToolsForServer);

              if (tools.length === 0) {
                const enabledToolsCount = getEnabledToolsForNode(nodeId).length;
                return (
                  <Box key={nodeId} sx={{ p: 2, textAlign: 'center' }}>
                    <Typography color="text.secondary">
                      {searchQuery.trim()
                        ? `No enabled tools match "${searchQuery}" for this node.`
                        : enabledToolsCount === 0
                        ? `No tools are enabled for this node instance. Enable tools in the MCP Node properties.`
                        : "No tools available or enabled for this node instance."}
                    </Typography>
                  </Box>
                );
              }

              return (
                <List key={nodeId} disablePadding>
                  {tools.map((tool) => (
                    <Card
                      key={tool.name}
                      variant="outlined"
                      onClick={() => {
                        // Ensure the correct node tab is selected before inserting
                        if (nodeId !== selectedServerNodeId) {
                          log.debug('Node tab not selected, selecting node first', {
                            selectedNodeId: nodeId,
                            serverName: serverName,
                            toolName: tool.name
                          });
                          handleServerSelect(nodeId); // Select the correct tab first
                          // Don't insert on the first click
                        } else {
                          // Node tab is selected, insert the binding
                          if (serverName && tool.name) {
                            log.debug('Inserting tool binding', {
                              serverName: serverName, // Use the actual server name for the binding string
                              toolName: tool.name
                            });
                            handleInsertToolBinding(serverName, tool.name);
                          } else {
                            log.warn('Cannot insert tool binding, server or tool name is undefined', {
                              serverName: serverName,
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
                      <Tooltip title={`Add ${tool.name} from ${serverName} to prompt`}>
                        <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
                      </Tooltip>
                    </Card>
                  ))}
                </List>
              );
            })()}
          </Paper>
        </Box>
      )}
    </Box>
  );
};

export default ServerTools;
