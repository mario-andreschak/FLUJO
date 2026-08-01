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
import { useI18n } from '@/frontend/contexts/I18nContext';

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
  const { t, tp, formatList } = useI18n();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<ProcessToSubflowDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const process = parentFlow.nodes.find(node => node.id === processNodeId);
    const suggested = `${String(process?.data?.label || t('flows.convert.processDefault')).replace(/[^\w-]+/g, '_')}_subflow`;
    setName(suggested);
    setDraft(null);
    setSaving(false);
    setSaveError(null);
  }, [open, processNodeId, parentFlow.nodes, t]);

  const buildPreview = () => {
    if (!processNodeId) return;
    setSaveError(null);
    setDraft(buildProcessToSubflowDraft({
      parentFlow,
      processNodeId,
      subflowName: name,
      existingFlowNames,
      t,
      tp,
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
      setSaveError(error instanceof Error ? error.message : t('flows.convert.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{draft ? t('flows.convert.previewTitle') : t('flows.convert.title')}</DialogTitle>
      <DialogContent>
        {!draft ? (
          <>
            <DialogContentText sx={{ mb: 2 }}>
              {t('flows.convert.help')}
            </DialogContentText>
            <TextField
              autoFocus
              fullWidth
              label={t('flows.convert.name')}
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
                <Typography fontWeight={600}>{t('flows.convert.invalid')}</Typography>
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
              <Typography variant="subtitle1" fontWeight={600}>{t('flows.convert.included', { name: name.trim() })}</Typography>
              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
                {draft.preview.includedNodes.map(node => (
                  <Chip key={node.id} label={`${node.label} · ${node.type}`} size="small" />
                ))}
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {t('flows.convert.summary', {
                  attachments: tp('flows.convert.attachment', draft.preview.attachmentCount),
                  signals: tp('flows.convert.signal', draft.preview.signalCount),
                  edges: tp('flows.convert.edge', draft.preview.internalEdgeCount),
                })}
              </Typography>
            </Box>

            <Divider />

            <Box>
              <Typography variant="subtitle1" fontWeight={600}>{t('flows.convert.boundary')}</Typography>
              <List dense>
                {draft.preview.rewires.map(rewire => (
                  <ListItem key={rewire} disableGutters><ListItemText primary={rewire} /></ListItem>
                ))}
              </List>
              {draft.preview.excludedBoundaryNodes.length > 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t('flows.convert.keptParent', {
                    nodes: formatList(draft.preview.excludedBoundaryNodes.map(node => `${node.label} (${node.type})`)),
                  })}
                </Typography>
              )}
            </Box>

            <Alert severity="info">
              {t('flows.convert.atomic')}
            </Alert>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{draft ? t('flows.convert.reject') : t('flows.modal.cancel')}</Button>
        {draft ? (
          <>
            <Button onClick={() => { setDraft(null); setSaveError(null); }} disabled={saving}>{t('flows.convert.back')}</Button>
            <Button variant="contained" onClick={accept} disabled={!draft.valid || saving}>
              {saving ? t('flows.convert.converting') : t('flows.convert.accept')}
            </Button>
          </>
        ) : (
          <Button variant="contained" onClick={buildPreview}>{t('flows.convert.preview')}</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
