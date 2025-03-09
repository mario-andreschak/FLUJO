'use client';

import React, { useState } from 'react';
import ServerManager from './MCPServerManager';
import ToolManager from './MCPToolManager';
import EnvManager from './MCPEnvManager';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp');

const MCPManager: React.FC = () => {
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [isServerModalOpen, setIsServerModalOpen] = useState<boolean>(false);

  const handleServerSelect = (serverName: string) => {
    log.debug(`Selected server: ${serverName}`);
    setSelectedServer(serverName);
  };

  const handleServerModalToggle = (isOpen: boolean) => {
    log.debug(`Server modal ${isOpen ? 'opened' : 'closed'}`);
    setIsServerModalOpen(isOpen);
  };

  return (
    <div className="p-6">
      {/* Server Management Section */}
      <ServerManager 
        onServerSelect={handleServerSelect} 
        onServerModalToggle={handleServerModalToggle}
      />
      
      {/* Tool Testing Section - Hide when server modal is open */}
      {selectedServer && !isServerModalOpen && (
        <ToolManager serverName={selectedServer} />
      )}
      
      {/* Environment Variables Section - Hide when server modal is open */}
      {selectedServer && !isServerModalOpen && (
        <EnvManager serverName={selectedServer} />
      )}
    </div>
  );
};

export default MCPManager;
