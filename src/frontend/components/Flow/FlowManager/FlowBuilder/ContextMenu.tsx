"use client";

import React from 'react';
import { Menu, MenuItem, Divider, ListItemIcon, ListItemText } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import EditIcon from '@mui/icons-material/Edit';

interface ContextMenuProps {
  open: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  onDelete: () => void;
  onEditProperties?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  canPaste?: boolean;
  /** False when the target cannot be copied (e.g. a Start node). */
  canCopy?: boolean;
  nodeId?: string;
  /** True when the menu targets the current multi-selection. */
  selection?: boolean;
  edgeId?: string;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  open,
  position,
  onClose,
  onDelete,
  onEditProperties,
  onCopy,
  onPaste,
  canPaste,
  canCopy,
  nodeId,
  selection,
  edgeId,
}) => {
  const handleDelete = () => {
    onDelete();
    onClose();
  };

  const handleCopy = () => {
    if (onCopy) onCopy();
    onClose();
  };

  const handlePaste = () => {
    if (onPaste) onPaste();
    onClose();
  };

  const handleEditProperties = () => {
    if (onEditProperties) {
      onEditProperties();
    }
    onClose();
  };

  // Build menu items array
  const menuItems = [];

  // Add node-specific menu items (a single node, not a multi-selection)
  if (nodeId && !selection) {
    menuItems.push(
      <MenuItem key="edit" onClick={handleEditProperties}>
        <ListItemIcon>
          <EditIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Edit Properties</ListItemText>
      </MenuItem>
    );
  }

  // Copy applies to a copyable node or the current selection
  if (onCopy && (nodeId || selection)) {
    menuItems.push(
      <MenuItem key="copy" onClick={handleCopy} disabled={!canCopy}>
        <ListItemIcon>
          <ContentCopyIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Copy</ListItemText>
      </MenuItem>
    );
  }

  // Paste is available wherever the user right-clicks (node, edge, selection,
  // or pane); disabled when the clipboard is empty.
  if (onPaste) {
    menuItems.push(
      <MenuItem key="paste" onClick={handlePaste} disabled={!canPaste}>
        <ListItemIcon>
          <ContentPasteIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Paste</ListItemText>
      </MenuItem>
    );
  }

  // Delete applies to a node, an edge, or the selection — not the empty pane.
  if (nodeId || edgeId || selection) {
    menuItems.push(
      <Divider key="delete-divider" />,
      <MenuItem key="delete" onClick={handleDelete} sx={{ color: 'error.main' }}>
        <ListItemIcon sx={{ color: 'error.main' }}>
          <DeleteIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Delete</ListItemText>
      </MenuItem>
    );
  }

  return (
    <Menu
      open={open}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={
        position.y !== null && position.x !== null
          ? { top: position.y, left: position.x }
          : undefined
      }
    >
      {menuItems}
    </Menu>
  );
};

export default ContextMenu;
