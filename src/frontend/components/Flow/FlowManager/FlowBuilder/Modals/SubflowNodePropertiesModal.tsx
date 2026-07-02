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
          This step runs another flow as a subroutine. Its final answer is added to
          this conversation and execution continues to the next node.
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
          helperText="What to send to the subflow. Leave empty to pass this conversation's latest message."
        />

        <FormControl fullWidth margin="normal">
          <InputLabel id="subflow-output-label">Output</InputLabel>
          <Select
            labelId="subflow-output-label"
            label="Output"
            value={nodeData.properties?.outputMode || 'steps'}
            onChange={(e) => handlePropertyChange('outputMode', e.target.value)}
          >
            <MenuItem value="steps">Show steps — the subflow&apos;s intermediate steps appear nested in the conversation</MenuItem>
            <MenuItem value="final-only">Final answer only — only the subflow&apos;s final output is shown</MenuItem>
          </Select>
        </FormControl>
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
