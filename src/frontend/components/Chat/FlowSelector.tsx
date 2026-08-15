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
import CardPickerGrid, { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import FlowCard, { FlowCardSkeleton } from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { CardGroup } from '@/utils/shared/cardGrouping';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { BIG_TUTORIAL_EVENT, isBigTutorialEvent } from '@/frontend/components/Tour/bigTutorialEvents';

interface FlowSelectorProps {
  selectedFlowId: string | null;
  onSelectFlow: (flowId: string) => void;
  disabled?: boolean; // Add disabled prop
  /** Hide the internal "Select Agent" subtitle when the host already renders a heading. */
  hideLabel?: boolean;
  /** Single-row phone treatment; the picker itself becomes full-screen. */
  compact?: boolean;
  /** Override whether the picker dialog fills the viewport. */
  fullScreenPicker?: boolean;
  /** Render only the picker body so a parent can host it in a shared dialog. */
  embedded?: boolean;
  /** Search supplied by an external launcher, such as the guided tour. */
  externalSearchTerm?: string;
  /** Report the selected Agent's display name to an external trigger. */
  onSelectedFlowNameChange?: (name: string) => void;
}

const FlowSelector: React.FC<FlowSelectorProps> = ({
  selectedFlowId,
  onSelectFlow,
  disabled = false, // Default to false
  hideLabel = false,
  compact = false,
  fullScreenPicker,
  embedded = false,
  externalSearchTerm,
  onSelectedFlowNameChange,
}) => {
  const { t } = useI18n();
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
        setError(t('chat.selector.loadFailed'));
      } finally {
        setIsLoading(false);
      }
    };

    loadFlows();
  }, [t]);

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

  useEffect(() => {
    const listener = (event: Event) => {
      if (!isBigTutorialEvent(event) || event.detail.type !== 'open-chat-flow-picker') return;
      setPickerOpen(true);
      flowPicker.setSearchTerm(event.detail.query);
    };
    window.addEventListener(BIG_TUTORIAL_EVENT, listener);
    return () => window.removeEventListener(BIG_TUTORIAL_EVENT, listener);
  }, [flowPicker]);

  useEffect(() => {
    if (externalSearchTerm !== undefined) flowPicker.setSearchTerm(externalSearchTerm);
  }, [externalSearchTerm, flowPicker.setSearchTerm]);
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

  useEffect(() => {
    onSelectedFlowNameChange?.(selectedFlowName);
  }, [onSelectedFlowNameChange, selectedFlowName]);

  if (embedded) {
    return (
      <CardPickerGrid
        isLoading={isLoading}
        error={error}
        loadingMessage={t('chat.selector.loading')}
        skeleton={<FlowCardSkeleton />}
        emptyMessage={t('chat.selector.empty')}
        searchable
        searchPlaceholder={t('flows.dashboard.search')}
        searchTerm={flowPicker.searchTerm}
        onSearchChange={flowPicker.setSearchTerm}
        items={flowPickerItems}
        groups={flowPickerGroups}
        collapsedKeys={flowPicker.collapsedKeys}
        onToggleGroup={flowPicker.toggleGroup}
      />
    );
  }

  return (
    <Box sx={{ minWidth: 0 }} data-tour="chat-flow-picker">
      {!hideLabel && !compact && (
        <Typography variant="subtitle1" gutterBottom>
          {t('chat.selector.title')}
        </Typography>
      )}

      {isLoading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
          {t('chat.selector.loading')}
          </Typography>
        </Box>
      ) : error ? (
        <Typography color="error" variant="body2">
          {error}
        </Typography>
      ) : flows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('chat.selector.empty')}
        </Typography>
      ) : (
        <>
          {/* The picker itself reuses the Flow dashboard card layout (#92) so
              choosing a flow here looks exactly like the Flows page. */}
          <Button
            data-tour="chat-flow-picker-button"
            variant="outlined"
            size={compact ? 'small' : 'medium'}
            startIcon={<AccountTreeOutlinedIcon />}
            onClick={() => setPickerOpen(true)}
            disabled={disabled}
            sx={{
              textTransform: 'none',
              maxWidth: '100%',
              minWidth: 0,
              ...(compact && { minHeight: 36, px: 1.25 }),
            }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedFlowId ? (selectedFlowName || t('chat.selector.title')) : t('chat.selector.title')}
            </Box>
          </Button>
          {!compact && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              {selectedFlowId
                ? t('chat.selector.using', { agent: selectedFlowName })
                : t('chat.selector.help')}
            </Typography>
          )}

          <CardPickerDialog
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            fullScreen={fullScreenPicker ?? compact}
            title={t('chat.selector.title')}
            description={t('chat.selector.dialogHelp')}
            skeleton={<FlowCardSkeleton />}
            emptyMessage={t('chat.selector.empty')}
            searchable
            searchPlaceholder={t('flows.dashboard.search')}
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
