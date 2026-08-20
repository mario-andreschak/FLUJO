"use client";

import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  AddRounded,
  CheckRounded,
  DeleteOutlineRounded,
  DriveFileRenameOutlineRounded,
  ExpandMoreRounded,
  LockOutlined,
  WorkspacesOutlined,
  FolderOutlined,
} from '@mui/icons-material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useWorkspaces } from '@/frontend/hooks/useWorkspaces';
import {
  DEFAULT_WORKSPACE,
  isValidWorkspaceName,
  workspaceColor,
} from '@/frontend/utils/workspaceSelection';
import FolderPickerDialog from '@/frontend/components/shared/FolderPickerDialog';

interface WorkspaceTabsProps {
  /** 'bar' = desktop navbar button, 'drawer' = compact/mobile full-width button. */
  variant?: 'bar' | 'drawer';
  /** Called after a switch, so the navigation drawer can close itself. */
  onSwitch?: () => void;
}

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; workspace: string; isDefault: boolean }
  | null;

/** Workspace selector and lifecycle controls for the shared app navigation. */
export function WorkspaceTabs({ variant = 'bar', onSwitch }: WorkspaceTabsProps) {
  const theme = useTheme();
  const { t } = useI18n();
  const { workspaces, selected, select, create, edit, remove, loading } = useWorkspaces();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const active = workspaces.find(workspace => workspace.name === selected);
  const activeColor = active?.color || workspaceColor(selected);
  const menuOpen = Boolean(anchorEl);
  const isDrawer = variant === 'drawer';

  const handleSelect = (workspace: string) => {
    setAnchorEl(null);
    select(workspace);
    onSwitch?.();
  };

  const openCreate = () => {
    setAnchorEl(null);
    setEditor({ mode: 'create' });
    setName('');
    setNameTouched(false);
    setOperationError(null);
  };

  const openEdit = (workspace: string, isDefault: boolean, workspaceRoots: string[]) => {
    setAnchorEl(null);
    setEditor({ mode: 'edit', workspace, isDefault });
    setName(workspace);
    setRoots(workspaceRoots);
    setNameTouched(false);
    setOperationError(null);
  };

  const closeEditor = () => {
    if (saving) return;
    setEditor(null);
    setOperationError(null);
  };

  const normalizedName = name.trim();
  const invalidName = nameTouched && !isValidWorkspaceName(normalizedName);
  const duplicateName = nameTouched && workspaces.some(workspace =>
    workspace.name.toLowerCase() === normalizedName.toLowerCase()
    && (editor?.mode !== 'edit' || workspace.name !== editor.workspace),
  );

  const handleEditorSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setNameTouched(true);
    setOperationError(null);
    if (!editor || !isValidWorkspaceName(normalizedName)) return;
    if (workspaces.some(workspace =>
      workspace.name.toLowerCase() === normalizedName.toLowerCase()
      && (editor.mode !== 'edit' || workspace.name !== editor.workspace)
    )) return;

    setSaving(true);
    try {
      if (editor.mode === 'create') {
        await create(normalizedName);
      } else {
        await edit(editor.workspace, normalizedName, roots);
      }
      setEditor(null);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleteTarget === DEFAULT_WORKSPACE) return;
    setSaving(true);
    setOperationError(null);
    try {
      await remove(deleteTarget);
      setDeleteTarget(null);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Box sx={isDrawer ? { px: 1.4, pb: 1.2 } : undefined}>
        <Button
          variant="outlined"
          size="small"
          aria-label={t('nav.workspaceSelected', { workspace: selected })}
          aria-controls={menuOpen ? 'workspace-menu' : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen ? 'true' : undefined}
          data-app-workspace-menu-button
          onClick={event => setAnchorEl(event.currentTarget)}
          startIcon={
            <Box sx={{ position: 'relative', display: 'inline-flex' }}>
              <WorkspacesOutlined sx={{ fontSize: '1.05rem !important' }} />
              <Box
                aria-hidden="true"
                sx={{
                  position: 'absolute',
                  right: -2,
                  bottom: -1,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  bgcolor: activeColor,
                  boxShadow: `0 0 6px ${alpha(activeColor, 0.9)}`,
                }}
              />
            </Box>
          }
          endIcon={loading
            ? <CircularProgress size={12} color="inherit" />
            : <ExpandMoreRounded sx={{ fontSize: '1rem !important' }} />}
          sx={{
            minHeight: 34,
            width: isDrawer ? '100%' : 'auto',
            justifyContent: isDrawer ? 'space-between' : 'center',
            borderRadius: 2.2,
            borderColor: alpha(activeColor, 0.4),
            color: 'text.primary',
            px: 1.2,
            textTransform: 'none',
            fontSize: '0.78rem',
            fontWeight: 750,
            bgcolor: alpha(activeColor, 0.06),
            '&:hover': {
              borderColor: alpha(activeColor, 0.72),
              bgcolor: alpha(activeColor, 0.12),
            },
          }}
        >
          {t('nav.workspaces')}
        </Button>
      </Box>

      <Menu
        id="workspace-menu"
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: isDrawer ? 'left' : 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: isDrawer ? 'left' : 'right' }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.8,
              width: 320,
              maxWidth: 'calc(100vw - 24px)',
              borderRadius: 2.5,
              border: `1px solid ${theme.palette.divider}`,
              boxShadow: theme.shadows[12],
            },
          },
        }}
      >
        <Box sx={{ px: 2, pt: 1.2, pb: 0.8 }}>
          <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 800 }}>
            {t('nav.workspaces')}
          </Typography>
        </Box>
        {workspaces.map(workspace => {
          const color = workspace.color || workspaceColor(workspace.name);
          const isActive = workspace.name === selected;
          const isDefault = workspace.isDefault || workspace.name === DEFAULT_WORKSPACE;
          return (
            <MenuItem
              key={workspace.name}
              selected={isActive}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => handleSelect(workspace.name)}
              sx={{ minHeight: 54, gap: 0.8, pr: 1 }}
            >
              <ListItemIcon sx={{ minWidth: '28px !important' }}>
                <Box
                  aria-hidden="true"
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    bgcolor: color,
                    boxShadow: `0 0 8px ${alpha(color, 0.7)}`,
                  }}
                />
              </ListItemIcon>
              <ListItemText
                primary={workspace.name}
                secondary={isActive
                  ? t('nav.workspaces.current')
                  : isDefault
                    ? t('nav.workspaces.default')
                    : undefined}
                primaryTypographyProps={{ fontSize: '0.84rem', fontWeight: isActive ? 750 : 600 }}
                secondaryTypographyProps={{ fontSize: '0.7rem' }}
              />
              {isActive && <CheckRounded color="primary" fontSize="small" aria-hidden="true" />}
              <Stack direction="row" spacing={0.1}>
                  <Tooltip title={t('nav.workspaces.edit', { workspace: workspace.name })}>
                    <IconButton
                      size="small"
                      aria-label={t('nav.workspaces.edit', { workspace: workspace.name })}
                      onClick={event => {
                        event.stopPropagation();
                        openEdit(workspace.name, isDefault, workspace.roots ?? []);
                      }}
                    >
                      <DriveFileRenameOutlineRounded fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {!isDefault && <Tooltip title={t('nav.workspaces.delete', { workspace: workspace.name })}>
                    <IconButton
                      size="small"
                      color="error"
                      aria-label={t('nav.workspaces.delete', { workspace: workspace.name })}
                      onClick={event => {
                        event.stopPropagation();
                        setAnchorEl(null);
                        setOperationError(null);
                        setDeleteTarget(workspace.name);
                      }}
                    >
                      <DeleteOutlineRounded fontSize="small" />
                    </IconButton>
                  </Tooltip>}
                  {isDefault && <LockOutlined fontSize="small" color="disabled" sx={{ m: 0.75 }} />}
                </Stack>
            </MenuItem>
          );
        })}
        <Divider sx={{ my: 0.6 }} />
        <MenuItem onClick={openCreate} sx={{ minHeight: 44, color: 'primary.main', fontWeight: 750 }}>
          <ListItemIcon sx={{ color: 'inherit' }}>
            <AddRounded fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('nav.workspaces.create')} />
        </MenuItem>
      </Menu>

      <Dialog open={Boolean(editor)} onClose={closeEditor} fullWidth maxWidth={editor?.mode === 'edit' ? 'sm' : 'xs'}>
        <Box component="form" onSubmit={handleEditorSubmit}>
          <DialogTitle>
            {editor?.mode === 'edit'
              ? t('nav.workspaces.editTitle')
              : t('nav.workspaces.createTitle')}
          </DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              fullWidth
              value={name}
              label={t('nav.workspaces.name')}
              error={invalidName || duplicateName}
              helperText={duplicateName
                ? t('nav.workspaces.nameExists')
                : t('nav.workspaces.nameHelp')}
              disabled={saving}
              slotProps={{ input: { readOnly: editor?.mode === 'edit' && editor.isDefault } }}
              inputProps={{ maxLength: 64 }}
              onBlur={() => setNameTouched(true)}
              onChange={event => {
                setName(event.target.value);
                setOperationError(null);
              }}
              sx={{ mt: 1 }}
            />
            {editor?.mode === 'edit' && (
              <Box sx={{ mt: 2.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 750 }}>
                  {t('nav.workspaces.folders')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('nav.workspaces.foldersHelp')}
                </Typography>
                <Stack sx={{ mt: 1.2, border: 1, borderColor: 'divider', borderRadius: 1.5 }} divider={<Divider flexItem />}>
                  {roots.map((root, index) => (
                    <Box key={root} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1 }}>
                      <FolderOutlined fontSize="small" color="action" />
                      <Typography variant="body2" noWrap title={root} sx={{ flex: 1 }}>{root}</Typography>
                      {index === 0 && <Chip size="small" variant="outlined" label={t('nav.workspaces.primaryFolder')} />}
                      <Tooltip title={t('nav.workspaces.removeFolder')}>
                        <IconButton size="small" aria-label={t('nav.workspaces.removeFolder')} onClick={() => setRoots(current => current.filter((_, i) => i !== index))}>
                          <DeleteOutlineRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ))}
                  <Button startIcon={<AddRounded />} onClick={() => setFolderPickerOpen(true)} sx={{ alignSelf: 'flex-start', m: 0.5 }}>
                    {t('nav.workspaces.addFolder')}
                  </Button>
                </Stack>
              </Box>
            )}
            {operationError && <Alert severity="error" sx={{ mt: 2 }}>{operationError}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button onClick={closeEditor} disabled={saving}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={saving}>
              {saving && <CircularProgress size={16} color="inherit" sx={{ mr: 1 }} />}
              {editor?.mode === 'edit'
                ? t('nav.workspaces.saveAction')
                : t('nav.workspaces.createAction')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <FolderPickerDialog
        open={folderPickerOpen}
        title={t('nav.workspaces.chooseFolder')}
        onClose={() => setFolderPickerOpen(false)}
        onSelect={folder => setRoots(current => current.includes(folder) ? current : [...current, folder])}
      />

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => {
          if (!saving) {
            setDeleteTarget(null);
            setOperationError(null);
          }
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t('nav.workspaces.deleteTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('nav.workspaces.deleteBody', { workspace: deleteTarget ?? '' })}
          </DialogContentText>
          {operationError && <Alert severity="error" sx={{ mt: 2 }}>{operationError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={saving}
            onClick={() => {
              setDeleteTarget(null);
              setOperationError(null);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button color="error" variant="contained" disabled={saving} onClick={handleDelete}>
            {saving && <CircularProgress size={16} color="inherit" sx={{ mr: 1 }} />}
            {t('nav.workspaces.deleteAction')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default WorkspaceTabs;
