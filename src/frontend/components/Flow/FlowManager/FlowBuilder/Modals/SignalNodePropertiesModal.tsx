"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Alert,
  Link,
  Collapse,
} from '@mui/material';
import { FlowNode } from '@/frontend/types/flow/flow';

interface SignalNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
}

/**
 * Properties modal for the signal node (issues #117, #164).
 *
 * A signal node is a deterministic, non-LLM, pass-through node: when execution
 * traverses it, it emits `{ topic, payload }` onto the flow-run event bus. A
 * planned execution whose `flow-event` trigger is configured with the same
 * topic then fires — fire-and-forget, as its own run.
 *
 * Per issue #164 the authoring surface is intentionally minimal: a signal is
 * just a *named* signal, so the only required field is the **Signal Name
 * (topic)**, and the node's display name mirrors that name. The optional
 * payload template (`${var:NAME}` resolved at emit time) is kept working but
 * tucked behind an "Advanced" disclosure so it no longer clutters the default
 * surface — existing flows that carry a payload keep emitting it unchanged.
 */
export const SignalNodePropertiesModal = ({ open, node, onClose, onSave }: SignalNodePropertiesModalProps) => {
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { ...node.data.properties },
      });
      // Open the advanced section automatically when a payload already exists,
      // so legacy/AI-authored payloads stay visible when re-editing.
      setShowAdvanced(!!node.data.properties?.payloadTemplate);
    }
  }, [node, open]);

  const setProperty = (key: string, value: unknown) => {
    setNodeData((prev) => (prev ? { ...prev, properties: { ...prev.properties, [key]: value } } : prev));
  };

  const handleSave = () => {
    if (!node || !nodeData) return;
    const properties = { ...nodeData.properties };
    const topic = typeof properties.topic === 'string' ? properties.topic.trim() : '';
    properties.topic = topic;
    // Display name == signal name (#164). Fall back to a stable placeholder so
    // a not-yet-named node still renders something sensible on the canvas.
    const label = topic || 'Signal';
    onSave(node.id, { ...nodeData, label, properties });
  };

  if (!nodeData) return null;

  const topic: string = nodeData.properties?.topic ?? '';
  const payloadTemplate: string = nodeData.properties?.payloadTemplate ?? '';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Signal Node</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <TextField
            label="Signal Name (topic)"
            value={topic}
            onChange={(e) => setProperty('topic', e.target.value)}
            fullWidth
            required
            autoFocus
            error={!topic.trim()}
            placeholder="e.g. review-blocked"
            helperText={
              !topic.trim()
                ? 'A signal name is required — a flow-event trigger listens for this exact name.'
                : 'A free-form shared name (no registry). A planned execution reacts to it via a flow-event trigger with this signal name. This is also the node’s display name.'
            }
          />

          <Alert severity="info">
            When execution reaches this node it emits the signal and continues
            immediately (fire-and-forget). To emit conditionally, put a
            conditioned edge into this node. Runaway signal chains are bounded by
            the trigger&rsquo;s max chain depth.
          </Alert>

          <Link
            component="button"
            type="button"
            underline="hover"
            onClick={() => setShowAdvanced((v) => !v)}
            sx={{ alignSelf: 'flex-start' }}
          >
            {showAdvanced ? 'Hide advanced' : 'Advanced — optional payload'}
          </Link>
          <Collapse in={showAdvanced} unmountOnExit>
            <TextField
              label="Payload template (optional)"
              value={payloadTemplate}
              onChange={(e) => setProperty('payloadTemplate', e.target.value)}
              fullWidth
              multiline
              minRows={3}
              placeholder="e.g. Review found blockers: ${var:reviewSummary}"
              helperText="Optional. Emitted as the signal payload and handed to the triggered flow. ${var:NAME} is resolved from run variables at emit time."
            />
          </Collapse>
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
