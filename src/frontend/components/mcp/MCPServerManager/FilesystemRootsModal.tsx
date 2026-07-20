'use client';

/**
 * Roots configuration modal for the built-in `filesystem` MCP server (issue #170).
 *
 * Lets the user view/add/remove the confinement roots the server is scoped to.
 * The roots are persisted as a tiny per-server override (never as the synthetic
 * config) via the standard PUT /api/mcp/servers/{name} path with `{ roots }`.
 * Note: when the operator has set the FLUJO_FS_ROOTS environment variable it
 * remains a HARD CEILING — roots configured here can only narrow within it.
 */
import React, { useEffect, useState } from 'react';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/frontend/services/mcp';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { Box, List, ListItem, Typography, Alert } from '@mui/material';

const log = createLogger('frontend/components/mcp/MCPServerManager/FilesystemRootsModal');

interface FilesystemRootsModalProps {
  open: boolean;
  serverName: string;
  initialRoots?: string[];
  onClose: () => void;
  onSaved?: (roots: string[]) => void;
}

const FilesystemRootsModal: React.FC<FilesystemRootsModalProps> = ({ open, serverName, initialRoots, onClose, onSaved }) => {
  const [roots, setRoots] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRoots(Array.isArray(initialRoots) ? [...initialRoots] : []);
      setDraft('');
      setError(null);
    }
  }, [open, initialRoots]);

  const addDraft = () => {
    const value = draft.trim();
    if (!value) return;
    if (roots.includes(value)) {
      setError('That root is already in the list.');
      return;
    }
    setRoots((prev) => [...prev, value]);
    setDraft('');
    setError(null);
  };

  const removeRoot = (idx: number) => {
    setRoots((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await mcpService.updateServerConfig(serverName, { roots });
      if (result && 'error' in result && result.error) {
        setError(typeof result.error === 'string' ? result.error : 'Failed to save roots.');
        return;
      }
      log.info(`Saved ${roots.length} filesystem root(s) for ${serverName}`);
      onSaved?.(roots);
      onClose();
    } catch (err) {
      log.warn('Failed to save filesystem roots', err);
      setError(err instanceof Error ? err.message : 'Failed to save roots.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth onClick={(e) => e.stopPropagation()}>
      <DialogTitle>Configure filesystem roots</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Confine the built-in <b>filesystem</b> server to these folders. Leave the list empty for
          full host access (unless the <code>FLUJO_FS_ROOTS</code> environment variable is set, which
          always acts as a hard ceiling).
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
          <TextField
            fullWidth
            size="small"
            label="Add a root folder (absolute path)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addDraft();
              }
            }}
            placeholder="e.g. C:\\Users\\me\\project or /home/me/project"
          />
          <Button variant="outlined" startIcon={<AddIcon />} onClick={addDraft} disabled={!draft.trim()}>
            Add
          </Button>
        </Box>

        {roots.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No roots configured — the server has full host access.
          </Typography>
        ) : (
          <List dense>
            {roots.map((root, idx) => (
              <ListItem
                key={`${root}-${idx}`}
                secondaryAction={
                  <IconButton edge="end" aria-label="remove root" onClick={() => removeRoot(idx)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                }
              >
                <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                  {root}
                </Typography>
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default FilesystemRootsModal;
