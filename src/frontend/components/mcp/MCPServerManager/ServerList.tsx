import React from 'react';
import ServerCard from './ServerCard';
import Spinner from '@/frontend/components/shared/Spinner';
import { MCPServerConfig, MCPServerState } from '@/shared/types/';
import { createLogger } from '@/utils/logger';

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
      <div className="flex flex-col items-center justify-center p-8">
        <Spinner size="large" color="primary" />
        <p className="mt-4 text-gray-600">Loading servers...</p>
      </div>
    );
  }

  if (loadError) {
    log.warn('Error loading servers:', loadError);
    return <div className="text-red-500">{loadError}</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {servers.map((server) => (
        <ServerCard
          key={server.name}
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
      ))}
    </div>
  );
};

export default ServerList;
