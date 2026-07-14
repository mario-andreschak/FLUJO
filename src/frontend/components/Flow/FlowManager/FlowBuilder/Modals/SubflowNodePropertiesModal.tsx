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
import FlowCard, { FlowCardSkeleton } from '@/frontend/components/Flow/FlowDashboard/FlowCard';
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

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { ...node.data.properties },
      });
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
      onSave(node.id, nodeData);
      onClose();
    }
  };

  if (!node || !nodeData) return null;

  // A flow shouldn't call itself (the runtime depth guard catches deeper loops,
  // but selecting yourself is an obvious footgun), so exclude the current flow.
  const selectableFlows = flows.filter((f) => f.id !== flowId);
  const selectedSubflowId = nodeData.properties?.subflowId || '';
  const selectedMissing = !!selectedSubflowId && !flows.some((f) => f.id === selectedSubflowId);
  const selectedSubflowName = selectedMissing
    ? ''
    : flows.find((f) => f.id === selectedSubflowId)?.name || '';

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
              {selectedSubflowName || 'Choose a flow…'}
            </Box>
          </Button>
        </Box>

        {selectedMissing && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            The previously selected flow no longer exists. Please choose another.
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
          items={selectableFlows.map((f) => ({
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
          <TextField
            fullWidth
            label="Isolated prompt"
            value={promptTemplate}
            onChange={(e) => handlePropertyChange('promptTemplate', e.target.value)}
            margin="normal"
            multiline
            rows={3}
            helperText="Sent to the subflow as its single user message. The parent conversation is not passed."
          />
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
