"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Divider,
  TextField,
  Alert,
  FormControlLabel,
  Switch,
  Slider,
} from '@mui/material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import HistoryIcon from '@mui/icons-material/History';
import ShortTextIcon from '@mui/icons-material/ShortText';
import EditNoteIcon from '@mui/icons-material/EditNote';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ViewAgendaOutlinedIcon from '@mui/icons-material/ViewAgendaOutlined';
import MergeTypeIcon from '@mui/icons-material/MergeType';
import { FlowNode, Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import OptionCard from '@/frontend/components/shared/OptionCard';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
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
      // defaults into stored data on ANY save â€” e.g. opening the modal to change
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
      // Data-flow capture (issue #203). parseKvRef('') â†’ { scope:'folder', key:'' }.
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
      const rawTurnCap = properties.sessionTurnCap;
      const normalizedTurnCap = typeof rawTurnCap === 'number' ? rawTurnCap : Number(rawTurnCap);
      if (rawTurnCap === undefined || rawTurnCap === '') delete properties.sessionTurnCap;
      else if (Number.isSafeInteger(normalizedTurnCap) && normalizedTurnCap > 0) {
        properties.sessionTurnCap = normalizedTurnCap;
      } else {
        return;
      }

      // Data-flow capture (issue #203): set the trimmed value or REMOVE the key
      // when empty, so flowToSpec never emits an empty captureX and existing
      // flows without these fields stay byte-identical.
      const cv = captureVariable.trim();
      if (cv) properties.captureVariable = cv; else delete properties.captureVariable;
      const cr = captureResource.trim();
      if (cr) properties.captureResource = cr; else delete properties.captureResource;
      const ckv = buildKvRef(captureKvScope, captureKvKey);
      if (ckv) properties.captureKv = ckv; else delete properties.captureKv;

      // Per requirements: 'separate' (Separate Messages per lane) is now the only/default behavior.
      // Legacy 'joined' will be removed soon. When this modal is opened and saved,
      // existing flows will be updated to 'separate'.
      properties.resultPresentation = 'separate';

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
  // has a promptTemplate and no inputMode â€” surface it as Isolated so the same
  // prompt keeps being sent (this mirrors SubflowNode.prep's runtime fallback).
  const promptTemplate = nodeData.properties?.promptTemplate || '';
  const inputMode: 'full-history' | 'latest-message' | 'isolated' =
    nodeData.properties?.inputMode || (promptTemplate.trim() ? 'isolated' : 'full-history');
  const sessionScope: 'per-visit' | 'per-run' | 'per-key' =
    nodeData.properties?.sessionScope || 'per-visit';
  const sessionInputMode: 'resume' | 'summary' =
    nodeData.properties?.sessionInputMode || 'resume';
  const sessionTurnCapValue = nodeData.properties?.sessionTurnCap ?? '';
  const sessionTurnCapNumber = Number(sessionTurnCapValue);
  const sessionTurnCapInvalid = sessionTurnCapValue !== ''
    && (!Number.isSafeInteger(sessionTurnCapNumber) || sessionTurnCapNumber <= 0);

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
      <DialogHeaderActions
        title={t('flows.modal.properties', { name: nodeData.label || t('flows.subflow.title') })}
        onClose={onClose}
      />

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
          {/* The "open target flow" shortcut sits right next to the picker (it used
              to live in the dialog footer, far away from the selection it acts on). */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
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
            {selectedSubflowId && !selectedMissing && onNavigateToFlow && (
              <Button
                size="small"
                onClick={() => onNavigateToFlow(selectedSubflowId)}
                startIcon={<ArrowForwardIcon />}
                sx={{ textTransform: 'none' }}
              >
                {t('flows.subflow.openTarget')}
              </Button>
            )}
          </Box>
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

        {/* Default prompt field hidden per requirements */}

        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.workersTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t('flows.subflow.queueHelp')}
        </Typography>
        <Box sx={{ width: 300 }}>
          <Slider
            value={typeof nodeData.properties?.concurrencyLimit === 'number' ? nodeData.properties.concurrencyLimit : 4}
            onChange={(_, value) => handlePropertyChange('concurrencyLimit', value)}
            min={1}
            max={16}
            step={1}
            marks={Array.from({ length: 16 }, (_, i) => i + 1).map((v) => ({ value: v, label: v.toString() }))}
            valueLabelDisplay="auto"
            aria-label={t('flows.subflow.maxCopies')}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t('flows.subflow.maxCopies')}: {typeof nodeData.properties?.concurrencyLimit === 'number' ? nodeData.properties.concurrencyLimit : 4}
          </Typography>
        </Box>

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

        {/* Issue #384 (deferred UI half of #359): how parallel lane results are
            presented in chat. Only takes effect when a run produces >1 lane. */}
        {/* Parallel Results selection hidden per requirements - 'separate' is now the only/default behavior */}

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

        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.sessionTitle')}
        </Typography>
        <Box
          role="radiogroup"
          aria-label={t('flows.subflow.sessionAria')}
          sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}
        >
          <OptionCard
            selected={sessionScope === 'per-visit'}
            onClick={() => {
              removeProperty('sessionScope');
              removeProperty('sessionKey');
              removeProperty('sessionInputMode');
              removeProperty('sessionTurnCap');
            }}
            icon={<ChatBubbleOutlineIcon />}
            title={t('flows.subflow.sessionPerVisit')}
            description={t('flows.subflow.sessionPerVisitHelp')}
          />
          <OptionCard
            selected={sessionScope === 'per-run'}
            onClick={() => {
              handlePropertyChange('sessionScope', 'per-run');
              removeProperty('sessionKey');
            }}
            icon={<HistoryIcon />}
            title={t('flows.subflow.sessionPerRun')}
            description={t('flows.subflow.sessionPerRunHelp')}
          />
          <OptionCard
            selected={sessionScope === 'per-key'}
            onClick={() => handlePropertyChange('sessionScope', 'per-key')}
            icon={<AccountTreeOutlinedIcon />}
            title={t('flows.subflow.sessionPerKey')}
            description={t('flows.subflow.sessionPerKeyHelp')}
          />
        </Box>
        {sessionScope === 'per-key' && (
          <TextField
            fullWidth
            label={t('flows.subflow.sessionKey')}
            value={nodeData.properties?.sessionKey || ''}
            onChange={(e) => {
              if (e.target.value === '') removeProperty('sessionKey');
              else handlePropertyChange('sessionKey', e.target.value);
            }}
            margin="normal"
            helperText={t('flows.subflow.sessionKeyHelp')}
          />
        )}
        {sessionScope !== 'per-visit' && (
          <>
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
              {t('flows.subflow.sessionInputMode')}
            </Typography>
            <Box role="radiogroup" sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <OptionCard
                selected={sessionInputMode === 'resume'}
                onClick={() => removeProperty('sessionInputMode')}
                icon={<HistoryIcon />}
                title={t('flows.subflow.sessionResume')}
                description={t('flows.subflow.sessionResumeHelp')}
              />
              <OptionCard
                selected={sessionInputMode === 'summary'}
                onClick={() => handlePropertyChange('sessionInputMode', 'summary')}
                icon={<ShortTextIcon />}
                title={t('flows.subflow.sessionSummary')}
                description={t('flows.subflow.sessionSummaryHelp')}
              />
            </Box>
            <TextField
              fullWidth
              type="number"
              inputProps={{ min: 1, step: 1 }}
              label={t('flows.subflow.sessionTurnCap')}
              value={sessionTurnCapValue}
              onChange={(event) => {
                if (event.target.value === '') removeProperty('sessionTurnCap');
                else handlePropertyChange('sessionTurnCap', event.target.value);
              }}
              margin="normal"
              error={sessionTurnCapInvalid}
              helperText={sessionTurnCapInvalid
                ? t('flows.subflow.sessionTurnCapError')
                : t('flows.subflow.sessionTurnCapHelp')}
            />
          </>
        )}
        {sessionScope !== 'per-visit' && nodeData.properties?.saveConversation === false && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {t('flows.subflow.sessionRequiresSaved')}
          </Alert>
        )}
        {sessionScope !== 'per-visit' && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t('flows.subflow.sessionExperimentalHelp')}
          </Typography>
        )}

        {/* Callable-subflow TOOL invocation (issue #385, deferred Part B of
            #359): a small opt-in toggle. Backend-gated behind the experimental
            "Let Subflow nodes be called as tools" setting, so leaving this on
            with the setting off silently keeps today's handoff behaviour. */}
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.invocationTitle')}
        </Typography>
        <FormControlLabel
          sx={{ display: 'block' }}
          control={
            <Switch
              checked={nodeData.properties?.invocationMode === 'tool'}
              onChange={(e) => handlePropertyChange('invocationMode', e.target.checked ? 'tool' : 'handoff')}
            />
          }
          label={t('flows.subflow.invocationTool')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
          {t('flows.subflow.invocationToolHelp')}
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
        <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" color="primary" disabled={sessionTurnCapInvalid}>
          {t('flows.modal.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SubflowNodePropertiesModal;








