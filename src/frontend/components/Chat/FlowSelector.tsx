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
import FlowCard, { FlowCardSkeleton } from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import { sortFlowsFavoritesFirst } from '@/utils/shared/flowGrouping';

interface FlowSelectorProps {
  selectedFlowId: string | null;
  onSelectFlow: (flowId: string) => void;
  disabled?: boolean; // Add disabled prop
}

const FlowSelector: React.FC<FlowSelectorProps> = ({
  selectedFlowId,
  onSelectFlow,
  disabled = false // Default to false
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

  // Favorites first (#120), then A–Z, so favorited flows surface at the top of
  // the picker.
  const orderedFlows = sortFlowsFavoritesFirst(flows, 'name-asc');

  const selectedFlowName = getSelectedFlowName();

  return (
    <Box>
      <Typography variant="subtitle1" gutterBottom>
        Select Flow
      </Typography>

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
            items={orderedFlows.map((flow) => ({
              key: flow.id,
              content: (
                <FlowCard
                  flow={flow}
                  selected={flow.id === selectedFlowId}
                  onSelect={handleSelect}
                  onToggleFavorite={handleToggleFavorite}
                  pickerMode
                />
              ),
            }))}
          />
        </>
      )}
    </Box>
  );
};

export default FlowSelector;
