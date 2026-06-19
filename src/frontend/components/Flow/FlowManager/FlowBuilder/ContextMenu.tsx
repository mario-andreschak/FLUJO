"use client";

import React from 'react';
import { Menu, MenuItem, Divider, ListItemIcon, ListItemText } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import EditIcon from '@mui/icons-material/Edit';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import LayersIcon from '@mui/icons-material/Layers';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';

interface ContextMenuProps {
  open: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  onDelete: () => void;
  onEditProperties?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  canPaste?: boolean;
  nodeId?: string;
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
  nodeId,
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

  const handleZoomToFit = () => {
    console.log('Zoom to fit for', nodeId);
    onClose();
  };

  const handleDisconnect = () => {
    console.log('Disconnect edge', edgeId);
    onClose();
  };

  const handleConnect = () => {
    console.log('Create new connection from', nodeId);
    onClose();
  };

  // Build menu items array
  const menuItems = [];
  
  // Add node-specific menu items
  if (nodeId) {
    menuItems.push(
      <MenuItem key="edit" onClick={handleEditProperties}>
        <ListItemIcon>
          <EditIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Edit Properties</ListItemText>
      </MenuItem>
    );
    if (onCopy) {
      menuItems.push(
        <MenuItem key="copy" onClick={handleCopy}>
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy</ListItemText>
        </MenuItem>
      );
    }
    menuItems.push(<Divider key="node-divider" />);
  }

  // Paste is available wherever the user right-clicks (node, edge, or pane) as
  // long as there is something on the clipboard.
  if (onPaste && canPaste) {
    menuItems.push(
      <MenuItem key="paste" onClick={handlePaste}>
        <ListItemIcon>
          <ContentPasteIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Paste</ListItemText>
      </MenuItem>,
      <Divider key="paste-divider" />
    );
  }

  // Add edge-specific menu items
  if (edgeId) {
    menuItems.push(
      <Divider key="edge-divider" />
    );
  }

  // Add delete menu item (always present)
  menuItems.push(
    <MenuItem key="delete" onClick={handleDelete} sx={{ color: 'error.main' }}>
      <ListItemIcon sx={{ color: 'error.main' }}>
        <DeleteIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Delete</ListItemText>
    </MenuItem>
  );

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
