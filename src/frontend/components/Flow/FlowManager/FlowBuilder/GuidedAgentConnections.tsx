"use client";

import React, { useMemo, useState } from 'react';
import {
  Box,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import type { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import FlowCard from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import type { Flow } from '@/frontend/types/flow/flow';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface GuidedAgentConnection {
  nodeId: string;
  flowId: string;
  flowName: string;
}

interface GuidedAgentConnectionsProps {
  processNodeId: string;
  currentFlowId: string;
  flows: Flow[];
  connections: GuidedAgentConnection[];
  onConnect: (processNodeId: string, flowId: string) => void;
  onRemove: (processNodeId: string, subflowNodeId: string) => void;
}

const GuidedAgentConnections: React.FC<GuidedAgentConnectionsProps> = ({
  processNodeId,
  currentFlowId,
  flows,
  connections,
  onConnect,
  onRemove,
}) => {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const connectedFlowIds = useMemo(
    () => new Set(connections.map(connection => connection.flowId)),
    [connections],
  );
  const selectableFlows = useMemo(
    () => flows.filter(flow => flow.id !== currentFlowId && !connectedFlowIds.has(flow.id)),
    [connectedFlowIds, currentFlowId, flows],
  );
  const flowPicker = useCardPicker<Flow>('flows', selectableFlows);

  const selectAgent = (flowId: string) => {
    setPickerOpen(false);
    onConnect(processNodeId, flowId);
  };
  const toPickerItem = (flow: Flow): CardPickerItem => ({
    key: flow.id,
    content: (
      <FlowCard
        flow={flow}
        selected={false}
        onSelect={selectAgent}
        pickerMode
      />
    ),
  });

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
          {t('flows.guided.talksToAgents')}
        </Typography>
        <Tooltip title={t('flows.guided.addAgent')}>
          <IconButton
            size="small"
            aria-label={t('flows.guided.addAgent')}
            onClick={() => setPickerOpen(true)}
          >
            <AddRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {connections.length === 0 ? (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ px: 1.25, pb: 1.25 }}>
          {t('flows.guided.noAgents')}
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
              <AccountTreeOutlinedIcon color="primary" sx={{ fontSize: 17 }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {connection.flowName}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap display="block">
                  {t('flows.guided.agentIo')}
                </Typography>
              </Box>
              <Tooltip title={t('flows.guided.removeAgent', { agent: connection.flowName })}>
                <IconButton
                  size="small"
                  color="error"
                  aria-label={t('flows.guided.removeAgent', { agent: connection.flowName })}
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
        ariaLabel={t('flows.guided.chooseAgent')}
        emptyMessage={t('flows.guided.noAgentsToAdd')}
        searchable
        searchPlaceholder={t('flows.guided.searchAgents')}
        searchTerm={flowPicker.searchTerm}
        onSearchChange={flowPicker.setSearchTerm}
        items={flowPicker.items.map(toPickerItem)}
        groups={flowPicker.groups
          ? flowPicker.groups.map(group => ({ ...group, items: group.items.map(toPickerItem) }))
          : null}
        collapsedKeys={flowPicker.collapsedKeys}
        onToggleGroup={flowPicker.toggleGroup}
      />
    </Box>
  );
};

export default GuidedAgentConnections;
