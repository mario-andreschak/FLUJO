import React from 'react';
import ServerCard from './ServerCard';
import Spinner from '@/frontend/components/shared/Spinner';
import { MCPServerConfig, MCPServerState } from '@/shared/types/';
import { createLogger } from '@/utils/logger';
import { Grid, Box, Typography, Paper } from '@mui/material';

const log = createLogger('frontend/components/mcp/MCPServerManager/ServerList');

interface ServerListProps {
  servers: MCPServerState[];
  isLoading: boolean;
  loadError: string | null;
  onServerSelect: (serverName: string) => void;
  onServerToggle: (serverName: string, enabled: boolean) => void;
  onServerRetry: (serverName: string) => void;
  onServerDelete: (serverName: string) => void;
  onServerEdit: (server: MCPServerConfig) => void;
}

const ServerList: React.FC<ServerListProps> = ({
  servers,
  isLoading,
  loadError,
  onServerSelect,
  onServerToggle,
  onServerRetry,
  onServerDelete,
  onServerEdit,
}) => {
  log.debug('Rendering ServerList', { 
    serverCount: servers.length, 
    isLoading, 
    hasError: !!loadError 
  });
  
  if (isLoading) {
    log.debug('Servers are loading');
    return (
      <Box sx={{ 
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        justifyContent: 'center', 
        p: 4 
      }}>
        <Spinner size="large" color="primary" />
        <Typography sx={{ mt: 2, color: 'text.secondary' }}>
          Loading servers...
        </Typography>
      </Box>
    );
  }

  if (loadError) {
    log.warn('Error loading servers:', loadError);
    return (
      <Paper sx={{ p: 3, bgcolor: 'error.light', color: 'error.contrastText', borderRadius: 1 }}>
        <Typography color="error">{loadError}</Typography>
      </Paper>
    );
  }

  if (servers.length === 0) {
    return (
      <Paper sx={{ p: 3, textAlign: 'center', borderRadius: 1 }}>
        <Typography color="text.secondary">
          No servers configured. Click "Add Server" to get started.
        </Typography>
      </Paper>
    );
  }

  return (
    <Grid container spacing={2}>
      {servers.map((server) => (
        <Grid item xs={12} md={6} lg={4} key={server.name}>
          <ServerCard
            name={server.name}
            status={server.status}
            path={server.rootPath}
            enabled={!server.disabled}
            onToggle={(enabled) => onServerToggle(server.name, enabled)}
            onRetry={() => onServerRetry(server.name)}
            onDelete={() => onServerDelete(server.name)}
            onClick={() => onServerSelect(server.name)}
            onEdit={() => onServerEdit(server)}
            error={server.error}
            stderrOutput={server.stderrOutput}
          />
        </Grid>
      ))}
    </Grid>
  );
};

export default ServerList;
