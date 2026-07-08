import React from 'react';
import ServerCard from './ServerCard';
import Spinner from '@/frontend/components/shared/Spinner';
import { MCPServerConfig, MCPServerState, MCPStreamableConfig } from '@/shared/types/';
import { createLogger } from '@/utils/logger';
import { Grid, Box, Typography, Paper } from '@mui/material';
import { ServerUpdateInfo } from './utils/serverUpdates';

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
  selectionMode?: boolean;
  selectedServers?: Set<string>;
  onServerSelectionChange?: (serverName: string, selected: boolean) => void;
  /** Git update status per repository rootPath, for locally cloned servers. */
  updates?: Record<string, ServerUpdateInfo>;
  /** Called after a server was successfully updated from git. */
  onServerUpdated?: (serverName: string, rootPath: string) => void;
  /** Existing folders on the surface, for the "Move to folder" picker (#71). */
  folders?: string[];
  /** Assign/clear a server's organizing folder (#71). */
  onServerSetFolder?: (serverName: string, folder: string | undefined) => void;
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
  selectionMode = false,
  selectedServers = new Set(),
  onServerSelectionChange,
  updates,
  onServerUpdated,
  folders = [],
  onServerSetFolder,
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
      {servers.map((server) => {
        // Check if this is a streamable server with OAuth tokens
        const hasOAuthTokens = server.transport === 'streamable' && 
          (server as MCPStreamableConfig).oauthTokens !== undefined;
        
        return (
          <Grid item xs={12} md={6} lg={4} key={server.name}>
            <ServerCard
              name={server.name}
              status={server.status}
              path={server.rootPath}
              enabled={!server.disabled}
              transport={server.transport}
              onToggle={(enabled) => onServerToggle(server.name, enabled)}
              onRetry={() => onServerRetry(server.name)}
              onDelete={() => onServerDelete(server.name)}
              onClick={() => onServerSelect(server.name)}
              onEdit={() => onServerEdit(server)}
              error={server.error}
              stderrOutput={server.stderrOutput}
              exposeAsMcpServer={server.exposeAsMcpServer}
              selectionMode={selectionMode}
              selected={selectedServers.has(server.name)}
              onSelect={onServerSelectionChange ? (selected) => onServerSelectionChange(server.name, selected) : undefined}
              hasOAuthTokens={hasOAuthTokens}
              updateInfo={server.rootPath ? updates?.[server.rootPath] : undefined}
              installCommand={server._installCommand}
              buildCommand={server._buildCommand}
              onUpdated={onServerUpdated ? () => onServerUpdated(server.name, server.rootPath) : undefined}
              folder={server.folder}
              folders={folders}
              onSetFolder={onServerSetFolder ? (f) => onServerSetFolder(server.name, f) : undefined}
            />
          </Grid>
        );
      })}
    </Grid>
  );
};

export default ServerList;
