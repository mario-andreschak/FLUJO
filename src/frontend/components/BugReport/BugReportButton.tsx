"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Alert,
  CircularProgress,
  Divider,
  Stack,
  InputAdornment,
} from '@mui/material';
import BugReportIcon from '@mui/icons-material/BugReport';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import ClearIcon from '@mui/icons-material/Clear';
import { createLogger } from '@/utils/logger';
import { modelService } from '@/frontend/services/model';
import { Model } from '@/shared/types/model';
import {
  SafeBugContext,
  BugReportLabel,
  formatContextBlock,
} from '@/shared/types/bugReport';
import { collectBugReportContext } from '@/frontend/utils/bugReportContext';
import { openGitHubNewIssue } from '@/frontend/utils/openGitHubIssue';
import { bugReportService } from '@/frontend/services/bugReport';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';

const log = createLogger('frontend/components/BugReport/BugReportButton');

export interface BugReportButtonProps {
  /**
   * How to render the trigger:
   *  - 'icon'   → a compact `IconButton` (used in the top navigation bar).
   *  - 'button' → a labelled `Button` (used inside Settings, if kept).
   */
  variant?: 'icon' | 'button';
}

/**
 * Self-contained "Report a Bug" trigger + dialog.
 *
 * Owns all report logic: dialog open state, title/description fields, model-based
 * "Enhance with AI", read-only safe-context preview, and submit → openGitHubNewIssue.
 * The safe context (see collectBugReportContext / SafeBugContext) is collected fresh
 * every time the dialog opens, so it reflects the page the user was on.
 */
export default function BugReportButton({ variant = 'icon' }: BugReportButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState<SafeBugContext | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [labels, setLabels] = useState<BugReportLabel[]>(['bug']);
  const [enhancing, setEnhancing] = useState(false);
  const [notice, setNotice] = useState<{
    severity: 'info' | 'warning' | 'error' | 'success';
    message: TranslationKey;
  } | null>(null);

  const loadDialogData = useCallback(async () => {
    try {
      const ctx = await collectBugReportContext();
      setContext(ctx);
    } catch (err) {
      log.warn('Failed to collect bug-report context', err);
    }
    try {
      const list = await modelService.loadModels();
      setModels(list);
      if (list.length > 0) setSelectedModelId((prev) => prev || list[0].id);
    } catch (err) {
      log.warn('Failed to load models for bug-report enhancement', err);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadDialogData();
    }
  }, [open, loadDialogData]);

  const contextPreview = useMemo(
    () => (context ? formatContextBlock(context) : t('bugReport.collectingContext')),
    [context, t]
  );

  const handleEnhance = useCallback(async () => {
    if (!selectedModelId || !context) return;
    setEnhancing(true);
    setNotice(null);
    try {
      const result = await bugReportService.enhance({
        modelId: selectedModelId,
        title,
        description,
        context,
      });
      setTitle(result.title);
      setDescription(result.body);
      setLabels(result.labels?.length ? result.labels : ['bug']);
      setNotice(
        result.enhanced
          ? { severity: 'success', message: 'bugReport.applied' }
          : { severity: 'warning', message: 'bugReport.unavailable' }
      );
    } catch (err) {
      log.error('Bug-report enhancement failed', err);
      setNotice({ severity: 'error', message: 'bugReport.enhanceFailed' });
    } finally {
      setEnhancing(false);
    }
  }, [selectedModelId, context, title, description]);

  const canSubmit = description.trim().length > 0;

  const handleSubmit = useCallback(() => {
    if (!description.trim()) return; // shortcut must not bypass validation
    const body = context ? `${description.trim()}\n\n${formatContextBlock(context)}` : description.trim();
    openGitHubNewIssue({ title: title.trim() || t('bugReport.defaultTitle'), body, labels });
  }, [title, description, context, labels, t]);

  const handleFieldKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation(); // keep the Dialog / parent modal out of it
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const descriptionInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => titleInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setTitle('');
    setDescription('');
    setLabels(['bug']);
    setNotice(null);
  }, []);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <>
      {variant === 'icon' ? (
        <Tooltip title={t('bugReport.action')}>
          <IconButton onClick={handleOpen} color="inherit" aria-label={t('bugReport.action')}>
            <BugReportIcon />
          </IconButton>
        </Tooltip>
      ) : (
        <Button variant="contained" startIcon={<BugReportIcon />} onClick={handleOpen}>
          {t('bugReport.action')}
        </Button>
      )}

      {/*
       * This Dialog is sometimes mounted inside another modal (e.g. a
       * DialogHeaderActions header nested in a config modal). MUI stacks
       * same-level Modals by DOM order, which is normally enough, but Ask
       * FLUJO's dock explicitly bumps its z-index above `theme.zIndex.modal`
       * for the same nested-dialog scenario (see AskFlujoDock.tsx). Mirror
       * that here so the bug-report dialog reliably layers above a parent
       * modal regardless of mount order; this is a no-op for the standalone
       * navigation-bar usage since there is no other modal to layer above.
       */}
      <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth sx={{ zIndex: (theme) => theme.zIndex.modal + 10 }}>
        <DialogTitle>{t('bugReport.title')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              {t('bugReport.intro')}
            </Typography>

            {notice && <Alert severity={notice.severity}>{t(notice.message)}</Alert>}

            <TextField
              autoFocus
              label={t('common.title')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleFieldKeyDown}
              fullWidth
              placeholder={t('bugReport.titlePlaceholder')}
              inputRef={titleInputRef}
              InputProps={{
                endAdornment: title ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      aria-label={t('bugReport.clearTitle')}
                      onClick={() => {
                        setTitle('');
                        titleInputRef.current?.focus();
                      }}
                      edge="end"
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              }}
            />

            <TextField
              label={t('common.description')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleFieldKeyDown}
              fullWidth
              multiline
              minRows={6}
              placeholder={t('bugReport.descriptionPlaceholder')}
              inputRef={descriptionInputRef}
              InputProps={{
                endAdornment: description ? (
                  <InputAdornment position="end" sx={{ alignSelf: 'flex-start', mt: 1 }}>
                    <IconButton
                      size="small"
                      aria-label={t('bugReport.clearDescription')}
                      onClick={() => {
                        setDescription('');
                        descriptionInputRef.current?.focus();
                      }}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              }}
            />

            <Typography variant="caption" color="text.secondary">
              {t('bugReport.submitHint')}
            </Typography>

            <Divider />

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                {t('bugReport.enhanceTitle')}
              </Typography>
              {models.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t('bugReport.noModels')}
                </Typography>
              ) : (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                  <TextField
                    select
                    label={t('common.model')}
                    value={selectedModelId}
                    onChange={(e) => setSelectedModelId(e.target.value)}
                    sx={{ minWidth: 220 }}
                    size="small"
                  >
                    {models.map((m) => (
                      <MenuItem key={m.id} value={m.id}>
                        {m.displayName || m.name}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button
                    variant="outlined"
                    startIcon={enhancing ? <CircularProgress size={16} /> : <AutoFixHighIcon />}
                    onClick={handleEnhance}
                    disabled={enhancing || !selectedModelId || !description.trim() || !context}
                  >
                    {enhancing ? t('bugReport.enhancing') : t('bugReport.enhance')}
                  </Button>
                </Stack>
              )}
            </Box>

            <Divider />

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                {t('bugReport.contextTitle')}
              </Typography>
              <TextField
                value={contextPreview}
                fullWidth
                multiline
                minRows={4}
                InputProps={{ readOnly: true, sx: { fontFamily: 'var(--font-geist-mono)', fontSize: 12 } }}
              />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleSubmit} disabled={!canSubmit}>
            {t('feedback.openGitHub')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
