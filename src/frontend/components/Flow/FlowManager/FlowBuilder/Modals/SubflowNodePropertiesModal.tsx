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
import { FlowNode, Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import OptionCard from '@/frontend/components/shared/OptionCard';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import FlowCard, { FlowCardSkeleton } from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { CardGroup } from '@/utils/shared/cardGrouping';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/SubflowNodePropertiesModal');

interface SubflowNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
  /** The id of the flow being edited, so it can be excluded from the picker. */
  flowId?: string;
}

export const SubflowNodePropertiesModal = ({ open, node, onClose, onSave, flowId }: SubflowNodePropertiesModalProps) => {
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

  const handleSave = () => {
    if (node && nodeData) {
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
            {nodeData.label || 'Subflow Node'} Properties
          </Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          This step runs another flow inside this one — like calling a helper.
          When it finishes, its answer becomes part of this conversation and the
          flow continues to the next node.
        </Typography>

        <TextField
          fullWidth
          label="Node Label"
          value={nodeData.label || ''}
          onChange={(e) => setNodeData({ ...nodeData, label: e.target.value })}
          margin="normal"
        />

        {/* Flow picker reuses the Flows dashboard card layout (#92) so choosing
            a subflow looks exactly like the Flows page. */}
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Flow to run
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
                  ? `Parallel fan-out: ${parallelIds.length} flows`
                  : parallelVar
                    ? `Fan-out targets from \${var:${parallelVar}}`
                    : 'Choose a flow…')}
            </Box>
          </Button>
        </Box>

        {selectedMissing && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            The previously selected flow no longer exists. Please choose another.
          </Alert>
        )}

        {/* Issue #156 defect 3: surface API-authored lane config instead of
            looking unbound. There is no full editor for these here (they are
            authored via the flow-compile API), but the node must not look broken. */}
        {(parallelIds.length > 0 || (parallelVar && !selectedSubflowId)) && (
          <Alert severity="info" sx={{ mt: 1 }}>
            {parallelIds.length > 0
              ? `This node runs ${parallelIds.length} flows in parallel and merges their results: ${parallelNames.join(', ')}. (Configured via the flow API.)`
              : `This node picks its parallel target flows at runtime from the run variable "${parallelVar}". (Configured via the flow API.)`}
          </Alert>
        )}
        {mapOverList && (
          <Alert severity="info" sx={{ mt: 1 }}>
            This node runs the selected flow once per item parsed from its input
            (map-over-list, configured via the flow API).
          </Alert>
        )}

        <CardPickerDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title="Choose a flow to run"
          description="This subflow node will run the selected flow as a helper."
          isLoading={loadingFlows}
          skeleton={<FlowCardSkeleton />}
          emptyMessage="No other flows available. Create another flow first."
          searchable
          searchPlaceholder="Search flows…"
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

        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          What does the subflow receive?
        </Typography>
        <Box role="radiogroup" aria-label="Subflow input" sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <OptionCard
            selected={inputMode === 'full-history'}
            onClick={() => handlePropertyChange('inputMode', 'full-history')}
            icon={<HistoryIcon />}
            title="Full conversation"
            description="The subflow sees the whole conversation so far. Best for a helper that should continue with all the context."
          />
          <OptionCard
            selected={inputMode === 'latest-message'}
            onClick={() => handlePropertyChange('inputMode', 'latest-message')}
            icon={<ShortTextIcon />}
            title="Latest message only"
            description="The subflow sees only the most recent message. Best for an orchestrator that hands off one task at a time, so old tasks don't leak in."
          />
          <OptionCard
            selected={inputMode === 'isolated'}
            onClick={() => handlePropertyChange('inputMode', 'isolated')}
            icon={<EditNoteIcon />}
            title="Isolated"
            description="The conversation is ignored. The subflow receives only the prompt you write below, as its first message."
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
              label="Let the caller pass a prompt"
            />
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1, ml: 4, mt: -0.5 }}>
              When on, a step that routes to this subflow can attach an instruction through
              its handoff tool, overriding the prompt below. The prompt below is then used
              only as a default when the caller sends none.
            </Typography>
            <TextField
              fullWidth
              label={nodeData.properties?.allowCallerPrompt !== false ? 'Default prompt (used if the caller sends none)' : 'Isolated prompt'}
              value={promptTemplate}
              onChange={(e) => handlePropertyChange('promptTemplate', e.target.value)}
              margin="normal"
              multiline
              rows={3}
              helperText={
                nodeData.properties?.allowCallerPrompt !== false
                  ? 'The default first message for the subflow. A routing model may override it via the handoff tool. The parent conversation is not passed.'
                  : 'Sent to the subflow as its single user message. The parent conversation is not passed.'
              }
            />
          </>
        )}

        {/* Spawn-with-brief (issue #156): this node as a spawnable sub-agent —
            the routing model calls the handoff tool once per parallel worker,
            each call carrying its own task brief; and/or the author pins a
            fixed brief list. Both run through the same parallel lane engine. */}
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          Parallel workers (spawning)
        </Typography>
        <FormControlLabel
          sx={{ display: 'block' }}
          control={
            <Checkbox
              checked={spawnEnabled}
              onChange={(e) => handlePropertyChange('allowCallerFanout', e.target.checked)}
            />
          }
          label="Let the caller spawn parallel copies of this sub-agent"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, ml: 4, mt: -0.5 }}>
          When on, the step that hands off here may call this node&apos;s handoff tool
          several times in one reply — each call runs one parallel copy of the selected
          flow with its own task brief. The copies run concurrently; their results are
          merged in order and the flow continues once all of them finish.
        </Typography>
        <TextField
          fullWidth
          label="Always spawn these briefs (one per line, optional)"
          value={briefsText}
          onChange={(e) => setBriefsText(e.target.value)}
          margin="normal"
          multiline
          minRows={2}
          helperText="When set, every visit runs one parallel copy of the selected flow per line — no caller needed. Caller-passed tasks (above) override this list for that visit. Supports ${var:NAME}, ${res:NAME} and ${kv:NAME}."
        />
        {showTuning && (
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1 }}>
            <TextField
              label="Max copies at once"
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
              helperText="Default 4"
            />
            <TextField
              label="Error handling"
              select
              size="small"
              sx={{ width: 220 }}
              value={nodeData.properties?.errorStrategy === 'fail-fast' ? 'fail-fast' : 'collect-all'}
              onChange={(e) => handlePropertyChange('errorStrategy', e.target.value)}
              helperText="What happens if a copy fails"
            >
              <MenuItem value="collect-all">Collect all (note failures, continue)</MenuItem>
              <MenuItem value="fail-fast">Fail fast (first failure stops the node)</MenuItem>
            </TextField>
            <TextField
              label="Separator between merged results"
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
              helperText="Empty = blank line"
            />
          </Box>
        )}

        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          What do you see in the chat while the subflow runs?
        </Typography>
        <Box role="radiogroup" aria-label="Subflow output" sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <OptionCard
            selected={(nodeData.properties?.outputMode || 'steps') !== 'final-only'}
            onClick={() => handlePropertyChange('outputMode', 'steps')}
            icon={<ForumOutlinedIcon />}
            title="Full"
            description="You see all of the subflow's messages in the chat, indented under this step — like watching it work."
          />
          <OptionCard
            selected={nodeData.properties?.outputMode === 'final-only'}
            onClick={() => handlePropertyChange('outputMode', 'final-only')}
            icon={<ChatBubbleOutlineIcon />}
            title="Condensed"
            description="You only see the subflow's final answer as a single message. Its inner steps stay hidden."
          />
        </Box>

        {/* Debugging (issue #125): persist the subflow's OWN conversation into the
            chat sidebar, mirroring a planned execution's "Save full conversations".
            Routed through runFlow mode:'conversation' on the single-child path. */}
        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          Debugging
        </Typography>
        <FormControlLabel
          sx={{ display: 'block' }}
          control={
            <Switch
              checked={nodeData.properties?.saveConversation !== false}
              onChange={(e) => handlePropertyChange('saveConversation', e.target.checked)}
            />
          }
          label="Save this subflow's conversation to the sidebar (useful for debugging)"
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
          When on, each run of this subflow is persisted as its own conversation in
          the chat sidebar, linked to the parent run — like a planned execution&apos;s
          &quot;Save full conversations&quot;. Parallel copies each get their own
          conversation, titled by their brief.
        </Typography>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" color="primary">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SubflowNodePropertiesModal;
