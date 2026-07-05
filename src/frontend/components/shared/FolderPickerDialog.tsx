"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import HomeIcon from '@mui/icons-material/Home';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/shared/FolderPickerDialog');

interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface BrowseResponse {
  path: string;
  parent: string | null;
  home: string;
  sep: string;
  drives: string[];
  entries: BrowseEntry[];
  error?: string;
}

export interface FolderPickerDialogProps {
  open: boolean;
  title?: string;
  /** Allow picking files too; folders are always navigable and selectable. */
  selectFiles?: boolean;
  /** Where to start browsing; defaults to the backend's home directory. */
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

/**
 * Browse the BACKEND filesystem (via /api/browse) and pick a folder or file.
 * FLUJO's backend may run on a different machine than the browser, and picked
 * paths are consumed by the backend (file-watch triggers, MCP server args,
 * workspace folders) — so this deliberately does NOT use the browser's own
 * file dialogs, which can neither browse the backend nor return real paths.
 */
const FolderPickerDialog = ({
  open,
  title = 'Choose a folder',
  selectFiles = false,
  initialPath,
  onClose,
  onSelect,
}: FolderPickerDialogProps) => {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = target ? `?path=${encodeURIComponent(target)}` : '';
      const response = await fetch(`/api/browse${query}`);
      const body = (await response.json()) as BrowseResponse;
      if (!response.ok || body.error) {
        setError(body.error || `HTTP ${response.status}`);
        return;
      }
      setData(body);
      setPathInput(body.path);
    } catch (err) {
      log.warn('Browse failed', err);
      setError('Could not reach the backend to browse folders.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load(initialPath || undefined);
    } else {
      setData(null);
      setError(null);
    }
  }, [open, initialPath, load]);

  const pick = (value: string) => {
    onSelect(value);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Tooltip title="Up one folder">
            <span>
              <IconButton
                size="small"
                disabled={!data?.parent || loading}
                onClick={() => data?.parent && void load(data.parent)}
              >
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Home folder">
            <span>
              <IconButton size="small" disabled={loading} onClick={() => void load()}>
                <HomeIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <TextField
            fullWidth
            size="small"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void load(pathInput);
              }
            }}
            placeholder="Type a path and press Enter"
          />
        </Box>

        {data && data.drives.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {data.drives.map(drive => (
              <Chip
                key={drive}
                label={drive}
                size="small"
                variant={data.path.toLowerCase().startsWith(drive.toLowerCase()) ? 'filled' : 'outlined'}
                onClick={() => void load(drive)}
              />
            ))}
          </Box>
        )}

        {error && <Alert severity="error">{error}</Alert>}

        <Box sx={{ minHeight: 240, maxHeight: '45vh', overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
          {loading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={24} />
            </Box>
          )}
          {!loading && data && data.entries.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              This folder is empty.
            </Typography>
          )}
          {!loading && (
            <List dense disablePadding>
              {data?.entries.map(entry => (
                <ListItemButton
                  key={entry.path}
                  disabled={!entry.isDirectory && !selectFiles}
                  onClick={() => (entry.isDirectory ? void load(entry.path) : pick(entry.path))}
                >
                  <ListItemIcon sx={{ minWidth: 34 }}>
                    {entry.isDirectory ? (
                      <FolderIcon fontSize="small" color="primary" />
                    ) : (
                      <InsertDriveFileOutlinedIcon fontSize="small" />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={entry.name}
                    primaryTypographyProps={{ noWrap: true }}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!data || loading}
          onClick={() => data && pick(data.path)}
        >
          Select this folder
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default FolderPickerDialog;
