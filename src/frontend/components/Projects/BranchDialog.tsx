"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
} from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { folderName, switchableBranches, type ProjectGitInfo } from '@/frontend/hooks/useProjects';

export type BranchDialogMode = 'switch' | 'create' | 'worktree';

interface BranchDialogProps {
  open: boolean;
  mode: BranchDialogMode;
  git: ProjectGitInfo | null;
  /** The folder the branch operation applies to. */
  folder: string;
  onClose: () => void;
  /** `create` is true when the branch does not exist yet. */
  onSubmit: (branch: string, create: boolean) => Promise<void>;
}

/** Switch to, create, or open a branch in a new worktree. */
export function BranchDialog({ open, mode, git, folder, onClose, onSubmit }: BranchDialogProps) {
  const { t } = useI18n();
  const [branch, setBranch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBranch('');
    setError(null);
    setSaving(false);
  }, [open, mode]);

  const allBranches = useMemo(() => switchableBranches(git), [git]);
  // Git refuses to check out a branch that another worktree (or this folder)
  // already has, so those are never offered for a switch or a new worktree.
  const options = useMemo(() => {
    if (mode === 'create') return allBranches;
    const checkedOut = new Set(git?.worktrees.map(worktree => worktree.branch).filter(Boolean));
    if (git?.branch) checkedOut.add(git.branch);
    return allBranches.filter(name => !checkedOut.has(name));
  }, [allBranches, git, mode]);

  const trimmed = branch.trim();
  // The list is capped on the server, so an unlisted name may still exist:
  // switching accepts any typed name and Git reports a missing branch.
  const exists = allBranches.includes(trimmed) || trimmed === git?.branch;
  const create = mode === 'create' || (mode === 'worktree' && !exists);
  const canSubmit = Boolean(trimmed) && !saving
    && (mode !== 'switch' || trimmed !== git?.branch)
    && !(mode === 'create' && exists);
  const mainCheckout = git?.worktrees.find(worktree => worktree.main)?.path ?? folder;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(trimmed, create);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'switch'
    ? t('projects.dialog.switchTitle')
    : mode === 'create'
      ? t('projects.dialog.createTitle')
      : t('projects.dialog.worktreeTitle');
  const help = mode === 'switch'
    ? t('projects.dialog.switchHelp', { path: folder })
    : mode === 'create'
      ? t('projects.dialog.createHelp')
      : t('projects.dialog.worktreeHelp', { folder: `${folderName(mainCheckout)}.worktrees` });

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs">
      <form onSubmit={submit}>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <DialogContentText variant="body2" sx={{ mb: 2, wordBreak: 'break-word' }}>{help}</DialogContentText>
          {mode === 'create' ? (
            <TextField
              autoFocus
              fullWidth
              size="small"
              label={t('projects.dialog.branch')}
              value={branch}
              disabled={saving}
              error={Boolean(trimmed) && exists}
              onChange={event => setBranch(event.target.value)}
              slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off' } }}
            />
          ) : (
            <Autocomplete
              freeSolo
              options={options}
              inputValue={branch}
              onInputChange={(_event, value) => setBranch(value)}
              disabled={saving}
              renderInput={params => (
                <TextField {...params} autoFocus size="small" label={t('projects.dialog.branch')} />
              )}
            />
          )}
          {mode === 'worktree' && trimmed && create && (
            <Alert severity="info" sx={{ mt: 1.5 }}>{t('projects.dialog.newBranchNote', { branch: trimmed })}</Alert>
          )}
          {error && <Alert severity="error" sx={{ mt: 1.5, wordBreak: 'break-word' }}>{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button type="submit" variant="contained" disabled={!canSubmit}>
            {saving && <CircularProgress size={16} color="inherit" sx={{ mr: 1 }} />}
            {mode === 'switch' ? t('projects.dialog.switchAction') : t('projects.dialog.createAction')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export default BranchDialog;
