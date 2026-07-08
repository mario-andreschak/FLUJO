"use client";

import React, { useState } from 'react';
import {
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import FolderOffOutlinedIcon from '@mui/icons-material/FolderOffOutlined';

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
      <Menu anchorEl={anchorEl} open={open} onClose={onClose}>
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
          <ListItemText primary="New folder…" />
        </MenuItem>
        {currentFolder && (
          <MenuItem onClick={() => handleAssign(undefined)}>
            <ListItemIcon>
              <FolderOffOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Remove from folder" />
          </MenuItem>
        )}
      </Menu>

      <Dialog open={newFolderOpen} onClose={() => setNewFolderOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New folder</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Folder name"
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
          <Button onClick={() => setNewFolderOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!newFolderName.trim()} onClick={confirmNewFolder}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default FolderAssignMenu;
