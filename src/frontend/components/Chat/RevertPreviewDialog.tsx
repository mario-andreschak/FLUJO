'use client';

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Typography,
} from '@mui/material';
import { chatService, type RevertPreview } from '@/frontend/services/chat';

interface Props {
  open: boolean;
  conversationId: string;
  messageId: string | null;
  onClose: () => void;
  onReverted?: (messageId: string) => void;
}

export default function RevertPreviewDialog({ open, conversationId, messageId, onClose, onReverted }: Props) {
  const [preview, setPreview] = useState<RevertPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !messageId) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    setOperationId(null);
    setLoading(true);
    chatService.previewRevert(conversationId, messageId)
      .then(value => { if (!cancelled) setPreview(value); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load preview'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversationId, messageId, open]);

  const confirm = async () => {
    if (!messageId || !preview) return;
    setConfirming(true);
    setError(null);
    try {
      const result = await chatService.revertToMessage(conversationId, messageId, preview.previewId);
      setOperationId(result.operationId);
      onReverted?.(messageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to revert changes');
    } finally {
      setConfirming(false);
    }
  };

  const undo = async () => {
    if (!operationId) return;
    setConfirming(true);
    setError(null);
    try {
      await chatService.undoRevert(conversationId, operationId);
      setOperationId(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to undo revert');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onClose={confirming ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>Revert to here</DialogTitle>
      <DialogContent>
        {(loading || confirming) && <LinearProgress sx={{ mb: 2 }} />}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {operationId ? (
          <Alert severity="success">Changes were reverted. You can undo this operation now.</Alert>
        ) : preview && (
          <>
            <Typography variant="body2">Review the affected files before changing the worktree.</Typography>
            <List dense>
              {preview.files.map(file => (
                <ListItem key={`${file.status}:${file.path}`} disableGutters>
                  <ListItemText primary={file.path} secondary={file.status} />
                </ListItem>
              ))}
            </List>
            <Box component="pre" sx={{ maxHeight: 360, overflow: 'auto', p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {preview.diff || 'No textual diff available.'}
            </Box>
            {preview.truncated && <Typography variant="caption">Preview truncated for safety.</Typography>}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={confirming}>Cancel</Button>
        {operationId ? (
          <Button onClick={undo} disabled={confirming}>Undo revert</Button>
        ) : (
          <Button color="error" variant="contained" onClick={confirm} disabled={!preview || loading || confirming}>
            Confirm Revert
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
