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
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Alert,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import HistoryIcon from '@mui/icons-material/History';
import ShortTextIcon from '@mui/icons-material/ShortText';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { FlowNode, Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
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

/** A big selectable card for a mutually exclusive choice (radio-style). */
const OptionCard = ({
  selected,
  icon,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) => (
  <Box
    role="radio"
    aria-checked={selected}
    tabIndex={0}
    onClick={onClick}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    }}
    sx={{
      flex: 1,
      position: 'relative',
      p: 2,
      borderRadius: 2,
      border: 2,
      borderColor: selected ? 'primary.main' : 'divider',
      bgcolor: selected ? 'action.selected' : 'background.paper',
      cursor: 'pointer',
      transition: 'border-color 120ms, background-color 120ms',
      '&:hover': { borderColor: selected ? 'primary.main' : 'text.disabled' },
      outline: 'none',
      '&:focus-visible': { boxShadow: (theme: any) => `0 0 0 3px ${theme.palette.primary.light}` },
    }}
  >
    {selected && (
      <CheckCircleIcon
        color="primary"
        fontSize="small"
        sx={{ position: 'absolute', top: 8, right: 8 }}
      />
    )}
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, color: selected ? 'primary.main' : 'text.secondary' }}>
      {icon}
      <Typography variant="subtitle1" sx={{ fontWeight: 600, color: 'text.primary' }}>
        {title}
      </Typography>
    </Box>
    <Typography variant="body2" color="text.secondary">
      {description}
    </Typography>
  </Box>
);

export const SubflowNodePropertiesModal = ({ open, node, onClose, onSave, flowId }: SubflowNodePropertiesModalProps) => {
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  const [flows, setFlows] = useState<Flow[]>([]);
  const [loadingFlows, setLoadingFlows] = useState(false);

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

        <FormControl fullWidth margin="normal">
          <InputLabel id="subflow-select-label">Flow to run</InputLabel>
          <Select
            labelId="subflow-select-label"
            label="Flow to run"
            value={selectedMissing ? '' : selectedSubflowId}
            onChange={(e) => handlePropertyChange('subflowId', e.target.value)}
            displayEmpty
          >
            {selectableFlows.length === 0 && (
              <MenuItem value="" disabled>
                {loadingFlows ? 'Loading flows…' : 'No other flows available'}
              </MenuItem>
            )}
            {selectableFlows.map((f) => (
              <MenuItem key={f.id} value={f.id}>
                {f.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {selectedMissing && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            The previously selected flow no longer exists. Please choose another.
          </Alert>
        )}

        <TextField
          fullWidth
          label="Input (optional)"
          value={nodeData.properties?.promptTemplate || ''}
          onChange={(e) => handlePropertyChange('promptTemplate', e.target.value)}
          margin="normal"
          multiline
          rows={3}
          helperText="What to send to the subflow. Leave empty to pass this conversation (see below)."
        />

        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
          Which messages does the subflow receive?
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Only applies when the input above is left empty.
        </Typography>
        <Box role="radiogroup" aria-label="Subflow input" sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <OptionCard
            selected={(nodeData.properties?.inputMode || 'full-history') !== 'latest-message'}
            onClick={() => handlePropertyChange('inputMode', 'full-history')}
            icon={<HistoryIcon />}
            title="Full conversation"
            description="The subflow sees the whole conversation so far. Best for a helper that should continue with all the context."
          />
          <OptionCard
            selected={nodeData.properties?.inputMode === 'latest-message'}
            onClick={() => handlePropertyChange('inputMode', 'latest-message')}
            icon={<ShortTextIcon />}
            title="Latest message only"
            description="The subflow sees only the most recent message. Best for an orchestrator that hands off one task at a time, so old tasks don't leak in."
          />
        </Box>

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
