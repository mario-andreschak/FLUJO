'use client';

import React, { useState } from 'react';
import { Box, Typography, TextField, IconButton, Button, Stack, Tooltip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import FolderPickerDialog from '@/frontend/components/shared/FolderPickerDialog';

interface RootsManagerProps {
  roots: string[];
  onChange: (roots: string[]) => void;
}

/**
 * Per-server "Workspace folders" (MCP roots). Each entry is a folder path or `file://`
 * URI (and may use `${global:VAR}` for automation). Advisory scoping the server can read
 * via roots/list — NOT a hard sandbox. The roots capability is always declared; leaving
 * this empty means the server's own root dir (rootPath) is its default workspace folder.
 */
const RootsManager: React.FC<RootsManagerProps> = ({ roots, onChange }) => {
  const list = Array.isArray(roots) ? roots : [];
  // Which row's backend folder picker is open (null = closed).
  const [pickIndex, setPickIndex] = useState<number | null>(null);

  const update = (index: number, value: string) => {
    onChange(list.map((r, i) => (i === index ? value : r)));
  };
  const add = () => onChange([...list, '']);
  const remove = (index: number) => onChange(list.filter((_, i) => i !== index));

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <FolderIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
        <Typography variant="subtitle1">Workspace folders</Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Limit which folders this server may work in. Advisory only — the server is told these
        paths via MCP roots; it is not a hard sandbox. Leave empty to default to the
        server&apos;s own root dir. Supports <code>{'${global:VAR}'}</code>.
      </Typography>

      <Stack spacing={1}>
        {list.map((root, index) => (
          <Box key={index} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
              size="small"
              fullWidth
              placeholder="/path/to/folder or file:///path"
              value={root}
              onChange={(e) => update(index, e.target.value)}
            />
            <Tooltip title="Browse folders (on the FLUJO machine)">
              <IconButton size="small" onClick={() => setPickIndex(index)} aria-label="browse for folder">
                <FolderOpenIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remove">
              <IconButton size="small" onClick={() => remove(index)} aria-label="remove workspace folder">
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        ))}
      </Stack>

      <Button size="small" startIcon={<AddIcon />} onClick={add} sx={{ mt: 1 }}>
        Add folder
      </Button>

      <FolderPickerDialog
        open={pickIndex !== null}
        title="Choose a workspace folder"
        initialPath={pickIndex !== null ? list[pickIndex] || undefined : undefined}
        onClose={() => setPickIndex(null)}
        onSelect={(path) => {
          if (pickIndex !== null) {
            update(pickIndex, path);
          }
        }}
      />
    </Box>
  );
};

export default RootsManager;
