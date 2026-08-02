"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  IconButton,
  Divider,
  TextField,
  Alert,
  FormControlLabel,
  Switch,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import HistoryIcon from '@mui/icons-material/History';
import ShortTextIcon from '@mui/icons-material/ShortText';
import EditNoteIcon from '@mui/icons-material/EditNote';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { FlowNode, Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import OptionCard from '@/frontend/components/shared/OptionCard';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import FlowCard, { FlowCardSkeleton } from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { CardGroup } from '@/utils/shared/cardGrouping';
import CaptureFields from './shared/CaptureFields';
import { parseKvRef, buildKvRef, KvRefScope } from '@/utils/shared/resolveKvRefs';
import { createLogger } from '@/utils/logger';
import type { FlowAuthoringMode } from '@/utils/shared/flowAuthoringProfile';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/SubflowNodePropertiesModal');

interface SubflowNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
  onNavigateToFlow?: (flowId: string) => void;
  /** The id of the flow being edited, so it can be excluded from the picker. */
  flowId?: string;
  authoringMode?: FlowAuthoringMode;
}

export const SubflowNodePropertiesModal = ({
  open,
  node,
  onClose,
  onSave,
  onNavigateToFlow,
  flowId,
  authoringMode = 'advanced',
}: SubflowNodePropertiesModalProps) => {
  const { t } = useI18n();
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  const [flows, setFlows] = useState<Flow[]>([]);
  const [loadingFlows, setLoadingFlows] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Data-flow capture editors (issue #203, Phase 3 of #186). captureKv is split
  // into scope + key for editing and recombined via buildKvRef on save.
  const [captureVariable, setCaptureVariable] = useState('');
  const [captureResource, setCaptureResource] = useState('');
  const [captureKvScope, setCaptureKvScope] = useState<KvRefScope>('folder');
  const [captureKvKey, setCaptureKvKey] = useState('');

  useEffect(() => {
    if (node) {
      const existing = node.data.properties || {};
      // Issue #138: do NOT seed default values (previously `allowCallerPrompt`/
      // `saveConversation` were forced to `?? true` here). Seeding baked those
      // defaults into stored data on ANY save — e.g. opening the modal to change
      // something unrelated and hitting Save silently wrote `saveConversation:
      // true`, flooding the sidebar. The canonical "absent => ON" default now
      // lives in ONE place on both layers: the checkbox display below renders
      // `!== false`, and the backend treats absent as ON. Initialize from the
      // stored properties unchanged so an unset field stays unset until the user
      // actually toggles it.
      setNodeData({
        ...node.data,
        properties: { ...existing },
      });
      // Data-flow capture (issue #203). parseKvRef('') → { scope:'folder', key:'' }.
      setCaptureVariable(existing.captureVariable || '');
      setCaptureResource(existing.captureResource || '');
      const kvParsed = parseKvRef(existing.captureKv || '');
      setCaptureKvScope(kvParsed.scope);
      setCaptureKvKey(kvParsed.key || '');
    }
  }, [node, open]);

  // Load the available flows to choose from when the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingFlows(true);
    flowService.loadFlows()
      .then((loaded) => {
        if (!cancelled) setFlows(loaded || []);
      })
      .catch((err) => {
        log.warn('Failed to load flows for subflow picker', err);
        if (!cancelled) setFlows([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFlows(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  const handlePropertyChange = (key: string, value: any) => {
    setNodeData((prev) => {
      if (!prev) return null;
      return { ...prev, properties: { ...prev.properties, [key]: value } };
    });
  };

  // Removing a key (rather than storing an empty/default value) keeps saved
  // node data minimal and lets the runtime apply its canonical defaults.
  const removeProperty = (key: string) => {
    setNodeData((prev) => {
      if (!prev) return null;
      const p = { ...prev.properties };
      delete p[key];
      return { ...prev, properties: p };
    });
  };

  const handleSave = () => {
    if (node && nodeData) {
      if (authoringMode === 'guided') {
        onSave(node.id, nodeData);
        onClose();
        return;
      }
      const properties = { ...nodeData.properties };

      // Data-flow capture (issue #203): set the trimmed value or REMOVE the key
      // when empty, so flowToSpec never emits an empty captureX and existing
      // flows without these fields stay byte-identical.
      const cv = captureVariable.trim();
      if (cv) properties.captureVariable = cv; else delete properties.captureVariable;
      const cr = captureResource.trim();
      if (cr) properties.captureResource = cr; else delete properties.captureResource;
      const ckv = buildKvRef(captureKvScope, captureKvKey);
      if (ckv) properties.captureKv = ckv; else delete properties.captureKv;

      onSave(node.id, { ...nodeData, properties });
      onClose();
    }
  };

  // A flow shouldn't call itself (the runtime depth guard catches deeper loops,
  // but selecting yourself is an obvious footgun), so exclude the current flow
  // BEFORE the picker view-model. Computed above the early-return below so the
  // hook is called unconditionally (Rules of Hooks).
  const selectableFlows = flows.filter((f) => f.id !== flowId);
  // Route the picker through the shared view-model (#92) so it mirrors the
  // Flows page's saved search/sort/folder settings (favorites-first via #120).
  const flowPicker = useCardPicker<Flow>('flows', selectableFlows);

  if (!node || !nodeData) return null;

  const selectedSubflowId = nodeData.properties?.subflowId || '';
  const selectedMissing = !!selectedSubflowId && !flows.some((f) => f.id === selectedSubflowId);
  const selectedSubflowName = selectedMissing
    ? ''
    : flows.find((f) => f.id === selectedSubflowId)?.name || '';

  // Older saved flows may still carry the removed fan-out/map authoring fields.
  // The runtime keeps reading them for compatibility, but the simplified modal
  // no longer creates or edits them.
  const hasLegacyExecution =
    (Array.isArray(nodeData.properties?.parallelSubflowIds) && nodeData.properties.parallelSubflowIds.length > 0) ||
    !!nodeData.properties?.parallelSubflowIdsVar ||
    nodeData.properties?.mapOverList === true ||
    (Array.isArray(nodeData.properties?.spawnBriefs) && nodeData.properties.spawnBriefs.length > 0);

  // Back-compat: a flow saved before the explicit 'isolated' mode existed just
  // has a promptTemplate and no inputMode — surface it as Isolated so the same
  // prompt keeps being sent (this mirrors SubflowNode.prep's runtime fallback).
  const promptTemplate = nodeData.properties?.promptTemplate || '';
  const inputMode: 'full-history' | 'latest-message' | 'isolated' =
    nodeData.properties?.inputMode || (promptTemplate.trim() ? 'isolated' : 'full-history');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          borderTop: 5,
          borderColor: 'warning.main',
          maxWidth: '95vw',
          maxHeight: '90vh',
        },
      }}
    >
      <DialogTitle component="div">
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">
            {t('flows.modal.properties', { name: nodeData.label || t('flows.subflow.title') })}
          </Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label={t('flows.modal.close')}>
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('flows.subflow.intro')}
        </Typography>

        <TextField
          fullWidth
          label={t('flows.subflow.nodeLabel')}
          value={nodeData.label || ''}
          onChange={(e) => setNodeData({ ...nodeData, label: e.target.value })}
          margin="normal"
        />

        {/* Flow picker reuses the Flows dashboard card layout (#92) so choosing
            a subflow looks exactly like the Flows page. */}
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {t('flows.subflow.flowToRun')}
          </Typography>
          <Button
            variant="outlined"
            startIcon={<AccountTreeOutlinedIcon />}
            onClick={() => setPickerOpen(true)}
            sx={{ textTransform: 'none', maxWidth: '100%' }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedSubflowName || t('flows.subflow.choose')}
            </Box>
          </Button>
        </Box>

        {selectedMissing && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {t('flows.subflow.missing')}
          </Alert>
        )}

        {hasLegacyExecution && (
          <Alert severity="info" sx={{ mt: 1 }}>
            {t('flows.subflow.legacyExecution')}
          </Alert>
        )}

        <CardPickerDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title={t('flows.subflow.pickerTitle')}
          description={t('flows.subflow.pickerHelp')}
          isLoading={loadingFlows}
          skeleton={<FlowCardSkeleton />}
          emptyMessage={t('flows.subflow.pickerEmpty')}
          searchable
          searchPlaceholder={t('flows.subflow.search')}
          searchTerm={flowPicker.searchTerm}
          onSearchChange={flowPicker.setSearchTerm}
          items={flowPicker.items.map((f) => ({
            key: f.id,
            content: (
              <FlowCard
                flow={f}
                selected={f.id === selectedSubflowId}
                onSelect={(id) => {
                  handlePropertyChange('subflowId', id);
                  setPickerOpen(false);
                }}
                pickerMode
              />
            ),
          }))}
          groups={flowPicker.groups
            ? flowPicker.groups.map((g) => ({
                ...g,
                items: g.items.map((f): CardPickerItem => ({
                  key: f.id,
                  content: (
                    <FlowCard
                      flow={f}
                      selected={f.id === selectedSubflowId}
                      onSelect={(id) => {
                        handlePropertyChange('subflowId', id);
                        setPickerOpen(false);
                      }}
                      pickerMode
                    />
                  ),
                })),
              }))
            : null}
          collapsedKeys={flowPicker.collapsedKeys}
          onToggleGroup={flowPicker.toggleGroup}
        />

        {authoringMode === 'guided' && (
          <TextField
            fullWidth
            label={t('flows.subflow.helperTask')}
            value={nodeData.description || ''}
            onChange={(e) => setNodeData({ ...nodeData, description: e.target.value })}
            margin="normal"
            multiline
            minRows={2}
            helperText={t('flows.subflow.helperTaskHelp')}
          />
        )}

        {authoringMode === 'advanced' && <>
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.inputTitle')}
        </Typography>
        <Box role="radiogroup" aria-label={t('flows.subflow.inputAria')} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <OptionCard
            selected={inputMode === 'full-history'}
            onClick={() => handlePropertyChange('inputMode', 'full-history')}
            icon={<HistoryIcon />}
            title={t('flows.subflow.fullHistory')}
            description={t('flows.subflow.fullHistoryHelp')}
          />
          <OptionCard
            selected={inputMode === 'latest-message'}
            onClick={() => handlePropertyChange('inputMode', 'latest-message')}
            icon={<ShortTextIcon />}
            title={t('flows.subflow.latest')}
            description={t('flows.subflow.latestHelp')}
          />
          <OptionCard
            selected={inputMode === 'isolated'}
            onClick={() => handlePropertyChange('inputMode', 'isolated')}
            icon={<EditNoteIcon />}
            title={t('flows.subflow.isolated')}
            description={t('flows.subflow.isolatedHelp')}
          />
        </Box>

        {inputMode === 'isolated' && (
          <TextField
            fullWidth
            label={t('flows.subflow.defaultPrompt')}
            value={promptTemplate}
            onChange={(e) => handlePropertyChange('promptTemplate', e.target.value)}
            margin="normal"
            multiline
            rows={3}
            helperText={t('flows.subflow.defaultPromptHelp')}
          />
        )}

        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.workersTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t('flows.subflow.queueHelp')}
        </Typography>
        <TextField
          label={t('flows.subflow.maxCopies')}
          type="number"
          size="small"
          sx={{ width: 240 }}
          inputProps={{ min: 1 }}
          value={typeof nodeData.properties?.concurrencyLimit === 'number' ? nodeData.properties.concurrencyLimit : ''}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              removeProperty('concurrencyLimit');
            } else {
              const n = Math.max(1, Math.floor(Number(raw)));
              if (!Number.isNaN(n)) handlePropertyChange('concurrencyLimit', n);
            }
          }}
          helperText={t('flows.subflow.defaultFour')}
        />

        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.outputTitle')}
        </Typography>
        <Box role="radiogroup" aria-label={t('flows.subflow.outputAria')} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <OptionCard
            selected={(nodeData.properties?.outputMode || 'steps') !== 'final-only'}
            onClick={() => handlePropertyChange('outputMode', 'steps')}
            icon={<ForumOutlinedIcon />}
            title={t('flows.subflow.fullOutput')}
            description={t('flows.subflow.fullOutputHelp')}
          />
          <OptionCard
            selected={nodeData.properties?.outputMode === 'final-only'}
            onClick={() => handlePropertyChange('outputMode', 'final-only')}
            icon={<ChatBubbleOutlineIcon />}
            title={t('flows.subflow.condensed')}
            description={t('flows.subflow.condensedHelp')}
          />
        </Box>

        {/* Debugging (issue #125): persist each queued child conversation into
            the chat sidebar, linked to the parent run. */}
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.debugging')}
        </Typography>
        <FormControlLabel
          sx={{ display: 'block' }}
          control={
            <Switch
              checked={nodeData.properties?.saveConversation !== false}
              onChange={(e) => handlePropertyChange('saveConversation', e.target.checked)}
            />
          }
          label={t('flows.subflow.saveConversation')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
          {t('flows.subflow.saveConversationHelp')}
        </Typography>

        <Divider sx={{ my: 3 }} />
        <CaptureFields
          value={{ captureVariable, captureResource, captureKvScope, captureKvKey }}
          onChange={(patch) => {
            if (patch.captureVariable !== undefined) setCaptureVariable(patch.captureVariable);
            if (patch.captureResource !== undefined) setCaptureResource(patch.captureResource);
            if (patch.captureKvScope !== undefined) setCaptureKvScope(patch.captureKvScope);
            if (patch.captureKvKey !== undefined) setCaptureKvKey(patch.captureKvKey);
          }}
        />
        </>}
      </DialogContent>

      <DialogActions>
        {selectedSubflowId && !selectedMissing && onNavigateToFlow && (
          <Button
            onClick={() => onNavigateToFlow(selectedSubflowId)}
            startIcon={<ArrowForwardIcon />}
          >
            {t('flows.subflow.openTarget')}
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" color="primary">
          {t('flows.modal.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SubflowNodePropertiesModal;
