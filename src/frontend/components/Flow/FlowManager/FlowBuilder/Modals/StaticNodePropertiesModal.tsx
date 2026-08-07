"use client";

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Alert,
  IconButton,
  MenuItem,
  Paper,
  Typography,
  FormControlLabel,
  Switch,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { FlowNode } from '@/frontend/types/flow/flow';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';

interface StaticNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
}

type StaticEntry =
  | { kind: 'message'; role: 'system' | 'user' | 'assistant'; content: string }
  | { kind: 'toolCall'; toolName: string; argumentsJson: string; result: string };

/**
 * Properties modal for the static node (issue #358).
 *
 * A static node injects pre-authored entries into the conversation when
 * execution traverses it: either a plain message with an authored role, or a
 * synthetic assistant tool call plus its matching tool result. Text fields
 * support `${var:NAME}` and `${res:NAME}`, resolved at injection time.
 */
export const StaticNodePropertiesModal = ({ open, node, onClose, onSave }: StaticNodePropertiesModalProps) => {
  const { t } = useI18n();
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: {
          ...node.data.properties,
          entries: Array.isArray(node.data.properties?.entries) ? [...node.data.properties.entries] : [],
        },
      });
    }
  }, [node, open]);

  const entries: StaticEntry[] = (nodeData?.properties?.entries ?? []) as StaticEntry[];

  const setEntries = (next: StaticEntry[]) =>
    setNodeData((prev) => (prev ? { ...prev, properties: { ...prev.properties, entries: next } } : prev));

  const updateEntry = (index: number, patch: Record<string, unknown>) =>
    setEntries(entries.map((entry, i) => (i === index ? ({ ...entry, ...patch } as StaticEntry) : entry)));

  const addMessageEntry = () =>
    setEntries([...entries, { kind: 'message', role: 'user', content: '' }]);

  const addToolCallEntry = () =>
    setEntries([...entries, { kind: 'toolCall', toolName: '', argumentsJson: '{}', result: '' }]);

  const removeEntry = (index: number) => setEntries(entries.filter((_, i) => i !== index));

  const moveEntry = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    setEntries(next);
  };

  const invalidJsonIndexes = entries.reduce<number[]>((acc, entry, index) => {
    if (entry.kind !== 'toolCall') return acc;
    const raw = (entry.argumentsJson ?? '').trim();
    if (!raw) return acc;
    try {
      JSON.parse(raw);
    } catch {
      acc.push(index);
    }
    return acc;
  }, []);

  const handleSave = () => {
    if (!node || !nodeData) return;
    onSave(node.id, { ...nodeData, properties: { ...nodeData.properties, entries } });
  };

  if (!nodeData) return null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogHeaderActions title={t('flows.static.title')} onClose={onClose} />
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <Alert severity="info">{t('flows.static.info')}</Alert>

          <TextField
            label={t('flows.static.name')}
            value={nodeData.properties?.name ?? nodeData.label ?? ''}
            onChange={(e) =>
              setNodeData((prev) =>
                prev
                  ? { ...prev, label: e.target.value, properties: { ...prev.properties, name: e.target.value } }
                  : prev,
              )
            }
            fullWidth
          />

          <FormControlLabel
            control={
              <Switch
                checked={nodeData.properties?.injectOnce === true}
                onChange={(e) =>
                  setNodeData((prev) =>
                    prev ? { ...prev, properties: { ...prev.properties, injectOnce: e.target.checked } } : prev,
                  )
                }
              />
            }
            label={t('flows.static.injectOnce')}
          />

          {entries.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {t('flows.static.empty')}
            </Typography>
          )}

          {entries.map((entry, index) => (
            <Paper key={index} variant="outlined" sx={{ p: 2 }}>
              <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                <Typography variant="subtitle2">
                  {index + 1}.{' '}
                  {entry.kind === 'toolCall' ? t('flows.static.toolCallEntry') : t('flows.static.messageEntry')}
                </Typography>
                <Box>
                  <IconButton
                    size="small"
                    aria-label={t('flows.static.moveUp')}
                    onClick={() => moveEntry(index, -1)}
                    disabled={index === 0}
                  >
                    <ArrowUpwardIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    aria-label={t('flows.static.moveDown')}
                    onClick={() => moveEntry(index, 1)}
                    disabled={index === entries.length - 1}
                  >
                    <ArrowDownwardIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" aria-label={t('flows.static.remove')} onClick={() => removeEntry(index)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>

              {entry.kind === 'message' ? (
                <Box display="flex" flexDirection="column" gap={2}>
                  <TextField
                    select
                    label={t('flows.static.role')}
                    value={entry.role}
                    onChange={(e) => updateEntry(index, { role: e.target.value })}
                    sx={{ maxWidth: 220 }}
                  >
                    <MenuItem value="system">system</MenuItem>
                    <MenuItem value="user">user</MenuItem>
                    <MenuItem value="assistant">assistant</MenuItem>
                  </TextField>
                  <TextField
                    label={t('flows.static.content')}
                    value={entry.content}
                    onChange={(e) => updateEntry(index, { content: e.target.value })}
                    fullWidth
                    multiline
                    rows={3}
                  />
                </Box>
              ) : (
                <Box display="flex" flexDirection="column" gap={2}>
                  <TextField
                    label={t('flows.static.toolName')}
                    value={entry.toolName}
                    onChange={(e) => updateEntry(index, { toolName: e.target.value })}
                    fullWidth
                    error={!entry.toolName?.trim()}
                  />
                  <TextField
                    label={t('flows.static.arguments')}
                    value={entry.argumentsJson}
                    onChange={(e) => updateEntry(index, { argumentsJson: e.target.value })}
                    fullWidth
                    multiline
                    rows={3}
                    error={invalidJsonIndexes.includes(index)}
                    helperText={
                      invalidJsonIndexes.includes(index)
                        ? t('flows.static.invalidJson')
                        : t('flows.static.argumentsHelp')
                    }
                  />
                  <TextField
                    label={t('flows.static.result')}
                    value={entry.result}
                    onChange={(e) => updateEntry(index, { result: e.target.value })}
                    fullWidth
                    multiline
                    rows={3}
                  />
                </Box>
              )}
            </Paper>
          ))}

          <Box display="flex" gap={1}>
            <Button onClick={addMessageEntry} variant="outlined">
              {t('flows.static.addMessage')}
            </Button>
            <Button onClick={addToolCallEntry} variant="outlined">
              {t('flows.static.addToolCall')}
            </Button>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" disabled={invalidJsonIndexes.length > 0}>
          {t('flows.modal.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default StaticNodePropertiesModal;
