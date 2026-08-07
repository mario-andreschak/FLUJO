"use client";

import React, { useState } from 'react';
import {
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Dialog,
  DialogContent,
  DialogActions,
  TextField,
  Button,
} from '@mui/material';
import DialogHeaderActions from './DialogHeaderActions';
import CheckIcon from '@mui/icons-material/Check';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import FolderOffOutlinedIcon from '@mui/icons-material/FolderOffOutlined';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface FolderAssignMenuProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  /** The item's current folder, if any. */
  currentFolder?: string;
  /** Existing folders on this surface, to reuse. */
  folders: string[];
  onClose: () => void;
  /** Assign to a folder, or pass `undefined` to remove the item from its folder. */
  onAssign: (folder: string | undefined) => void;
}

/**
 * A small "Move to folder…" menu shared by the Models / MCP / Flow card actions
 * (#71). Lists existing folders, offers a "New folder…" prompt, and a "Remove
 * from folder" action. Self-contained: it owns the new-folder dialog state.
 */
const FolderAssignMenu = ({
  anchorEl,
  open,
  currentFolder,
  folders,
  onClose,
  onAssign,
}: FolderAssignMenuProps) => {
  const { t } = useI18n();
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const handleAssign = (folder: string | undefined) => {
    onAssign(folder);
    onClose();
  };

  const openNewFolder = () => {
    setNewFolderName('');
    setNewFolderOpen(true);
  };

  const confirmNewFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderOpen(false);
    handleAssign(name);
  };

  return (
    <>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={onClose}
        // Menu is portalled, but React events still bubble through the card that
        // rendered it. Keep folder actions from also activating that card.
        onClick={(event) => event.stopPropagation()}
      >
        {folders.length > 0 && folders.map((folder) => (
          <MenuItem key={folder} onClick={() => handleAssign(folder)} selected={folder === currentFolder}>
            <ListItemIcon>
              {folder === currentFolder ? (
                <CheckIcon fontSize="small" />
              ) : (
                <FolderOutlinedIcon fontSize="small" />
              )}
            </ListItemIcon>
            <ListItemText primary={folder} />
          </MenuItem>
        ))}
        {folders.length > 0 && <Divider />}
        <MenuItem onClick={openNewFolder}>
          <ListItemIcon>
            <CreateNewFolderOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('folderAssign.newAction')} />
        </MenuItem>
        {currentFolder && (
          <MenuItem onClick={() => handleAssign(undefined)}>
            <ListItemIcon>
              <FolderOffOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t('folderAssign.remove')} />
          </MenuItem>
        )}
      </Menu>

      <Dialog
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        maxWidth="xs"
        fullWidth
        // The dialog is opened from the portalled menu and remains a descendant
        // of the owning card in React's event tree.
        onClick={(event) => event.stopPropagation()}
      >
        <DialogHeaderActions title={t('folderAssign.newTitle')} onClose={() => setNewFolderOpen(false)} />
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label={t('folderAssign.name')}
            fullWidth
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                confirmNewFolder();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewFolderOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" disabled={!newFolderName.trim()} onClick={confirmNewFolder}>
            {t('common.create')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default FolderAssignMenu;
