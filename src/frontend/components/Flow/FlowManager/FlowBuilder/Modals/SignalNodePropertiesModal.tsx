"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Alert,
} from '@mui/material';
import { FlowNode } from '@/frontend/types/flow/flow';

interface SignalNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
}

/**
 * Properties modal for the signal node (issue #117).
 *
 * A signal node is a deterministic, non-LLM, pass-through node: when execution
 * traverses it, it emits `{ topic, payload }` onto the flow-run event bus. A
 * planned execution whose `flow-event` trigger is configured with the same
 * topic then fires — fire-and-forget, as its own run. `${var:NAME}` in the
 * payload is resolved from the run's named variables at emit time.
 */
export const SignalNodePropertiesModal = ({ open, node, onClose, onSave }: SignalNodePropertiesModalProps) => {
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { ...node.data.properties },
      });
    }
  }, [node, open]);

  const setProperty = (key: string, value: unknown) => {
    setNodeData((prev) => (prev ? { ...prev, properties: { ...prev.properties, [key]: value } } : prev));
  };

  const handleSave = () => {
    if (!node || !nodeData) return;
    const properties = { ...nodeData.properties };
    properties.topic = typeof properties.topic === 'string' ? properties.topic.trim() : '';
    onSave(node.id, { ...nodeData, properties });
  };

  if (!nodeData) return null;

  const topic: string = nodeData.properties?.topic ?? '';
  const payloadTemplate: string = nodeData.properties?.payloadTemplate ?? '';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Signal Node Properties</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <TextField
            label="Label"
            value={nodeData.label}
            onChange={(e) => setNodeData({ ...nodeData, label: e.target.value })}
            fullWidth
          />
          <TextField
            label="Description"
            value={nodeData.description ?? ''}
            onChange={(e) => setNodeData({ ...nodeData, description: e.target.value })}
            fullWidth
            multiline
            minRows={2}
          />

          <TextField
            label="Topic"
            value={topic}
            onChange={(e) => setProperty('topic', e.target.value)}
            fullWidth
            required
            error={!topic.trim()}
            placeholder="e.g. review-blocked"
            helperText={
              !topic.trim()
                ? 'A topic is required — a flow-event trigger listens for this exact name.'
                : 'A free-form shared name (no registry). A planned execution reacts to it via a flow-event trigger with this topic.'
            }
          />

          <TextField
            label="Payload template"
            value={payloadTemplate}
            onChange={(e) => setProperty('payloadTemplate', e.target.value)}
            fullWidth
            multiline
            minRows={3}
            placeholder="e.g. Review found blockers: ${var:reviewSummary}"
            helperText="Emitted as the signal payload. ${var:NAME} is resolved from run variables at emit time."
          />

          <Alert severity="info">
            When execution reaches this node it emits the topic and continues
            immediately (fire-and-forget). To emit conditionally, put a
            conditioned edge into this node. Runaway signal chains are bounded by
            the trigger&rsquo;s max chain depth.
          </Alert>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained">Save</Button>
      </DialogActions>
    </Dialog>
  );
};

export default SignalNodePropertiesModal;
