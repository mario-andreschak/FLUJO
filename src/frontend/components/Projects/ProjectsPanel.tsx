"use client";

import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  AddRounded,
  CallSplitRounded,
  CloseRounded,
  ExpandLessRounded,
  ExpandMoreRounded,
  FolderOutlined,
  FolderSpecialOutlined,
} from '@mui/icons-material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useProjects, type ProjectGitInfo } from '@/frontend/hooks/useProjects';
import { readUiPreference, writeUiPreference } from '@/frontend/hooks/useUiPreference';
import FolderPickerDialog from '@/frontend/components/shared/FolderPickerDialog';

const COLLAPSED_KEY = 'flujo-ui:chat-sidebar:projects-collapsed';

/** Worktrees FLUJO created for the project; other tools' worktrees are not counted. */
const managedWorktrees = (git: ProjectGitInfo) => git.worktrees.filter(worktree => worktree.managed).length;

/**
 * The workspace's projects in the chat sidebar. Selecting one makes it the
 * folder new chats start in; each chat then keeps its own folder, changed from
 * the composer's project chip.
 */
export function ProjectsPanel() {
  const theme = useTheme();
  const { t } = useI18n();
  const { state, act } = useProjects();
  const [collapsed, setCollapsed] = useState(() => readUiPreference(COLLAPSED_KEY, false));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: 'add' | 'remove' | 'activate', body: Record<string, unknown>) => {
    setError(null);
    try {
      await act(action, body);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const toggle = () => {
    setCollapsed(current => {
      writeUiPreference(COLLAPSED_KEY, !current);
      return !current;
    });
  };

  const projects = state?.projects ?? [];
  const removing = projects.find(project => project.path === removeTarget);

  return (
    <Box data-chat-projects-panel sx={{ px: 1.5, pt: 1.2, pb: 0.6 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Button
          size="small"
          color="inherit"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('projects.show') : t('projects.hide')}
          endIcon={collapsed ? <ExpandMoreRounded /> : <ExpandLessRounded />}
          sx={{ flex: 1, justifyContent: 'flex-start', color: 'text.secondary', fontWeight: 760, letterSpacing: '.08em', fontSize: '0.72rem' }}
        >
          {t('projects.title').toUpperCase()}
          {projects.length > 0 && <Box component="span" sx={{ ml: 0.8, fontWeight: 600 }}>{projects.length}</Box>}
        </Button>
        <Tooltip title={t('projects.add')}>
          <IconButton size="small" aria-label={t('projects.add')} onClick={() => setPickerOpen(true)}>
            <AddRounded fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Outside the collapse: adding a project works while the list is hidden. */}
      {error && <Alert severity="error" onClose={() => setError(null)} sx={{ my: 0.8, wordBreak: 'break-word' }}>{error}</Alert>}
      <Collapse in={!collapsed}>
        {state && projects.length === 0 && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ px: 1, pb: 0.8 }}>
            {t('projects.empty')}
          </Typography>
        )}
        <List dense disablePadding sx={{ maxHeight: 220, overflowY: 'auto' }}>
          {projects.map(project => {
            const active = project.path === state?.activeProject;
            const git = project.git;
            return (
              <ListItemButton
                key={project.path}
                selected={active}
                onClick={() => { if (!active) void run('activate', { project: project.path }); }}
                aria-current={active ? 'true' : undefined}
                aria-label={active ? `${project.name} — ${t('projects.newChatsHere')}` : t('projects.makeActive', { project: project.name })}
                title={project.path}
                sx={{
                  borderRadius: 1.5,
                  pr: 0.5,
                  '& .project-remove': { opacity: 0 },
                  '&:hover .project-remove, &:focus-within .project-remove': { opacity: 1 },
                  ...(active ? { bgcolor: `${alpha(theme.palette.primary.main, 0.1)} !important` } : {}),
                }}
              >
                <ListItemIcon sx={{ minWidth: 30 }}>
                  {active
                    ? <FolderSpecialOutlined fontSize="small" color="primary" />
                    : <FolderOutlined fontSize="small" />}
                </ListItemIcon>
                <ListItemText
                  primary={project.name}
                  secondary={git ? (
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, minWidth: 0 }}>
                      <CallSplitRounded sx={{ fontSize: '0.85rem' }} aria-hidden="true" />
                      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {git.branch ?? git.head}
                      </Box>
                      {git.changes > 0 && (
                        <Box component="span" sx={{ color: 'warning.main', fontWeight: 700 }} aria-label={t('projects.changes', { count: git.changes })}>
                          •{git.changes}
                        </Box>
                      )}
                      {managedWorktrees(git) > 0 && (
                        <Box component="span" sx={{ color: 'text.disabled' }}>+{managedWorktrees(git)}</Box>
                      )}
                    </Box>
                  ) : t('projects.notGit')}
                  slotProps={{
                    primary: { noWrap: true, sx: { fontWeight: active ? 750 : 600, fontSize: '0.84rem' } },
                    secondary: { component: 'span', sx: { display: 'block', fontSize: '0.72rem' } },
                  }}
                />
                {active && (
                  <Typography variant="caption" color="primary" sx={{ fontSize: '0.64rem', fontWeight: 700, whiteSpace: 'nowrap', mx: 0.5 }}>
                    {t('projects.newChatsHere')}
                  </Typography>
                )}
                <Tooltip title={t('projects.remove')}>
                  <IconButton
                    className="project-remove"
                    size="small"
                    aria-label={t('projects.remove')}
                    onClick={event => { event.stopPropagation(); setRemoveTarget(project.path); }}
                  >
                    <CloseRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
              </ListItemButton>
            );
          })}
        </List>
      </Collapse>

      <FolderPickerDialog
        open={pickerOpen}
        title={t('projects.chooseFolder')}
        onClose={() => setPickerOpen(false)}
        onSelect={folder => void run('add', { path: folder })}
      />

      <Dialog open={Boolean(removeTarget)} onClose={() => setRemoveTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{removing?.name ?? removeTarget}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ wordBreak: 'break-word' }}>{t('projects.remove')}</DialogContentText>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{removeTarget}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveTarget(null)}>{t('common.cancel')}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const target = removeTarget;
              setRemoveTarget(null);
              void run('remove', { project: target });
            }}
          >
            {t('projects.dialog.removeAction')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default ProjectsPanel;
