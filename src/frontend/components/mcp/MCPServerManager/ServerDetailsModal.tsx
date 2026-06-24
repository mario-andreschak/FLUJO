'use client';

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  IconButton,
  Tabs,
  Tab,
  Divider,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ToolManager from '../MCPToolManager';
import CapabilitiesManager from '../MCPCapabilitiesManager';
import EnvEditor from '../MCPEnvManager/EnvEditor';
import { EnvVarValue } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPServerManager/ServerDetailsModal');

type EnvRecord = Record<string, { value: string; metadata: { isSecret: boolean } } | string>;

// The subset of the server state this modal needs (from useServerStatus).
export interface DetailsServer {
  name: string;
  status: string;
  env?: Record<string, EnvVarValue>;
}

interface ServerDetailsModalProps {
  server: DetailsServer | null;
  onClose: () => void;
  onSaveEnv: (serverName: string, env: EnvRecord) => Promise<boolean> | Promise<void> | void;
  onServerRestart: (serverName: string) => Promise<void> | void;
}

type DetailsTab = 'tools' | 'resources' | 'prompts' | 'env';

const statusColor = (status: string) =>
  status === 'connected'
    ? 'success.main'
    : status === 'error'
      ? 'error.main'
      : status === 'connecting' || status === 'initialization'
        ? 'info.main'
        : 'text.secondary';

/**
 * Single tabbed modal for inspecting one MCP server: Tools, Resources, Prompts, and
 * Environment Variables. Replaces the long vertically-stacked panels that grew with the
 * server list and forced endless scrolling. Opened only for enabled servers.
 */
const ServerDetailsModal: React.FC<ServerDetailsModalProps> = ({
  server,
  onClose,
  onSaveEnv,
  onServerRestart,
}) => {
  const [tab, setTab] = useState<DetailsTab>('tools');

  // Reset to the Tools tab whenever a different server is opened.
  useEffect(() => {
    if (server) setTab('tools');
  }, [server?.name]);

  const open = server !== null;
  const serverName = server?.name || '';

  const handleSaveEnv = async (env: EnvRecord) => {
    if (server) {
      log.debug(`Saving env for ${server.name}`);
      await onSaveEnv(server.name, env);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{ sx: { height: '85vh', maxHeight: '85vh' } }}
    >
      <DialogTitle component="div" sx={{ pb: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
            <Typography variant="h6">{serverName}</Typography>
            {server && (
              <Typography variant="body2" sx={{ color: statusColor(server.status) }}>
                {server.status}
              </Typography>
            )}
          </Box>
          <IconButton edge="end" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
        <Tabs value={tab} onChange={(_, v: DetailsTab) => setTab(v)} sx={{ mt: 1 }}>
          <Tab label="Tools" value="tools" />
          <Tab label="Resources" value="resources" />
          <Tab label="Prompts" value="prompts" />
          <Tab label="Environment Variables" value="env" />
        </Tabs>
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ overflow: 'auto' }}>
        {/* Keep the active server name; render only the active tab's content. */}
        {open && tab === 'tools' && <ToolManager serverName={serverName} />}
        {open && tab === 'resources' && <CapabilitiesManager serverName={serverName} show="resources" />}
        {open && tab === 'prompts' && <CapabilitiesManager serverName={serverName} show="prompts" />}
        {open && tab === 'env' && (
          <Box sx={{ mt: 1 }}>
            <EnvEditor
              serverName={serverName}
              initialEnv={server?.env || {}}
              onSave={handleSaveEnv}
              onServerRestart={async (name) => {
                await onServerRestart(name);
              }}
            />
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ServerDetailsModal;
