'use client';

import React from 'react';
import { Box, Paper, Typography } from '@mui/material';
import EnvEditor from './EnvEditor';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPEnvManager');

interface EnvManagerProps {
  serverName: string | null;
}

const EnvManager: React.FC<EnvManagerProps> = ({ serverName }) => {
  const { servers, saveEnv, toggleServer } = useServerStatus();

  // Find the selected server
  const selectedServer = serverName 
    ? servers.find(server => server.name === serverName) 
    : null;

  // Handle saving environment variables
  const handleSaveEnv = async (env: Record<string, { value: string, metadata: { isSecret: boolean } } | string>) => {
    if (!serverName) return;
    
    log.debug(`Saving environment variables for server: ${serverName}`);
    
    // Pass the complete environment structure with metadata to saveEnv
    await saveEnv(serverName, env);
  };

  // Handle server restart after env variable changes
  const handleServerRestart = async (serverName: string) => {
    log.debug(`Restarting server after env variable changes: ${serverName}`);
    
    // Disable the server
    await toggleServer(serverName, false);
    
    // Re-enable the server immediately (no delay)
    await toggleServer(serverName, true);
    
    log.info(`Server ${serverName} restarted after env variable changes`);
  };

  // If no server is selected, show a message
  if (!serverName || !selectedServer) {
    return (
      <Paper
        sx={{
          mt: 4,
          p: 2,
          borderRadius: 2,
          border: 1,
          borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb'
        }}
      >
        <Typography variant="h6" sx={{ mb: 2, fontWeight: 'semibold' }}>
          Environment Variables
        </Typography>
        <Typography color="text.secondary">
          Please select a server to manage environment variables.
        </Typography>
      </Paper>
    );
  }

  return (
    <Box sx={{ mt: 4 }}>
      <EnvEditor
        serverName={serverName}
        initialEnv={selectedServer.env || {}}
        onSave={handleSaveEnv}
        onServerRestart={handleServerRestart}
      />
    </Box>
  );
};

export default EnvManager;
