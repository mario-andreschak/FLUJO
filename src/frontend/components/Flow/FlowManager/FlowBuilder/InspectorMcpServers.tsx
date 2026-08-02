"use client";

import React, { useMemo, useState } from 'react';
import {
  Box,
  ButtonBase,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import type { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import type { CardGroup } from '@/utils/shared/cardGrouping';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface InspectorMcpConnection {
  nodeId: string;
  serverName: string;
}

export interface InspectorMcpServerOption {
  name: string;
  status?: string;
  transport?: string;
  rootPath?: string;
  serverUrl?: string;
  websocketUrl?: string;
  disabled?: boolean;
  folder?: string;
  favorite?: boolean;
}

interface InspectorMcpServersProps {
  processNodeId: string;
  connections: InspectorMcpConnection[];
  beginnerMode?: boolean;
  onConnect: (processNodeId: string, serverName: string) => void | Promise<void>;
  onRemove: (processNodeId: string, mcpNodeId: string) => void;
  loadServers: () => Promise<InspectorMcpServerOption[]>;
}

const cardStatus = (status?: string): React.ComponentProps<typeof ServerCard>['status'] => {
  if (status === 'connected' || status === 'disconnected' || status === 'error'
    || status === 'connecting' || status === 'initialization' || status === 'requires_authentication') {
    return status;
  }
  if (status === 'starting') return 'connecting';
  return 'disconnected';
};

const cardTransport = (transport?: string): React.ComponentProps<typeof ServerCard>['transport'] => {
  if (transport === 'websocket' || transport === 'sse' || transport === 'streamable') return transport;
  return 'stdio';
};

const InspectorMcpServers: React.FC<InspectorMcpServersProps> = ({
  processNodeId,
  connections,
  beginnerMode = false,
  onConnect,
  onRemove,
  loadServers,
}) => {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [availableServers, setAvailableServers] = useState<InspectorMcpServerOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const connectedNames = useMemo(
    () => new Set(connections.map(connection => connection.serverName)),
    [connections],
  );
  const connectableServers = useMemo(
    () => availableServers.filter(server => !connectedNames.has(server.name)),
    [availableServers, connectedNames],
  );
  const serverPicker = useCardPicker<InspectorMcpServerOption>('mcp', connectableServers);

  const openPicker = async () => {
    setPickerOpen(true);
    setIsLoading(true);
    setLoadError(null);
    try {
      setAvailableServers(await loadServers());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('flows.inspector.mcpLoadError'));
    } finally {
      setIsLoading(false);
    }
  };

  const pickServer = async (serverName: string) => {
    setPickerOpen(false);
    await onConnect(processNodeId, serverName);
  };

  const toServerCell = (server: InspectorMcpServerOption): CardPickerItem => ({
    key: server.name,
    content: beginnerMode ? (
      <ButtonBase
        onClick={() => { void pickServer(server.name); }}
        sx={(theme) => ({
          width: '100%',
          minHeight: 74,
          px: 1.5,
          py: 1.25,
          justifyContent: 'flex-start',
          textAlign: 'left',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 2.5,
          transition: theme.transitions.create(['border-color', 'background-color']),
          '&:hover': {
            borderColor: 'primary.main',
            backgroundColor: 'action.hover',
          },
        })}
      >
        <HubRoundedIcon color="primary" sx={{ mr: 1.25 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={800} noWrap>
            {server.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('flows.inspector.allAppToolsIncluded')}
          </Typography>
        </Box>
      </ButtonBase>
    ) : (
      <ServerCard
        name={server.name}
        status={cardStatus(server.status)}
        path={server.rootPath || server.serverUrl || server.websocketUrl || ''}
        enabled={!server.disabled}
        transport={cardTransport(server.transport)}
        pickerMode
        onClick={() => { void pickServer(server.name); }}
      />
    ),
  });
  const pickerItems = serverPicker.items.map(toServerCell);
  const pickerGroups: CardGroup<CardPickerItem>[] | null = serverPicker.groups
    ? serverPicker.groups.map(group => ({ ...group, items: group.items.map(toServerCell) }))
    : null;
  const heading = beginnerMode
    ? t('flows.inspector.stepApps')
    : t('flows.inspector.connectedMcpServers');
  const addLabel = beginnerMode
    ? t('flows.inspector.addApp')
    : t('flows.inspector.addMcpServer');

  return (
    <Box
      sx={(theme) => ({
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 2.5,
        overflow: 'hidden',
      })}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1.25, py: 0.75 }}>
        <Typography variant="caption" fontWeight={800}>
          {heading}
        </Typography>
        <Tooltip title={addLabel}>
          <IconButton
            size="small"
            aria-label={addLabel}
            onClick={() => { void openPicker(); }}
          >
            <AddRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {connections.length === 0 ? (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ px: 1.25, pb: 1.25 }}>
          {beginnerMode ? t('flows.inspector.noApps') : t('flows.inspector.noMcpServers')}
        </Typography>
      ) : (
        <Stack sx={{ borderTop: 1, borderColor: 'divider' }}>
          {connections.map((connection, index) => (
            <Stack
              key={connection.nodeId}
              direction="row"
              alignItems="center"
              gap={0.75}
              sx={{
                minHeight: 42,
                px: 1,
                borderTop: index === 0 ? 0 : 1,
                borderColor: 'divider',
              }}
            >
              <HubRoundedIcon color="primary" sx={{ fontSize: 17 }} />
              <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                {connection.serverName}
              </Typography>
              <Tooltip title={t(
                beginnerMode ? 'flows.inspector.removeApp' : 'flows.inspector.removeMcpServer',
                { server: connection.serverName },
              )}>
                <IconButton
                  size="small"
                  color="error"
                  aria-label={t(
                    beginnerMode ? 'flows.inspector.removeApp' : 'flows.inspector.removeMcpServer',
                    { server: connection.serverName },
                  )}
                  onClick={() => onRemove(processNodeId, connection.nodeId)}
                >
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      )}

      <CardPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        ariaLabel={beginnerMode ? t('flows.inspector.chooseApp') : t('flows.serverTools.connectTitle')}
        isLoading={isLoading}
        error={loadError}
        emptyMessage={beginnerMode ? t('flows.inspector.noAppsToAdd') : t('flows.serverTools.noneToConnect')}
        searchable
        searchPlaceholder={beginnerMode ? t('flows.inspector.searchApps') : t('flows.serverTools.searchServers')}
        searchTerm={serverPicker.searchTerm}
        onSearchChange={serverPicker.setSearchTerm}
        columns={{ xs: 12, sm: 6 }}
        items={pickerItems}
        groups={pickerGroups}
        collapsedKeys={serverPicker.collapsedKeys}
        onToggleGroup={serverPicker.toggleGroup}
      />
    </Box>
  );
};

export default InspectorMcpServers;
