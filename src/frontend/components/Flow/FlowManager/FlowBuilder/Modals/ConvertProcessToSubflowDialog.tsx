"use client";

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { Flow } from '@/shared/types/flow';
import {
  buildProcessToSubflowDraft,
  type ProcessToSubflowDraft,
} from '../utils/convertProcessToSubflow';

interface ConvertProcessToSubflowDialogProps {
  open: boolean;
  processNodeId: string | null;
  parentFlow: Flow;
  existingFlowNames: string[];
  onClose: () => void;
  onAccept: (draft: ProcessToSubflowDraft) => Promise<void>;
}

export default function ConvertProcessToSubflowDialog({
  open,
  processNodeId,
  parentFlow,
  existingFlowNames,
  onClose,
  onAccept,
}: ConvertProcessToSubflowDialogProps) {
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<ProcessToSubflowDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const process = parentFlow.nodes.find(node => node.id === processNodeId);
    const suggested = `${String(process?.data?.label || 'Process').replace(/[^\w-]+/g, '_')}_subflow`;
    setName(suggested);
    setDraft(null);
    setSaving(false);
    setSaveError(null);
  }, [open, processNodeId, parentFlow.nodes]);

  const buildPreview = () => {
    if (!processNodeId) return;
    setSaveError(null);
    setDraft(buildProcessToSubflowDraft({
      parentFlow,
      processNodeId,
      subflowName: name,
      existingFlowNames,
    }));
  };

  const accept = async () => {
    if (!draft?.valid || !draft.childFlow || !draft.parentFlow) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onAccept(draft);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The conversion could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{draft ? 'Preview Process conversion' : 'Convert Process to subflow'}</DialogTitle>
      <DialogContent>
        {!draft ? (
          <>
            <DialogContentText sx={{ mb: 2 }}>
              Name the child flow. The next step builds a non-persisted preview; closing or rejecting it changes nothing.
            </DialogContentText>
            <TextField
              autoFocus
              fullWidth
              label="Subflow name"
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') buildPreview();
              }}
            />
          </>
        ) : (
          <Stack spacing={2}>
            {draft.errors.length > 0 && (
              <Alert severity="error">
                <Typography fontWeight={600}>This graph cannot be converted yet.</Typography>
                <List dense disablePadding>
                  {draft.errors.map((error, index) => (
                    <ListItem key={`${error.code}-${index}`} disableGutters>
                      <ListItemText primary={error.message} />
                    </ListItem>
                  ))}
                </List>
              </Alert>
            )}
            {saveError && <Alert severity="error">{saveError}</Alert>}
            {draft.preview.warnings.map((warning, index) => (
              <Alert severity="warning" key={`${warning}-${index}`}>{warning}</Alert>
            ))}

            <Box>
              <Typography variant="subtitle1" fontWeight={600}>Included in “{name.trim()}”</Typography>
              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
                {draft.preview.includedNodes.map(node => (
                  <Chip key={node.id} label={`${node.label} · ${node.type}`} size="small" />
                ))}
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {draft.preview.attachmentCount} attachment(s), {draft.preview.signalCount} signal(s), and {draft.preview.internalEdgeCount} internal edge(s).
              </Typography>
            </Box>

            <Divider />

            <Box>
              <Typography variant="subtitle1" fontWeight={600}>Boundary and rewiring</Typography>
              <List dense>
                {draft.preview.rewires.map(rewire => (
                  <ListItem key={rewire} disableGutters><ListItemText primary={rewire} /></ListItem>
                ))}
              </List>
              {draft.preview.excludedBoundaryNodes.length > 0 && (
                <Typography variant="body2" color="text.secondary">
                  Kept in parent: {draft.preview.excludedBoundaryNodes.map(node => `${node.label} (${node.type})`).join(', ')}
                </Typography>
              )}
            </Box>

            <Alert severity="info">
              Accepting saves the child and parent together. If either save fails, the server compensates so the parent is restored and no child is left behind.
            </Alert>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{draft ? 'Reject' : 'Cancel'}</Button>
        {draft ? (
          <>
            <Button onClick={() => { setDraft(null); setSaveError(null); }} disabled={saving}>Back</Button>
            <Button variant="contained" onClick={accept} disabled={!draft.valid || saving}>
              {saving ? 'Converting…' : 'Accept conversion'}
            </Button>
          </>
        ) : (
          <Button variant="contained" onClick={buildPreview}>Preview</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
