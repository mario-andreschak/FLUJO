"use client";

import React, { useState } from 'react';
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
  IconButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AddRounded,
  CallSplitRounded,
  CheckRounded,
  ContentCopyRounded,
  DeleteOutlineRounded,
  ExpandLessRounded,
  ExpandMoreRounded,
  FolderCopyOutlined,
  FolderOutlined,
  SwapHorizRounded,
} from '@mui/icons-material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { folderName, useProjects, type ProjectAction, type ProjectGitInfo } from '@/frontend/hooks/useProjects';
import FolderPickerDialog from '@/frontend/components/shared/FolderPickerDialog';
import BranchDialog, { type BranchDialogMode } from './BranchDialog';

/** Display-level path equality (the server compares authoritatively). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

interface ChatProjectChipProps {
  /** The chat whose folder this controls; null before a chat exists. */
  conversationId: string | null;
  /** Shown in the phone run-options sheet: full-width-friendly sizing. */
  large?: boolean;
}

/**
 * The chat's working folder — project, branch and worktree — as a composer
 * chip. Each chat keeps its own folder, so two chats can work on different
 * branches of one repository through worktrees.
 */
export function ChatProjectChip({ conversationId, large = false }: ChatProjectChipProps) {
  const { t } = useI18n();
  const { state, act } = useProjects(conversationId);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<BranchDialogMode | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [showOtherWorktrees, setShowOtherWorktrees] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chat = state?.chat ?? null;
  const git = chat?.git ?? null;
  const inWorktree = Boolean(chat && !samePath(chat.path, chat.project));

  const run = async (action: ProjectAction, body: Record<string, unknown>, close = true) => {
    setError(null);
    try {
      await act(action, body);
      if (close) setAnchorEl(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  if (!state) return null;

  if (!chat) {
    // No folder yet: pick one of the workspace's projects, or add a folder.
    return (
      <>
        <Tooltip title={t('projects.chip.noneHelp')}>
          <Chip
            icon={<FolderOutlined />}
            label={t('projects.chip.none')}
            size={large ? 'medium' : 'small'}
            variant="outlined"
            onClick={event => {
              setError(null);
              if (state.projects.length > 0) setAnchorEl(event.currentTarget);
              else setPickerOpen(true);
            }}
            aria-haspopup={state.projects.length > 0 ? 'menu' : 'dialog'}
            data-chat-project-chip
          />
        </Tooltip>
        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={() => setAnchorEl(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: { sx: { width: 320, maxWidth: 'calc(100vw - 24px)' } } }}
        >
          {error && <Alert severity="error" sx={{ mx: 2, my: 1, wordBreak: 'break-word' }}>{error}</Alert>}
          <ListSubheader sx={{ lineHeight: '32px' }}>{t('projects.menu.project')}</ListSubheader>
          {state.projects.map(project => (
            <MenuItem
              key={project.path}
              dense
              onClick={() => void run(conversationId ? 'bindChat' : 'activate', { project: project.path })}
            >
              <ListItemIcon><FolderOutlined fontSize="small" /></ListItemIcon>
              <ListItemText primary={project.name} secondary={project.path} slotProps={{ secondary: { noWrap: true } }} />
            </MenuItem>
          ))}
          <Divider />
          <MenuItem dense onClick={() => { setAnchorEl(null); setPickerOpen(true); }}>
            <ListItemIcon><AddRounded fontSize="small" /></ListItemIcon>
            <ListItemText primary={t('projects.add')} />
          </MenuItem>
        </Menu>
        <FolderPickerDialog
          open={pickerOpen}
          title={t('projects.chooseFolder')}
          onClose={() => setPickerOpen(false)}
          onSelect={folder => void (async () => {
            setError(null);
            try {
              // The added folder becomes the active project; move this chat there too.
              const next = await act('add', { path: folder });
              if (conversationId && next.activeProject) await act('bindChat', { project: next.activeProject });
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure));
            }
          })()}
        />
      </>
    );
  }

  const branchLabel = git ? (git.branch ?? git.head ?? '') : null;
  const label = (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6, minWidth: 0 }}>
      <Box component="span" sx={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{folderName(chat.path)}</Box>
      {branchLabel !== null && (
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, color: 'text.secondary', minWidth: 0 }}>
          <CallSplitRounded sx={{ fontSize: '0.95rem' }} aria-hidden="true" />
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{branchLabel}</Box>
        </Box>
      )}
      {git && git.changes > 0 && (
        <Box component="span" sx={{ color: 'warning.main', fontWeight: 700 }} aria-label={t('projects.changes', { count: git.changes })}>
          •{git.changes}
        </Box>
      )}
    </Box>
  );

  const removing = git?.worktrees.find(worktree => samePath(worktree.path, removeTarget));

  // Repositories often carry many worktrees from other tools. List the main
  // checkout, FLUJO's own worktrees and this chat's folder; fold the rest away.
  const isListed = (worktree: ProjectGitInfo['worktrees'][number]) =>
    worktree.main || worktree.managed || samePath(worktree.path, chat.path);
  const listedWorktrees = git?.worktrees.filter(isListed) ?? [];
  const otherWorktrees = git?.worktrees.filter(worktree => !isListed(worktree)) ?? [];

  const worktreeItem = (worktree: ProjectGitInfo['worktrees'][number]) => (
    <MenuItem
      key={worktree.path}
      dense
      disabled={!conversationId}
      selected={samePath(worktree.path, chat.path)}
      onClick={() => void run('bindChat', { path: worktree.path })}
    >
      <ListItemIcon>{worktree.main ? <FolderOutlined fontSize="small" /> : <FolderCopyOutlined fontSize="small" />}</ListItemIcon>
      <ListItemText
        primary={worktree.main ? t('projects.menu.mainCheckout') : folderName(worktree.path)}
        secondary={worktree.branch ?? worktree.head}
        slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
      />
      {samePath(worktree.path, chat.path) && <CheckRounded fontSize="small" color="primary" />}
      {/* Only worktrees FLUJO created are offered for removal. */}
      {worktree.managed && (
        <Tooltip title={t('projects.menu.removeWorktree', { name: folderName(worktree.path) })}>
          <IconButton
            size="small"
            edge="end"
            aria-label={t('projects.menu.removeWorktree', { name: folderName(worktree.path) })}
            onClick={event => { event.stopPropagation(); setRemoveTarget(worktree.path); }}
          >
            <DeleteOutlineRounded fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </MenuItem>
  );

  return (
    <>
      <Tooltip title={t('projects.chip.tooltip', { path: chat.path })}>
        <Chip
          icon={inWorktree ? <FolderCopyOutlined /> : <FolderOutlined />}
          label={label}
          size={large ? 'medium' : 'small'}
          variant="outlined"
          color={inWorktree ? 'secondary' : 'default'}
          onClick={event => { setError(null); setAnchorEl(event.currentTarget); }}
          aria-haspopup="menu"
          aria-expanded={anchorEl ? 'true' : undefined}
          data-chat-project-chip
          sx={{ maxWidth: '100%' }}
        />
      </Tooltip>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 360, maxWidth: 'calc(100vw - 24px)', maxHeight: '70vh' } } }}
      >
        <Box sx={{ px: 2, pt: 1, pb: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {chat.path}
          </Typography>
          {git && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {[
                git.branch ? null : t('projects.detached', { head: git.head ?? '' }),
                git.changes > 0 ? t('projects.changes', { count: git.changes }) : null,
                git.upstream && (git.ahead || git.behind)
                  ? t('projects.aheadBehind', { ahead: git.ahead, behind: git.behind, upstream: git.upstream })
                  : null,
              ].filter(Boolean).join(' · ')}
            </Typography>
          )}
          {error && <Alert severity="error" sx={{ mt: 1, wordBreak: 'break-word' }}>{error}</Alert>}
        </Box>

        <ListSubheader sx={{ lineHeight: '32px' }}>{t('projects.menu.project')}</ListSubheader>
        {state.projects.map(project => (
          <MenuItem
            key={project.path}
            dense
            selected={samePath(project.path, chat.project)}
            onClick={() => void run(conversationId ? 'bindChat' : 'activate', { project: project.path })}
          >
            <ListItemIcon><FolderOutlined fontSize="small" /></ListItemIcon>
            <ListItemText
              primary={project.name}
              secondary={project.git ? (project.git.branch ?? project.git.head) : t('projects.notGit')}
            />
            {samePath(project.path, chat.project) && <CheckRounded fontSize="small" color="primary" />}
          </MenuItem>
        ))}

        {git && [
          <ListSubheader key="folder-heading" sx={{ lineHeight: '32px' }}>{t('projects.menu.folder')}</ListSubheader>,
          ...listedWorktrees.map(worktreeItem),
          ...(otherWorktrees.length > 0 ? [
            <MenuItem key="other-worktrees" dense onClick={() => setShowOtherWorktrees(shown => !shown)} aria-expanded={showOtherWorktrees}>
              <ListItemIcon>{showOtherWorktrees ? <ExpandLessRounded fontSize="small" /> : <ExpandMoreRounded fontSize="small" />}</ListItemIcon>
              <ListItemText primary={t('projects.menu.otherWorktrees', { count: otherWorktrees.length })} />
            </MenuItem>,
            ...(showOtherWorktrees ? otherWorktrees.map(worktreeItem) : []),
          ] : []),
          <MenuItem key="new-worktree" dense disabled={!conversationId} onClick={() => setDialog('worktree')}>
            <ListItemIcon><AddRounded fontSize="small" /></ListItemIcon>
            <ListItemText primary={t('projects.menu.newWorktree')} />
          </MenuItem>,

          <ListSubheader key="branch-heading" sx={{ lineHeight: '32px' }}>{t('projects.menu.branch')}</ListSubheader>,
          <MenuItem key="switch-branch" dense disabled={git.changes > 0} onClick={() => setDialog('switch')}>
            <ListItemIcon><SwapHorizRounded fontSize="small" /></ListItemIcon>
            <ListItemText primary={t('projects.menu.switchBranch')} />
          </MenuItem>,
          <MenuItem key="new-branch" dense onClick={() => setDialog('create')}>
            <ListItemIcon><CallSplitRounded fontSize="small" /></ListItemIcon>
            <ListItemText primary={t('projects.menu.newBranch')} />
          </MenuItem>,
          <Typography key="branch-hint" variant="caption" color="text.secondary" component="p" sx={{ px: 2, py: 0.5, maxWidth: 360 }}>
            {git.changes > 0 ? t('projects.menu.dirtyHint') : t('projects.menu.sharedHint')}
          </Typography>,
        ]}

        <Divider />
        <MenuItem dense onClick={() => { void navigator.clipboard?.writeText(chat.path); setAnchorEl(null); }}>
          <ListItemIcon><ContentCopyRounded fontSize="small" /></ListItemIcon>
          <ListItemText primary={t('projects.menu.copyPath')} />
        </MenuItem>
      </Menu>

      <BranchDialog
        open={dialog !== null}
        mode={dialog ?? 'switch'}
        git={git}
        folder={chat.path}
        onClose={() => setDialog(null)}
        onSubmit={async (branch, create) => {
          if (dialog === 'switch') await act('switchBranch', { path: chat.path, branch });
          else if (dialog === 'create') await act('createBranch', { path: chat.path, branch });
          else await act('addWorktree', { path: chat.path, branch, createBranch: create });
          setAnchorEl(null);
        }}
      />

      <Dialog open={Boolean(removeTarget)} onClose={() => setRemoveTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('projects.dialog.removeWorktreeTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ wordBreak: 'break-word' }}>
            {t('projects.dialog.removeWorktreeBody', { path: removeTarget ?? '' })}
          </DialogContentText>
          {removing?.branch && (
            <Typography variant="caption" color="text.secondary">{removing.branch}</Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveTarget(null)}>{t('common.cancel')}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const target = removeTarget;
              setRemoveTarget(null);
              void run('removeWorktree', { path: chat.project, worktree: target }, false);
            }}
          >
            {t('projects.dialog.removeAction')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default ChatProjectChip;
