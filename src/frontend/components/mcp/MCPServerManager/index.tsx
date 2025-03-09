'use client';

import React, { useState, useMemo } from 'react';
import ServerList from './ServerList';
import ServerModal from './Modals/ServerModal/index';
import { MCPServerConfig } from '@/backend/types/mcp';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { createLogger } from '@/utils/logger';

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

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">MCP Server Management</h2>
        <div className="flex space-x-2">
          <button
            onClick={handleExportConfig}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center gap-2"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
            Export
          </button>
          <button
            onClick={() => {
              setShowAddModal(true);
              onServerModalToggle(true);
            }}
            className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                clipRule="evenodd"
              />
            </svg>
            Add Server
          </button>
        </div>
      </div>

      {/* Add empty tools array to each server to match the ServerList interface */}
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
    </div>
  );
};

export default ServerManager;
