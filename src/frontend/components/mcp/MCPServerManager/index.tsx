'use client';

import React, { useState, useMemo } from 'react';
import ServerList from './ServerList';
import ServerModal from './Modals/ServerModal/index';
import { MCPServerConfig } from '@/shared/types/mcp';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { createLogger } from '@/utils/logger';
import { useThemeUtils } from '@/frontend/utils/theme';
import { Button, useTheme, Box, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import AddIcon from '@mui/icons-material/Add';

const log = createLogger('frontend/components/mcp/MCPServerManager');

interface ServerManagerProps {
  onServerSelect: (serverName: string) => void;
  onServerModalToggle: (isOpen: boolean) => void;
}

const ServerManager: React.FC<ServerManagerProps> = ({ onServerSelect, onServerModalToggle }) => {
  const {
    servers,
    isLoading,
    loadError,
    connectingServers,
    toggleServer,
    retryServer,
    deleteServer,
    addServer,
    updateServer
  } = useServerStatus();

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServerConfig | null>(null);

  const handleServerToggle = async (serverName: string, enabled: boolean) => {
    log.debug(`Toggling server ${serverName} to ${enabled ? 'enabled' : 'disabled'}`);
    await toggleServer(serverName, enabled);
  };

  const handleServerRetry = async (serverName: string) => {
    log.debug(`Retrying pulling server status for server: ${serverName}`);
    await retryServer(serverName);
  };

  const handleServerDelete = async (serverName: string) => {
    log.debug(`Deleting server: ${serverName}`);
    await deleteServer(serverName);
  };

  const handleEditServer = (server: MCPServerConfig) => {
    log.debug(`Editing server: ${server.name}`);
    setEditingServer(server);
    setShowAddModal(true);
    onServerModalToggle(true);
  };

  const handleAddServer = async (config: MCPServerConfig) => {
    log.debug(`Adding server: ${config.name}`);
    await addServer(config);
    setShowAddModal(false);
    setEditingServer(null); // Ensure editing server is reset
    onServerModalToggle(false);
  };

  const handleUpdateServer = async (config: MCPServerConfig) => {
    log.debug(`Updating server: ${config.name}`);
    await updateServer(config);
    setShowAddModal(false);
    setEditingServer(null);
    onServerModalToggle(false);
  };

  const handleExportConfig = () => {
    log.debug('Exporting server configurations');
    
    const config = {
      mcpServers: Object.fromEntries(
        servers.map((server: any) => {
          // Create a base config object with common properties
          const baseConfig = {
            env: server.env || {},
            disabled: server.disabled,
            autoApprove: server.autoApprove || [],
            transport: server.transport
          };
          
          // Add transport-specific properties
          if (server.transport === 'stdio') {
            return [
              server.name,
              {
                ...baseConfig,
                command: (server as any).command,
                args: (server as any).args || [],
              },
            ];
          } else if (server.transport === 'websocket') {
            return [
              server.name,
              {
                ...baseConfig,
                websocketUrl: (server as any).websocketUrl,
              },
            ];
          }
          
          // Fallback for unknown transport types
          return [server.name, baseConfig];
        })
      ),
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mcp_config.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const { getThemeValue } = useThemeUtils();
  const muiTheme = useTheme();
  
  return (
    <Box sx={{ color: 'text.primary' }}>
      <Box
        sx={{
          p: 2,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="h5">MCP</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="contained"
            color="primary"
            onClick={handleExportConfig}
            startIcon={<DownloadIcon />}
            sx={{
              textTransform: 'none',
              fontWeight: 500,
              boxShadow: 1,
            }}
          >
            Export
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={() => {
              // Ensure editing server is null when adding a new server
              setEditingServer(null);
              setShowAddModal(true);
              onServerModalToggle(true);
            }}
            startIcon={<AddIcon />}
            sx={{
              textTransform: 'none',
              fontWeight: 500,
              boxShadow: 1,
            }}
          >
            Add Server
          </Button>
        </Box>
      </Box>

      <Box sx={{ p: 2, flex: 1, overflow: 'auto' }}>
        <ServerList
          servers={servers.map((server: any) => ({
            ...server,
            tools: [] // Add empty tools array to match the ServerList interface
          }))}
          isLoading={isLoading}
          loadError={loadError}
          onServerSelect={onServerSelect}
          onServerToggle={handleServerToggle}
          onServerRetry={handleServerRetry}
          onServerDelete={handleServerDelete}
          onServerEdit={handleEditServer}
        />
      </Box>

      <ServerModal
        isOpen={showAddModal}
        onAdd={handleAddServer}
        onClose={() => {
          setShowAddModal(false);
          setEditingServer(null);
          onServerModalToggle(false);
        }}
        initialConfig={editingServer}
        onUpdate={handleUpdateServer}
        onRestartAfterUpdate={handleServerRetry}
      />
    </Box>
  );
};

export default ServerManager;
