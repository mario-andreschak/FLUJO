"use client";

import React, { useState, useEffect } from 'react';
import {
  Typography,
  Box,
  CircularProgress,
  Button,
} from '@mui/material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import FlowCard, { FlowCardSkeleton } from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { CardGroup } from '@/utils/shared/cardGrouping';

interface FlowSelectorProps {
  selectedFlowId: string | null;
  onSelectFlow: (flowId: string) => void;
  disabled?: boolean; // Add disabled prop
  /** Hide the internal "Select Flow" subtitle when the host already renders a heading. */
  hideLabel?: boolean;
}

const FlowSelector: React.FC<FlowSelectorProps> = ({
  selectedFlowId,
  onSelectFlow,
  disabled = false, // Default to false
  hideLabel = false
}) => {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Load flows on component mount
  useEffect(() => {
    const loadFlows = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const loadedFlows = await flowService.loadFlows();
        setFlows(loadedFlows);
      } catch (err) {
        console.error('Error loading flows:', err);
        setError('Failed to load flows');
      } finally {
        setIsLoading(false);
      }
    };

    loadFlows();
  }, []);

  // Get selected flow name
  const getSelectedFlowName = () => {
    if (!selectedFlowId) return '';
    const flow = flows.find(f => f.id === selectedFlowId);
    return flow ? flow.name : '';
  };

  const handleSelect = (flowId: string) => {
    onSelectFlow(flowId);
    setPickerOpen(false);
  };

  // Toggle favorite directly from the picker (#120): persist via the same seam
  // the dashboard uses, then reflect it locally so the ordering updates live.
  const handleToggleFavorite = async (flowId: string) => {
    const flow = flows.find(f => f.id === flowId);
    if (!flow) return;
    const nextFavorite = !flow.favorite;
    const updated: Flow = { ...flow, favorite: nextFavorite || undefined };
    try {
      const result = await flowService.updateFlow(updated);
      if (result.success) {
        setFlows(prev => prev.map(f => (f.id === flowId ? updated : f)));
      }
    } catch (err) {
      console.error('Error toggling flow favorite:', err);
    }
  };

  // Route the picker through the shared view-model (#92) so it mirrors the
  // Flows page's saved search/sort/folder settings; favorites-first (#120) is
  // preserved by the hook's flows adapter.
  const flowPicker = useCardPicker<Flow>('flows', flows);
  const renderFlowCard = (flow: Flow) => (
    <FlowCard
      flow={flow}
      selected={flow.id === selectedFlowId}
      onSelect={handleSelect}
      onToggleFavorite={handleToggleFavorite}
      pickerMode
    />
  );
  const toFlowCell = (flow: Flow): CardPickerItem => ({ key: flow.id, content: renderFlowCard(flow) });
  const flowPickerItems: CardPickerItem[] = flowPicker.items.map(toFlowCell);
  const flowPickerGroups: CardGroup<CardPickerItem>[] | null = flowPicker.groups
    ? flowPicker.groups.map((g) => ({ ...g, items: g.items.map(toFlowCell) }))
    : null;

  const selectedFlowName = getSelectedFlowName();

  return (
    <Box>
      {!hideLabel && (
        <Typography variant="subtitle1" gutterBottom>
          Select Flow
        </Typography>
      )}

      {isLoading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Loading flows...
          </Typography>
        </Box>
      ) : error ? (
        <Typography color="error" variant="body2">
          {error}
        </Typography>
      ) : flows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No flows available. Create some flows in the Flow Builder first.
        </Typography>
      ) : (
        <>
          {/* The picker itself reuses the Flow dashboard card layout (#92) so
              choosing a flow here looks exactly like the Flows page. */}
          <Button
            variant="outlined"
            startIcon={<AccountTreeOutlinedIcon />}
            onClick={() => setPickerOpen(true)}
            disabled={disabled}
            sx={{ textTransform: 'none', maxWidth: '100%' }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedFlowId ? (selectedFlowName || 'Select a flow') : 'Select a flow'}
            </Box>
          </Button>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            {selectedFlowId
              ? `Using "${selectedFlowName}" flow for this conversation`
              : 'Select a flow to use for this conversation'}
          </Typography>

          <CardPickerDialog
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            title="Select a flow"
            description="Pick the flow this conversation will run."
            skeleton={<FlowCardSkeleton />}
            emptyMessage="No flows available. Create some flows in the Flow Builder first."
            searchable
            searchPlaceholder="Search flows…"
            searchTerm={flowPicker.searchTerm}
            onSearchChange={flowPicker.setSearchTerm}
            items={flowPickerItems}
            groups={flowPickerGroups}
            collapsedKeys={flowPicker.collapsedKeys}
            onToggleGroup={flowPicker.toggleGroup}
          />
        </>
      )}
    </Box>
  );
};

export default FlowSelector;
