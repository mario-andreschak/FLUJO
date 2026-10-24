'use client';

import React from 'react';
import { Box, Button } from '@mui/material';
import ServerManager from './MCPServerManager';
import { useI18n } from '@/frontend/contexts/I18nContext';

/**
 * MCP management page. The server list is the whole page now — inspecting a single server
 * (Tools / Resources / Prompts / Environment Variables) happens in a tabbed modal opened
 * from its card (see ServerDetailsModal), instead of long panels stacked below the list.
 */
const MCPManager: React.FC<{ controllerAccount?: boolean }> = ({ controllerAccount = false }) => {
  const { t } = useI18n();
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {controllerAccount && <Box sx={{ px: 2, pt: 1 }}><Button component="a" href="/teams/mcp">{t('teams.mcp.title')}</Button></Box>}
      <ServerManager />
    </Box>
  );
};

export default MCPManager;
