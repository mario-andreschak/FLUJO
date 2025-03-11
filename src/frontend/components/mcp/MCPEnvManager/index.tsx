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
  const { servers, saveEnv } = useServerStatus();

  // Find the selected server
  const selectedServer = serverName 
    ? servers.find(server => server.name === serverName) 
    : null;

  // Handle saving environment variables
  const handleSaveEnv = async (env: Record<string, { value: string, metadata: { isSecret: boolean } } | string>) => {
    if (!serverName) return;
    
    log.debug(`Saving environment variables for server: ${serverName}`);
    
    // Convert complex env structure to simple Record<string, string> for saveEnv
    const simpleEnv: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        simpleEnv[key] = value;
      } else if (value && typeof value === 'object' && 'value' in value) {
        simpleEnv[key] = value.value;
      }
    }
    
    await saveEnv(serverName, simpleEnv);
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
      />
    </Box>
  );
};

export default EnvManager;
