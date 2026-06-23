'use client';

import React, { useState } from 'react';
import { Box, Container } from '@mui/material';
import ServerManager from './MCPServerManager';
import ToolManager from './MCPToolManager';
import EnvManager from './MCPEnvManager';
import CapabilitiesManager from './MCPCapabilitiesManager';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp');

const MCPManager: React.FC = () => {
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [isServerModalOpen, setIsServerModalOpen] = useState<boolean>(false);
  // Whether the tool tester panel is shown. Selecting a server (re-)opens it;
  // the panel's close button hides it without clearing the server selection.
  const [showToolTester, setShowToolTester] = useState<boolean>(true);

  const handleServerSelect = (serverName: string) => {
    log.debug(`Selected server: ${serverName}`);
    setSelectedServer(serverName);
    setShowToolTester(true);
  };

  const handleServerModalToggle = (isOpen: boolean) => {
    log.debug(`Server modal ${isOpen ? 'opened' : 'closed'}`);
    setIsServerModalOpen(isOpen);
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Server Management Section */}
      <ServerManager 
        onServerSelect={handleServerSelect} 
        onServerModalToggle={handleServerModalToggle}
      />
      
      {/* Tool Testing Section - Hide when server modal is open or when dismissed */}
      {selectedServer && !isServerModalOpen && showToolTester && (
        <Box sx={{ p: 2, flex: 1, overflow: 'auto' }}>
          <ToolManager serverName={selectedServer} onClose={() => setShowToolTester(false)} />
        </Box>
      )}

      {/* Resources & Prompts (#15) - same visibility rules as the tool tester */}
      {selectedServer && !isServerModalOpen && showToolTester && (
        <Box sx={{ px: 2, pb: 2 }}>
          <CapabilitiesManager serverName={selectedServer} />
        </Box>
      )}

      {/* Environment Variables Section - Hide when server modal is open */}
      {selectedServer && !isServerModalOpen && (
        <Box sx={{ p: 2, flex: 1, overflow: 'auto' }}>
          <EnvManager serverName={selectedServer} />
        </Box>
      )}
    </Box>
  );
};

export default MCPManager;
