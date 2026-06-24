'use client';

import React from 'react';
import { Box } from '@mui/material';
import ServerManager from './MCPServerManager';

/**
 * MCP management page. The server list is the whole page now — inspecting a single server
 * (Tools / Resources / Prompts / Environment Variables) happens in a tabbed modal opened
 * from its card (see ServerDetailsModal), instead of long panels stacked below the list.
 */
const MCPManager: React.FC = () => {
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ServerManager />
    </Box>
  );
};

export default MCPManager;
