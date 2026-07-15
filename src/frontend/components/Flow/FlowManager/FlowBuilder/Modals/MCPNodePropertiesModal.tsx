"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField, // Keep TextField
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
  Box,
  IconButton,
  Divider,
  FormHelperText,
  Grid,
  Paper,
  Radio,
  RadioGroup,
  FormControlLabel,
  Checkbox,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Switch,
  CircularProgress,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import Tooltip from '@mui/material/Tooltip';
import { FlowNode } from '@/frontend/types/flow/flow';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS, TOOL_CALL_TIMEOUT_INFINITE } from '@/shared/types/mcp';
import { resolveAutoNodeLabel } from '@/shared/utils/nodeLabel';
import RootsManager from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/LocalServerTab/RootsManager';
import { createLogger } from '@/utils/logger/index';

const logger = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/MCPNodePropertiesModal');
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import CardPickerGrid, { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { CardGroup } from '@/utils/shared/cardGrouping';

interface MCPNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
}

export const MCPNodePropertiesModal = ({ open, node, onClose, onSave }: MCPNodePropertiesModalProps) => {
  // Clone node data to avoid direct mutation
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  // Get server status using the hook
  const { 
    servers, 
    isLoading: isLoadingServers, 
    loadError, 
    retryServer 
  } = useServerStatus();
  
  // State for the selected server
  // State for tracking which servers are being retried
  const [retryingServers, setRetryingServers] = useState<Record<string, boolean>>({});

  // Shared MCP picker view-model (#92): reuse the MCP Servers page's saved
  // search/sort/folder settings so binding a server here matches that page.
  const serverPicker = useCardPicker<any>('mcp', servers);

  // Whole-list "reload connections" retry beside the picker (#92): the modal's
  // retry is a list-level reload, so one control refreshes every server.
  const [retryingAll, setRetryingAll] = useState(false);
  const handleRetryAllServers = async () => {
    setRetryingAll(true);
    try {
      await Promise.all(servers.map((s: any) => retryServer(s.name)));
    } finally {
      setTimeout(() => setRetryingAll(false), 500);
    }
  };
  
  // Get tools for the selected server using the hook
  const { 
    tools: mcpTools, 
    isLoading: isLoadingTools, 
    error: toolsError,
    loadTools
  } = useServerTools(nodeData?.properties?.boundServer || ''); // Use derived value directly

  // Load node data when node changes
  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { ...node.data.properties }
      });
      // If there's a bound server, ensure it's part of the initial nodeData
      // No need to call setSelectedServer here anymore
    }
  }, [node, open]);

  // Get selected server name from nodeData (can be used elsewhere if needed)
  const selectedServer = nodeData?.properties?.boundServer || '';

  // Helper function to initialize enabled tools
  const initializeEnabledTools = (tools: any[]) => {
    if (!nodeData) return;
    
    const enabledToolsFromProps = nodeData.properties.enabledTools || [];
    if (enabledToolsFromProps.length === 0 && tools.length > 0) {
      // If no tools were previously enabled, enable all by default
      logger.debug('Enabling all tools by default');
      setNodeData(prev => {
        if (!prev) return null;
        return {
          ...prev,
          properties: {
            ...prev.properties,
            enabledTools: tools.map((tool) => tool.name)
          }
        };
      });
    }
  };

  // Initialize enabled tools when tools change
  useEffect(() => {
    if (mcpTools && mcpTools.length > 0) {
      initializeEnabledTools(mcpTools);
    }
  }, [mcpTools]);

  const handlePropertyChange = (key: string, value: any) => {
    setNodeData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        properties: {
          ...prev.properties,
          [key]: value,
        },
      };
    });
  };

  // Handle label change. Editing the label by hand marks it custom so binding a
  // server never auto-overwrites it (issue #38, Item C).
  const handleLabelChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setNodeData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        label: event.target.value,
        properties: {
          ...prev.properties,
          nameIsCustom: true,
        },
      };
    });
  };

  const handleSave = () => {
    if (node && nodeData) {
      onSave(node.id, nodeData);
      onClose();
    }
  };

  // Handle retrying a server connection
  const handleRetryServer = async (serverName: string, event?: React.MouseEvent) => {
    if (event) {
      event.stopPropagation();
    }
    
    logger.debug(`Retrying server: ${serverName}`);
    
    // Set retrying state for this server
    setRetryingServers(prev => ({
      ...prev,
      [serverName]: true
    }));
    
    try {
      // Call the retry function from the hook
      await retryServer(serverName);
      
      // If this is the selected server, reload its tools
      if (serverName === selectedServer) {
        loadTools(true); // Force reload
      }
      
      return true;
    } catch (error) {
      logger.warn(`Failed to retry server ${serverName}: ${error}`);
      return false;
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

  const handleServerSelect = (serverName: string) => {
    logger.debug(`Server selected: ${serverName}`);
    logger.debug(`Server selected: ${serverName}`);
    // Update selectedServer state if needed (though it's derived now)
    // setSelectedServer(serverName); // No longer needed if derived

    setNodeData((prev) => {
      if (!prev) return null;
      // Auto-name the node after the bound server unless the user renamed it by
      // hand. previousAutoLabel (the prior server name) lets a re-bind re-label a
      // node still showing the old server's auto name (issue #38, Item C).
      const newLabel = resolveAutoNodeLabel({
        currentLabel: prev.label,
        nameIsCustom: prev.properties?.nameIsCustom,
        defaultLabel: 'MCP Node',
        previousAutoLabel: prev.properties?.boundServer || undefined,
        nextAutoLabel: serverName,
      });

      return {
        ...prev,
        label: newLabel,
        properties: {
          ...prev.properties,
          boundServer: serverName,
          // Reset enabled tools when server changes? Consider this.
          // enabledTools: [], // Optional: Reset tools on server change
        },
      };
    });
  };
  
  const handleToolToggle = (toolName: string) => {
    logger.debug(`Tool toggled: ${toolName}`);
    setNodeData((prev) => {
      if (!prev) return null;
      
      const currentEnabledTools = prev.properties.enabledTools || [];
      let newEnabledTools: string[];
      
      if (currentEnabledTools.includes(toolName)) {
        // Remove tool if already enabled
        newEnabledTools = currentEnabledTools.filter((name: string) => name !== toolName);
      } else {
        // Add tool if not already enabled
        newEnabledTools = [...currentEnabledTools, toolName];
      }
      
      return {
        ...prev,
        properties: {
          ...prev.properties,
          enabledTools: newEnabledTools,
        },
      };
    });
  };

  if (!node || !nodeData) return null;

  const boundServer = nodeData.properties?.boundServer || '';
  const enabledTools = nodeData.properties?.enabledTools || [];

  // Build the server-picker cells (#92). Each server card is a click target
  // that binds the node; selection mirrors the RadioGroup this replaced.
  const renderServerCard = (server: any) => (
    <ServerCard
      name={server.name}
      status={(server.status as any) || 'disconnected'}
      path={server.path || server.rootPath || ''}
      enabled={!server.disabled}
      transport={(server.transport as any) || 'stdio'}
      pickerMode
      selected={boundServer === server.name}
      onClick={() => handleServerSelect(server.name)}
    />
  );
  const toServerCell = (server: any): CardPickerItem => ({ key: server.name, content: renderServerCard(server) });
  const serverPickerItems: CardPickerItem[] = serverPicker.items.map(toServerCell);
  const serverPickerGroups: CardGroup<CardPickerItem>[] | null = serverPicker.groups
    ? serverPicker.groups.map((g) => ({ ...g, items: g.items.map(toServerCell) }))
    : null;
  // Tool call timeout: seconds; -1 = infinite; undefined = 5-minute default.
  const toolTimeout = nodeData.properties?.toolTimeout;
  const isTimeoutInfinite = toolTimeout === TOOL_CALL_TIMEOUT_INFINITE;

  return (
    <Dialog 
      open={open} 
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: { 
          borderTop: 5, 
          borderColor: 'info.main',
          height: '80vh',
          maxHeight: '80vh'
        }
      }}
    >
      <DialogTitle component="div">
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">
            {nodeData.label || 'MCP Node'} Properties
          </Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      
      <Divider />

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 3, overflow: 'auto' }}>
        {/* Node Label Input */}
        <TextField
          fullWidth
          label="Node Label"
          value={nodeData.label || ''}
          onChange={handleLabelChange}
          margin="normal"
          helperText="The display name for this node on the canvas"
          sx={{ mb: 2 }} // Add some bottom margin
        />

        {/* Bind to MCP Server */}
        <Box sx={{ mb: 4 }}>
          <Typography variant="subtitle1" gutterBottom>
            Bind to MCP Server
          </Typography>
          
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
            <Tooltip title="Retry all server connections">
              <span>
                <IconButton
                  size="small"
                  onClick={handleRetryAllServers}
                  disabled={retryingAll || isLoadingServers}
                >
                  {retryingAll ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          <CardPickerGrid
            isLoading={isLoadingServers}
            error={loadError}
            emptyMessage="No MCP servers available. Add some in the MCP Manager."
            loadingMessage="Loading MCP servers…"
            searchable
            searchPlaceholder="Search servers…"
            searchTerm={serverPicker.searchTerm}
            onSearchChange={serverPicker.setSearchTerm}
            columns={{ xs: 12, sm: 6 }}
            items={serverPickerItems}
            groups={serverPickerGroups}
            collapsedKeys={serverPicker.collapsedKeys}
            onToggleGroup={serverPicker.toggleGroup}
          />
          <FormHelperText>
            {boundServer
              ? `This node will use the "${boundServer}" MCP server for processing.`
              : 'Select an MCP server to bind this node to.'}
          </FormHelperText>
        </Box>
        
        {/* Description field - kept */}
        <TextField
          fullWidth
          label="Description"
          value={nodeData.description || ''}
          onChange={(e) => setNodeData({ ...nodeData, description: e.target.value })}
          margin="normal"
          multiline
          rows={2}
          helperText="This description will be displayed on the node"
        />
        
        {/* Tool Call Timeout section */}
        {boundServer && (
          <Box sx={{ mt: 4 }}>
            <Typography variant="subtitle1" gutterBottom>
              Tool Call Timeout
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              How long a single tool call on this server may run before it is aborted.
              Tools that report progress keep the timeout alive while they work.
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <TextField
                label="Timeout (seconds)"
                type="number"
                size="small"
                sx={{ width: 200 }}
                value={isTimeoutInfinite ? '' : (toolTimeout ?? '')}
                placeholder={String(DEFAULT_TOOL_CALL_TIMEOUT_SECONDS)}
                disabled={isTimeoutInfinite}
                inputProps={{ min: 1 }}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') {
                    handlePropertyChange('toolTimeout', undefined);
                    return;
                  }
                  const parsed = parseInt(raw, 10);
                  if (!isNaN(parsed) && parsed > 0) {
                    handlePropertyChange('toolTimeout', parsed);
                  }
                }}
                helperText={isTimeoutInfinite
                  ? 'No timeout — tool calls run until they finish.'
                  : `Empty = default (${DEFAULT_TOOL_CALL_TIMEOUT_SECONDS} seconds / 5 minutes).`}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={isTimeoutInfinite}
                    onChange={(e) => handlePropertyChange(
                      'toolTimeout',
                      e.target.checked ? TOOL_CALL_TIMEOUT_INFINITE : undefined
                    )}
                  />
                }
                label="No timeout (infinite)"
              />
            </Box>
          </Box>
        )}

        {/* Allowed Tools section - new */}
        {boundServer && (
          <Box sx={{ mt: 4 }}>
            <Typography variant="subtitle1" gutterBottom>
              Allowed Tools
            </Typography>
            
            {/* Show message if server is disconnected */}
            {servers.find(s => s.name === boundServer)?.status !== 'connected' && (
              <Box sx={{ mb: 2, p: 2, bgcolor: 'error.light', borderRadius: 1 }}>
                <Typography color="error.dark">
                  Server is disconnected. Tools cannot be fetched. Please retry the connection.
                </Typography>
                <Button 
                  variant="outlined" 
                  size="small" 
                  color="primary" 
                  startIcon={retryingServers[boundServer] ? <CircularProgress size={16} /> : <RefreshIcon />}
                  onClick={() => handleRetryServer(boundServer)}
                  disabled={retryingServers[boundServer]}
                  sx={{ mt: 1 }}
                >
                  Retry Connection
                </Button>
              </Box>
            )}
            
            {isLoadingTools ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <CircularProgress size={20} />
                <Typography color="text.secondary">Loading tools...</Typography>
              </Box>
            ) : toolsError ? (
              <Typography color="error">{toolsError}</Typography>
            ) : !mcpTools || mcpTools.length === 0 ? (
              <Typography color="text.secondary">
                {servers.find(s => s.name === boundServer)?.status === 'connected' 
                  ? "No tools available for this MCP server." 
                  : "Connect to the server to view available tools."}
              </Typography>
            ) : (
              <Box sx={{ mt: 2 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Select which tools this node will have access to. This helps limit the tools available to connected process nodes.
                </Typography>
                
                <List>
                  {mcpTools.map((tool) => (
                    <ListItem key={tool.name} sx={{ py: 0 }}>
                      <ListItemIcon sx={{ minWidth: 42 }}>
                        <Switch
                          edge="start"
                          checked={enabledTools.includes(tool.name)}
                          onChange={() => handleToolToggle(tool.name)}
                        />
                      </ListItemIcon>
                      <ListItemText 
                        primary={tool.name}
                        secondary={tool.description}
                        primaryTypographyProps={{ fontWeight: 'medium' }}
                      />
                    </ListItem>
                  ))}
                </List>
              </Box>
            )}
          </Box>
        )}
        
        {/* Per-node Environment Variables were removed (issue #63): MCP connections
            are singletons keyed by server name and a stdio server's env is fixed at
            spawn, so a per-node env overlay was never applied. Set env on the MCP
            server config itself instead. */}

        {/* Workspace folders (MCP roots) for this node — issue 46. Reuses the server
            modal's RootsManager; these roots are ADDED to the server's own roots while
            this node runs (connections are shared per server, so this is additive
            advisory scoping, not an override). */}
        {boundServer && (
          <Box sx={{ mt: 4 }}>
            <RootsManager
              roots={nodeData.properties?.roots || []}
              onChange={(roots) => handlePropertyChange('roots', roots)}
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              These folders apply to this node only and are <strong>added to</strong> the
              workspace folders configured on the &quot;{boundServer}&quot; server itself.
              When neither is set, the server sees its own root dir as its workspace folder.
            </Typography>
          </Box>
        )}
      </DialogContent>
      
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" color="primary">
          Save Changes
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default MCPNodePropertiesModal;
