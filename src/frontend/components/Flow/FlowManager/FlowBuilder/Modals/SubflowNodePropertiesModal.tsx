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
  Checkbox,
  FormControlLabel,
  Switch,
  MenuItem,
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
  const { t, tp, formatList } = useI18n();
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  const [flows, setFlows] = useState<Flow[]>([]);
  const [loadingFlows, setLoadingFlows] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Spawn briefs (issue #156) are edited as free multi-line text (one brief per
  // line) and only parsed back into the string[] property at save time, so
  // typing/removing blank lines never fights the user mid-edit.
  const [briefsText, setBriefsText] = useState('');
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
      setBriefsText(
        Array.isArray(existing.spawnBriefs)
          ? existing.spawnBriefs.filter((b: unknown) => typeof b === 'string').join('\n')
          : ''
      );

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

  // Issue #138 / #204: removing a key (rather than storing false/''/a default)
  // keeps stored data minimal and byte-compatible with the FlowSpec compiler,
  // which only emits these fan-out keys when they are explicitly set.
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
      // Parse the brief editor back into the stored list. An empty editor
      // REMOVES the key (issue #138 spirit: never seed values the user didn't
      // set) rather than persisting an empty array.
      const briefs = briefsText
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b !== '');
      const properties = { ...nodeData.properties };
      if (briefs.length > 0) {
        properties.spawnBriefs = briefs;
      } else {
        delete properties.spawnBriefs;
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

  // API-authored lane configuration (issue #156 defect 3): these fields have no
  // full editor here (they come from /api/flow/compile), but they must be
  // VISIBLE — a node fanning out to 5 flows used to render as "Choose a flow…"
  // as if it were unbound/broken.
  const parallelIds: string[] = Array.isArray(nodeData.properties?.parallelSubflowIds)
    ? nodeData.properties.parallelSubflowIds.filter((id: unknown): id is string => typeof id === 'string' && id !== '')
    : [];
  const parallelNames = parallelIds.map((id) => flows.find((f) => f.id === id)?.name || id);
  const parallelVar =
    typeof nodeData.properties?.parallelSubflowIdsVar === 'string'
      ? nodeData.properties.parallelSubflowIdsVar.trim()
      : '';
  const mapOverList = nodeData.properties?.mapOverList === true;
  const spawnEnabled = !!nodeData.properties?.allowCallerFanout;
  const hasBriefs = briefsText.split('\n').some((b) => b.trim() !== '');
  // The pool/join/error tuning applies to every lane mode; show it as soon as
  // any lane source is in play so it never seeds values on unrelated saves.
  const showTuning = spawnEnabled || hasBriefs || parallelIds.length > 0 || !!parallelVar || mapOverList;

  // Dynamic fan-out mode gating (issue #204). Mirror the compiler's mutual
  // exclusions so the UI can never author a combination the compiler rejects:
  //  - mapOverList conflicts with static parallel, parallel-var, and spawning.
  //  - parallelFlowsVariable conflicts with mapOverList and a static list.
  const staticParallelPresent = parallelIds.length > 0;
  const spawnMode = spawnEnabled || hasBriefs;
  const mapAllowed = !staticParallelPresent && !parallelVar && !spawnMode;
  const varAllowed = !mapOverList && !staticParallelPresent;

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
              {selectedSubflowName ||
                (parallelIds.length > 0
                  ? tp('flows.subflow.parallel', parallelIds.length)
                  : parallelVar
                    ? t('flows.subflow.targetsVariable', { name: parallelVar })
                    : t('flows.subflow.choose'))}
            </Box>
          </Button>
        </Box>

        {selectedMissing && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {t('flows.subflow.missing')}
          </Alert>
        )}

        {/* Issue #156 defect 3: the STATIC parallel list is still authored via
            the flow-compile API — keep it read-only here (issue #204 Open Q1)
            but VISIBLE so the node doesn't look unbound. The dynamic fan-out
            modes (parallelFlowsVariable / mapOverList) are now editable below. */}
        {parallelIds.length > 0 && (
          <Alert severity="info" sx={{ mt: 1 }}>
            {t('flows.subflow.parallelInfo', {
              count: parallelIds.length,
              names: formatList(parallelNames),
            })}
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
          <>
            <FormControlLabel
              sx={{ mt: 1, display: 'block' }}
              control={
                <Checkbox
                  checked={nodeData.properties?.allowCallerPrompt !== false}
                  onChange={(e) => handlePropertyChange('allowCallerPrompt', e.target.checked)}
                />
              }
              label={t('flows.subflow.allowCallerPrompt')}
            />
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1, ml: 4, mt: -0.5 }}>
              {t('flows.subflow.allowCallerPromptHelp')}
            </Typography>
            <TextField
              fullWidth
              label={nodeData.properties?.allowCallerPrompt !== false ? t('flows.subflow.defaultPrompt') : t('flows.subflow.isolatedPrompt')}
              value={promptTemplate}
              onChange={(e) => handlePropertyChange('promptTemplate', e.target.value)}
              margin="normal"
              multiline
              rows={3}
              helperText={
                nodeData.properties?.allowCallerPrompt !== false
                  ? t('flows.subflow.defaultPromptHelp')
                  : t('flows.subflow.isolatedPromptHelp')
              }
            />
          </>
        )}

        {/* Dynamic subflow fan-out (issue #204, Phase 4 of #186): author
            parallelFlowsVariable + mapOverList (+ itemSplit, sequential) that
            were previously read-only alerts. "Never seed defaults" (#138): every
            off/default/empty state REMOVES its key so UI output stays
            byte-compatible with the FlowSpec compiler, which only emits these
            keys when explicitly set. Mode gating mirrors the compiler's mutual
            exclusions so an invalid combination can't be authored here. */}
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.dynamicTitle')}
        </Typography>
        <TextField
          fullWidth
          label={t('flows.subflow.parallelVariable')}
          value={parallelVar}
          disabled={!varAllowed}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v) handlePropertyChange('parallelSubflowIdsVar', v);
            else removeProperty('parallelSubflowIdsVar');
          }}
          margin="normal"
          helperText={
            !varAllowed
              ? (mapOverList
                  ? t('flows.subflow.parallelDisabledMap')
                  : t('flows.subflow.parallelDisabledStatic'))
              : t('flows.subflow.parallelVariableHelp')
          }
        />
        <FormControlLabel
          sx={{ display: 'block', mt: 1 }}
          control={
            <Checkbox
              checked={mapOverList}
              disabled={!mapAllowed && !mapOverList}
              onChange={(e) => {
                if (e.target.checked) {
                  handlePropertyChange('mapOverList', true);
                } else {
                  // Uncheck cascade-removes the map-only modifiers rather than
                  // writing false (#138: never store defaults/off states).
                  setNodeData((prev) => {
                    if (!prev) return null;
                    const { mapOverList: _m, itemSplit: _i, sequential: _s, ...rest } = prev.properties;
                    return { ...prev, properties: rest };
                  });
                }
              }}
            />
          }
          label={t('flows.subflow.map')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, ml: 4, mt: -0.5 }}>
          {mapAllowed || mapOverList
            ? t('flows.subflow.mapHelp')
            : t('flows.subflow.mapDisabled')}
        </Typography>
        {mapOverList && (
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', ml: 4, mt: 1 }}>
            <TextField
              label={t('flows.subflow.split')}
              select
              size="small"
              sx={{ width: 240 }}
              value={nodeData.properties?.itemSplit === 'lines' ? 'lines' : 'json-array'}
              onChange={(e) => {
                // json-array is the runtime default → store NOTHING for it so the
                // common case round-trips byte-identically (#138).
                if (e.target.value === 'lines') handlePropertyChange('itemSplit', 'lines');
                else removeProperty('itemSplit');
              }}
              helperText={t('flows.subflow.splitHelp')}
            >
              <MenuItem value="json-array">{t('flows.subflow.jsonArray')}</MenuItem>
              <MenuItem value="lines">{t('flows.subflow.lines')}</MenuItem>
            </TextField>
            <FormControlLabel
              control={
                <Checkbox
                  checked={nodeData.properties?.sequential === true}
                  onChange={(e) => {
                    if (e.target.checked) handlePropertyChange('sequential', true);
                    else removeProperty('sequential');
                  }}
                />
              }
              label={t('flows.subflow.sequential')}
            />
          </Box>
        )}

        {/* Spawn-with-brief (issue #156): this node as a spawnable sub-agent —
            the routing model calls the handoff tool once per parallel worker,
            each call carrying its own task brief; and/or the author pins a
            fixed brief list. Both run through the same parallel lane engine. */}
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          {t('flows.subflow.workersTitle')}
        </Typography>
        <FormControlLabel
          sx={{ display: 'block' }}
          control={
            <Checkbox
              checked={spawnEnabled}
              onChange={(e) => handlePropertyChange('allowCallerFanout', e.target.checked)}
            />
          }
          label={t('flows.subflow.allowSpawn')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, ml: 4, mt: -0.5 }}>
          {t('flows.subflow.spawnHelp')}
        </Typography>
        <TextField
          fullWidth
          label={t('flows.subflow.briefs')}
          value={briefsText}
          onChange={(e) => setBriefsText(e.target.value)}
          margin="normal"
          multiline
          minRows={2}
          helperText={t('flows.subflow.briefsHelp')}
        />
        {showTuning && (
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1 }}>
            <TextField
              label={t('flows.subflow.maxCopies')}
              type="number"
              size="small"
              sx={{ width: 160 }}
              value={typeof nodeData.properties?.concurrencyLimit === 'number' ? nodeData.properties.concurrencyLimit : ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  // Clearing removes the key (never seed a default — issue #138).
                  setNodeData((prev) => {
                    if (!prev) return null;
                    const { concurrencyLimit: _drop, ...rest } = prev.properties;
                    return { ...prev, properties: rest };
                  });
                } else {
                  const n = Math.max(1, Math.floor(Number(raw)));
                  if (!Number.isNaN(n)) handlePropertyChange('concurrencyLimit', n);
                }
              }}
              helperText={t('flows.subflow.defaultFour')}
            />
            <TextField
              label={t('flows.subflow.errorHandling')}
              select
              size="small"
              sx={{ width: 220 }}
              value={nodeData.properties?.errorStrategy === 'fail-fast' ? 'fail-fast' : 'collect-all'}
              onChange={(e) => handlePropertyChange('errorStrategy', e.target.value)}
              helperText={t('flows.subflow.errorHelp')}
            >
              <MenuItem value="collect-all">{t('flows.subflow.collect')}</MenuItem>
              <MenuItem value="fail-fast">{t('flows.subflow.failFast')}</MenuItem>
            </TextField>
            <TextField
              label={t('flows.subflow.separator')}
              size="small"
              sx={{ width: 260 }}
              multiline
              maxRows={2}
              value={typeof nodeData.properties?.joinSeparator === 'string' ? nodeData.properties.joinSeparator : ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setNodeData((prev) => {
                    if (!prev) return null;
                    const { joinSeparator: _drop, ...rest } = prev.properties;
                    return { ...prev, properties: rest };
                  });
                } else {
                  handlePropertyChange('joinSeparator', raw);
                }
              }}
              helperText={t('flows.subflow.blankLine')}
            />
          </Box>
        )}

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

        {/* Debugging (issue #125): persist the subflow's OWN conversation into the
            chat sidebar, mirroring a planned execution's "Save full conversations".
            Routed through runFlow mode:'conversation' on the single-child path. */}
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
