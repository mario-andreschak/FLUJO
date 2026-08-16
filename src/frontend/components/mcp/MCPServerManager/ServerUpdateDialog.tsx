'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import {
  Box,
  Typography,
  Alert,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Checkbox,
  FormControlLabel,
  Chip,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import Spinner from '@/frontend/components/shared/Spinner';
import { createLogger } from '@/utils/logger';
import {
  ServerUpdateInfo,
  UpdateCommitsPreview,
  pullServerUpdate,
  fetchUpdateCommitsPreview,
  shortSha,
} from './utils/serverUpdates';
import {
  installDependencies,
  buildServer,
} from './Modals/ServerModal/utils/buildUtils';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/mcp/MCPServerManager/ServerUpdateDialog');

type StepKey = 'stop' | 'pull' | 'install' | 'build' | 'restart';
type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface ServerUpdateDialogProps {
  open: boolean;
  onClose: () => void;
  serverName: string;
  rootPath: string;
  installCommand?: string;
  buildCommand?: string;
  /** Whether the server is currently enabled (drives the stop/restart steps). */
  enabled: boolean;
  updateInfo: ServerUpdateInfo;
  /** Toggle the server on/off; may return a promise that resolves when done. */
  onToggle: (enabled: boolean) => void | Promise<void>;
  /** Called after a successful update so the parent can refresh the update badge. */
  onUpdated?: () => void;
}

const ServerUpdateDialog: React.FC<ServerUpdateDialogProps> = ({
  open,
  onClose,
  serverName,
  rootPath,
  installCommand,
  buildCommand,
  enabled,
  updateInfo,
  onToggle,
  onUpdated,
}) => {
  const { t, tp } = useI18n();
  const [preview, setPreview] = useState<UpdateCommitsPreview | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stepStates, setStepStates] = useState<Partial<Record<StepKey, StepStatus>>>({});
  const [output, setOutput] = useState('');

  const hasInstall = Boolean(installCommand && installCommand.trim());
  const hasBuild = Boolean(buildCommand && buildCommand.trim());

  const steps: Array<{ key: StepKey; label: string; active: boolean }> = [
    { key: 'stop', label: t('mcp.update.stop'), active: enabled },
    { key: 'pull', label: t('mcp.update.pullLatest'), active: true },
    { key: 'install', label: t('mcp.update.installDeps', { command: installCommand ?? '' }), active: hasInstall },
    { key: 'build', label: t('mcp.update.build', { command: buildCommand ?? '' }), active: hasBuild },
    { key: 'restart', label: t('mcp.update.restart'), active: enabled },
  ];

  // Reset transient state whenever the dialog is (re)opened for a server.
  useEffect(() => {
    if (open) {
      setConfirmDiscard(false);
      setRunning(false);
      setFinished(false);
      setErrorMessage(null);
      setStepStates({});
      setOutput('');
    }
  }, [open, serverName]);

  // Best-effort "what's new" preview for GitHub remotes.
  useEffect(() => {
    if (open && updateInfo.remoteUrl && updateInfo.localSha && updateInfo.remoteSha) {
      let cancelled = false;
      fetchUpdateCommitsPreview(updateInfo.remoteUrl, updateInfo.localSha, updateInfo.remoteSha)
        .then((p) => {
          if (!cancelled) setPreview(p);
        });
      return () => {
        cancelled = true;
      };
    }
    setPreview(null);
  }, [open, updateInfo.remoteUrl, updateInfo.localSha, updateInfo.remoteSha]);

  const setStep = useCallback((key: StepKey, status: StepStatus) => {
    setStepStates((prev) => ({ ...prev, [key]: status }));
  }, []);

  const appendOutput = useCallback((title: string, text?: string) => {
    setOutput((prev) => prev + (prev ? '\n' : '') + `--- ${title} ---\n` + (text || '').trim() + '\n');
  }, []);

  const runUpdate = async () => {
    setRunning(true);
    setErrorMessage(null);
    log.info(`Starting update for server ${serverName}`);

    const fail = (step: StepKey, message: string) => {
      setStep(step, 'error');
      setErrorMessage(message);
      setRunning(false);
    };

    try {
      if (enabled) {
        setStep('stop', 'running');
        await Promise.resolve(onToggle(false));
        setStep('stop', 'done');
      }

      setStep('pull', 'running');
      const pull = await pullServerUpdate(rootPath);
      if (!pull.success) {
        fail('pull', pull.error || t('mcp.update.pullFailed'));
        return;
      }
      appendOutput(t('mcp.update.pull'), t('mcp.update.updatedShas', {
        old: shortSha(pull.oldSha),
        new: shortSha(pull.newSha),
      }));
      setStep('pull', 'done');

      if (hasInstall) {
        setStep('install', 'running');
        const install = await installDependencies(rootPath, installCommand!.trim(), undefined, t);
        appendOutput(t('mcp.update.install'), install.output);
        if (!install.success) {
          fail('install', install.message.text);
          return;
        }
        setStep('install', 'done');
      }

      if (hasBuild) {
        setStep('build', 'running');
        const build = await buildServer(rootPath, buildCommand!.trim(), undefined, t);
        appendOutput(t('mcp.update.buildOutput'), build.output);
        if (!build.success) {
          fail('build', build.message.text);
          return;
        }
        setStep('build', 'done');
      }

      if (enabled) {
        setStep('restart', 'running');
        await Promise.resolve(onToggle(true));
        setStep('restart', 'done');
      }

      log.info(`Update completed for server ${serverName}`);
      setFinished(true);
      setRunning(false);
      onUpdated?.();
    } catch (error) {
      log.error(`Update failed for server ${serverName}`, error);
      setErrorMessage((error as Error).message || t('mcp.update.failed'));
      setRunning(false);
    }
  };

  const stepIcon = (status: StepStatus | undefined) => {
    switch (status) {
      case 'running':
        return <Spinner size="small" color="primary" />;
      case 'done':
        return <CheckCircleIcon color="success" fontSize="small" />;
      case 'error':
        return <ErrorIcon color="error" fontSize="small" />;
      default:
        return <RadioButtonUncheckedIcon color="disabled" fontSize="small" />;
    }
  };

  const started = running || finished || Object.keys(stepStates).length > 0;
  const updateBlocked = updateInfo.hasLocalChanges && !confirmDiscard;

  return (
    <Dialog open={open} onClose={running ? undefined : onClose} maxWidth="sm" fullWidth onClick={(e) => e.stopPropagation()}>
      <DialogHeaderActions
        title={(
          <Box display="flex" alignItems="center" gap={1} minWidth={0}>
            <SystemUpdateAltIcon color="primary" />
            <Typography variant="h6" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {t('mcp.update.title', { server: serverName })}
            </Typography>
          </Box>
        )}
        onClose={() => { if (!running) onClose(); }}
      />
      <DialogContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
          <Chip size="small" label={shortSha(updateInfo.localSha)} sx={{ fontFamily: 'monospace' }} />
          <Typography variant="body2" color="text.secondary">→</Typography>
          <Chip size="small" color="primary" label={shortSha(updateInfo.remoteSha)} sx={{ fontFamily: 'monospace' }} />
          {updateInfo.branch && updateInfo.branch !== 'HEAD' && (
            <Typography variant="body2" color="text.secondary">
              {t('mcp.update.onBranch', { branch: updateInfo.branch })}
            </Typography>
          )}
          {preview?.behindBy != null && (
            <Typography variant="body2" color="text.secondary">
              {tp('mcp.update.behind', preview.behindBy)}
            </Typography>
          )}
        </Box>

        {updateInfo.repoRoot &&
          updateInfo.repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !==
            rootPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {t('mcp.update.largerRepo', { root: updateInfo.repoRoot })}
            </Typography>
          )}

        {preview && preview.commits.length > 0 && !started && (
          <Box
            sx={{
              mb: 2,
              p: 1,
              borderRadius: 1,
              border: '1px solid',
              borderColor: 'divider',
              maxHeight: 160,
              overflow: 'auto',
            }}
          >
            {preview.commits.map((c) => (
              <Typography key={c.sha} variant="body2" sx={{ fontSize: '0.8rem' }} noWrap title={c.message}>
                <code>{c.sha}</code> {c.message}
              </Typography>
            ))}
          </Box>
        )}

        {updateInfo.hasLocalChanges && !started && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t('mcp.update.localChanges')}
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 3, maxHeight: 100, overflow: 'auto' }}>
              {updateInfo.dirtyFiles.map((f) => (
                <li key={f}>
                  <Typography variant="body2" component="span" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {f}
                  </Typography>
                </li>
              ))}
            </Box>
            <FormControlLabel
              sx={{ mt: 1 }}
              control={
                <Checkbox
                  size="small"
                  checked={confirmDiscard}
                  onChange={(e) => setConfirmDiscard(e.target.checked)}
                />
              }
              label={<Typography variant="body2">{t('mcp.update.confirmDiscard')}</Typography>}
            />
          </Alert>
        )}

        <List dense disablePadding>
          {steps.filter((s) => s.active).map((s) => (
            <ListItem key={s.key} disableGutters sx={{ py: 0.25 }}>
              <ListItemIcon sx={{ minWidth: 32 }}>{stepIcon(stepStates[s.key])}</ListItemIcon>
              <ListItemText
                primary={s.label}
                primaryTypographyProps={{ variant: 'body2', noWrap: true, title: s.label }}
              />
            </ListItem>
          ))}
        </List>

        {errorMessage && (
          <Alert severity="error" sx={{ mt: 2, whiteSpace: 'pre-wrap' }}>
            {errorMessage}
            {enabled && (
              <Typography variant="body2" sx={{ mt: 1 }}>
                {t('mcp.update.leftStopped')}
              </Typography>
            )}
          </Alert>
        )}

        {finished && (
          <Alert severity="success" sx={{ mt: 2 }}>
            {enabled ? t('mcp.update.successRestarted') : t('mcp.update.success')}
          </Alert>
        )}

        {output && (
          <Box
            sx={{
              mt: 2,
              p: 1,
              borderRadius: 1,
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              whiteSpace: 'pre-wrap',
              overflow: 'auto',
              maxHeight: 200,
            }}
          >
            {output}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={running}>
          {finished ? t('mcp.update.close') : t('mcp.update.cancel')}
        </Button>
        {!finished && (
          <Button
            variant="contained"
            color="primary"
            startIcon={<SystemUpdateAltIcon />}
            onClick={runUpdate}
            disabled={running || updateBlocked}
          >
            {running ? t('mcp.update.updating') : errorMessage ? t('mcp.update.retry') : t('mcp.update.action')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default ServerUpdateDialog;
