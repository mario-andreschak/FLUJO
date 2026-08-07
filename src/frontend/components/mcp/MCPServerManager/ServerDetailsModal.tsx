'use client';

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  Tabs,
  Tab,
  Divider,
} from '@mui/material';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import ToolManager from '../MCPToolManager';
import type { ToolTesterPrefill } from '../MCPToolManager/ToolTester';
import CapabilitiesManager from '../MCPCapabilitiesManager';
import EnvEditor from '../MCPEnvManager/EnvEditor';
import { EnvVarValue } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';

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
  toolPrefill?: ToolTesterPrefill;
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
  toolPrefill,
}) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<DetailsTab>('tools');

  // Reset to the Tools tab whenever a different server is opened.
  useEffect(() => {
    if (server) setTab('tools');
  }, [server?.name]);

  const open = server !== null;
  const serverName = server?.name || '';
  const statusLabel = (status: string) => {
    switch (status) {
      case 'connected': return t('mcp.status.connected');
      case 'error': return t('mcp.status.error');
      case 'connecting': return t('mcp.status.connecting');
      case 'initialization': return t('mcp.status.initialization');
      default: return t('mcp.status.disconnected');
    }
  };

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
      fullScreen
      slotProps={{
        paper: {
          sx: {
            // Opt out of the global theme's backdropFilter so that
            // position:fixed descendants (MCP App panels) resolve against
            // the real viewport instead of being clipped by this dialog.
            backdropFilter: 'none',
            borderRadius: 0,
            border: 0,
            margin: 0,
            width: '100%',
            maxWidth: '100%',
            height: '100%',
            maxHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      <DialogHeaderActions
        title={(
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, minWidth: 0 }}>
            <Typography variant="h6" sx={{ overflowWrap: 'anywhere' }}>{serverName}</Typography>
            {server && (
              <Typography variant="body2" sx={{ color: statusColor(server.status) }}>
                {statusLabel(server.status)}
              </Typography>
            )}
          </Box>
        )}
        onClose={onClose}
      />
      <DialogTitle component="div" sx={{ pt: 0, pb: 0 }}>
        <Tabs value={tab} onChange={(_, v: DetailsTab) => setTab(v)} sx={{ mt: 0 }}>
          <Tab label={t('mcp.details.tools')} value="tools" />
          <Tab label={t('mcp.details.resources')} value="resources" />
          <Tab label={t('mcp.details.prompts')} value="prompts" />
          <Tab label={t('mcp.details.env')} value="env" />
        </Tabs>
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Keep the active server name; render only the active tab's content. */}
        {open && tab === 'tools' && <ToolManager serverName={serverName} prefill={toolPrefill} />}
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
