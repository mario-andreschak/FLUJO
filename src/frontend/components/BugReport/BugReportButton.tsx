"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
} from '@mui/material';
import BugReportIcon from '@mui/icons-material/BugReport';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
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
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState<SafeBugContext | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [labels, setLabels] = useState<BugReportLabel[]>(['bug']);
  const [enhancing, setEnhancing] = useState(false);
  const [notice, setNotice] = useState<{ severity: 'info' | 'warning' | 'error' | 'success'; text: string } | null>(null);

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
    () => (context ? formatContextBlock(context) : 'Collecting app context…'),
    [context]
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
          ? { severity: 'success', text: 'AI suggestion applied — review and edit before submitting.' }
          : { severity: 'warning', text: 'AI enhancement was unavailable; your original text is unchanged.' }
      );
    } catch (err) {
      log.error('Bug-report enhancement failed', err);
      setNotice({ severity: 'error', text: 'Enhancement failed — you can still submit your report as-is.' });
    } finally {
      setEnhancing(false);
    }
  }, [selectedModelId, context, title, description]);

  const handleSubmit = useCallback(() => {
    const body = context ? `${description.trim()}\n\n${formatContextBlock(context)}` : description.trim();
    openGitHubNewIssue({ title: title.trim() || 'Bug report', body, labels });
  }, [title, description, context, labels]);

  const handleClose = useCallback(() => setOpen(false), []);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <>
      {variant === 'icon' ? (
        <Tooltip title="Report a bug">
          <IconButton onClick={handleOpen} color="inherit" aria-label="Report a bug">
            <BugReportIcon />
          </IconButton>
        </Tooltip>
      ) : (
        <Button variant="contained" startIcon={<BugReportIcon />} onClick={handleOpen}>
          Report a Bug
        </Button>
      )}

      <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
        <DialogTitle>Report a Bug</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Found a problem? Describe it here. FLUJO attaches only safe, non-sensitive context
              (app version, install mode, browser/OS, the current page, and the <em>names</em> of
              your configured MCP servers). No API keys, environment variables, or secrets are ever
              included. You can optionally polish the report with an AI model, then review it on
              GitHub before submitting.
            </Typography>

            {notice && <Alert severity={notice.severity}>{notice.text}</Alert>}

            <TextField
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
              placeholder="Short summary of the problem"
            />

            <TextField
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              fullWidth
              multiline
              minRows={6}
              placeholder="What happened? What did you expect? Steps to reproduce?"
            />

            <Divider />

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Enhance with AI (optional)
              </Typography>
              {models.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No models configured — add a model in the Models page to enable AI enhancement.
                  You can still file the report without it.
                </Typography>
              ) : (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                  <TextField
                    select
                    label="Model"
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
                    {enhancing ? 'Enhancing…' : 'Enhance with AI'}
                  </Button>
                </Stack>
              )}
            </Box>

            <Divider />

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Included app context (read-only)
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
          <Button onClick={handleClose}>Cancel</Button>
          <Button variant="contained" onClick={handleSubmit} disabled={!description.trim()}>
            Open on GitHub
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
