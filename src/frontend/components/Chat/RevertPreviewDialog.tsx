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
  FormControl,
  FormControlLabel,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';
import {
  chatService,
  type RestoreMode,
  type RevertPreview,
} from '@/frontend/services/chat';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface Props {
  open: boolean;
  conversationId: string;
  messageId: string | null;
  onClose: () => void;
  onReverted?: (messageId: string) => void;
}

export default function RevertPreviewDialog({ open, conversationId, messageId, onClose, onReverted }: Props) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<RevertPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [mode, setMode] = useState<RestoreMode>('chat-and-files');

  useEffect(() => {
    if (!open || !messageId) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    setOperationId(null);
    setLoading(true);
    chatService.previewRevert(conversationId, messageId)
      .then(value => {
        if (cancelled) return;
        setPreview(value);
        setMode(value.fileRestoreAvailable ? 'chat-and-files' : 'chat-only');
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : t('chat.revert.previewFailed')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversationId, messageId, open, t]);

  const confirm = async () => {
    if (!messageId || !preview) return;
    setConfirming(true);
    setError(null);
    try {
      const result = await chatService.revertToMessage(
        conversationId,
        messageId,
        preview.previewId,
        mode,
      );
      setOperationId(result.operationId);
      onReverted?.(messageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chat.revert.failed'));
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
      if (messageId) onReverted?.(messageId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chat.revert.undoFailed'));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onClose={confirming ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{t('chat.revert.title')}</DialogTitle>
      <DialogContent>
        {(loading || confirming) && <LinearProgress sx={{ mb: 2 }} />}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {operationId ? (
          <Alert severity="success">{t('chat.revert.success')}</Alert>
        ) : preview && (
          <>
            <FormControl component="fieldset" fullWidth sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                {t('chat.revert.chooseMode')}
              </Typography>
              <RadioGroup
                value={mode}
                onChange={event => setMode(event.target.value as RestoreMode)}
              >
                <FormControlLabel
                  value="chat-and-files"
                  control={<Radio />}
                  disabled={!preview.fileRestoreAvailable}
                  label={t('chat.revert.mode.chatAndFiles')}
                />
                <FormControlLabel
                  value="files-only"
                  control={<Radio />}
                  disabled={!preview.fileRestoreAvailable}
                  label={t('chat.revert.mode.filesOnly')}
                />
                <FormControlLabel
                  value="chat-only"
                  control={<Radio />}
                  label={t('chat.revert.mode.chatOnly')}
                />
              </RadioGroup>
            </FormControl>

            <Alert severity="warning" sx={{ mb: 2 }}>
              {t('chat.revert.nonFileWarning')}
            </Alert>

            <Typography variant="subtitle2">{t('chat.revert.restrictionsTitle')}</Typography>
            <Box component="ul" sx={{ mt: 0.5, mb: 2, pl: 3 }}>
              <Typography component="li" variant="body2">
                {t('chat.revert.chatBoundary', { count: preview.chatMessageCount })}
              </Typography>
              <Typography component="li" variant="body2">
                {t('chat.revert.fileBoundary')}
              </Typography>
              <Typography component="li" variant="body2">
                {t('chat.revert.runningRestriction')}
              </Typography>
            </Box>

            {!preview.fileRestoreAvailable && (
              <Alert severity="info" sx={{ mb: 2 }}>
                {t(`chat.revert.fileUnavailable.${preview.fileRestoreUnavailableReason ?? 'no-snapshotted-file-changes'}`)}
              </Alert>
            )}

            {preview.fileRestoreAvailable && (
              <>
                <Typography variant="body2">{t('chat.revert.review')}</Typography>
                <List dense>
                  {preview.files.map(file => (
                    <ListItem key={`${file.status}:${file.path}`} disableGutters>
                      <ListItemText primary={file.path} secondary={file.status} />
                    </ListItem>
                  ))}
                </List>
                <Box component="pre" sx={{ maxHeight: 360, overflow: 'auto', p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                  {preview.diff || t('chat.revert.noDiff')}
                </Box>
                {preview.truncated && <Typography variant="caption">{t('chat.revert.truncated')}</Typography>}
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={confirming}>{t('common.cancel')}</Button>
        {operationId ? (
          <Button onClick={undo} disabled={confirming}>{t('chat.revert.undo')}</Button>
        ) : (
          <Button color="error" variant="contained" onClick={confirm} disabled={!preview || loading || confirming}>
            {t('chat.revert.confirm')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
