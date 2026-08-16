'use client';

import React from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Modal,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import LinkIcon from '@mui/icons-material/Link';
import CancelIcon from '@mui/icons-material/Cancel';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { isSecretHeaderKey } from '@/utils/shared/common';
import { MASKED_API_KEY, MASKED_STRING } from '@/shared/types/constants';
import { MCPHeaderValue } from '@/shared/types/mcp/mcp';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Trans from '@/frontend/components/shared/Trans';

interface HeadersEditorProps {
  headers: Record<string, MCPHeaderValue>;
  onChange: (headers: Record<string, MCPHeaderValue>) => void;
}

// Internal representation keeps an ordered list so editing a key doesn't reorder rows
// or collapse duplicate/empty keys while the user is typing.
interface HeaderRow {
  key: string;
  value: string;
  isSecret: boolean;
  isBound?: boolean;
  boundTo?: string;
  // A secret value the backend delivered masked (never the real value). Sent back as-is
  // means "keep the stored secret"; the moment the user types, it becomes a real edit.
  isMasked?: boolean;
  // Warn the user they must re-enter a value after turning OFF the secret flag (the masked
  // placeholder can't be demoted to a plaintext value).
  showWarning?: boolean;
}

const GLOBAL_BINDING_RE = /^\$\{global:([A-Za-z0-9_.-]+)\}$/;

const toRows = (headers: Record<string, MCPHeaderValue>): HeaderRow[] =>
  Object.entries(headers || {}).map(([key, raw]) => {
    const isObj = raw !== null && typeof raw === 'object' && 'value' in raw;
    const value = isObj ? (raw as { value: string }).value ?? '' : (raw as string) ?? '';
    const isSecret = isObj ? !!(raw as { metadata?: { isSecret?: boolean } }).metadata?.isSecret : isSecretHeaderKey(key);

    const bindingMatch = value.match(GLOBAL_BINDING_RE);
    if (bindingMatch) {
      return { key, value, isSecret, isBound: true, boundTo: bindingMatch[1] };
    }
    const isMasked = value === MASKED_API_KEY || value === MASKED_STRING;
    return { key, value, isSecret, isMasked };
  });

const toRecord = (rows: HeaderRow[]): Record<string, MCPHeaderValue> => {
  const record: Record<string, MCPHeaderValue> = {};
  rows.forEach(({ key, value, isSecret, isBound, boundTo }) => {
    const trimmedKey = key.trim();
    if (!trimmedKey) return;
    if (isBound && boundTo) {
      record[trimmedKey] = { value: '${global:' + boundTo + '}', metadata: { isSecret: !!isSecret } };
    } else {
      record[trimmedKey] = { value, metadata: { isSecret: !!isSecret } };
    }
  });
  return record;
};

const HeadersEditor: React.FC<HeadersEditorProps> = ({ headers, onChange }) => {
  const { globalEnvVars } = useStorage();
  const { t } = useI18n();
  // Derive rows from props, but keep a local copy so an in-progress empty key isn't lost.
  const [rows, setRows] = React.useState<HeaderRow[]>(() => toRows(headers));
  const [showBindModal, setShowBindModal] = React.useState(false);
  const [selectedRowIndex, setSelectedRowIndex] = React.useState<number | null>(null);

  // Re-sync when the incoming headers change identity (e.g. editing a different server).
  const headersKey = JSON.stringify(headers || {});
  const lastSyncedRef = React.useRef(headersKey);
  React.useEffect(() => {
    if (lastSyncedRef.current !== headersKey && headersKey !== JSON.stringify(toRecord(rows))) {
      setRows(toRows(headers));
      lastSyncedRef.current = headersKey;
    }
  }, [headersKey]);

  const commit = (next: HeaderRow[]) => {
    setRows(next);
    const record = toRecord(next);
    // Record what we emit so the round-trip back through props doesn't trigger a re-sync.
    lastSyncedRef.current = JSON.stringify(record);
    onChange(record);
  };

  const handleKeyChange = (index: number, key: string) => {
    commit(rows.map((row, i) => {
      if (i !== index) return row;
      // Auto-flag as secret when the key looks secret (Authorization, *token*, *key*, …),
      // reusing the env-var logic. Never auto-UNset: a user who unchecked it stays unchecked.
      const isSecret = row.isSecret || isSecretHeaderKey(key);
      return { ...row, key, isSecret };
    }));
  };

  const handleValueChange = (index: number, value: string) => {
    const bindingMatch = value.match(GLOBAL_BINDING_RE);
    commit(rows.map((row, i) =>
      i === index
        ? {
            ...row,
            value,
            isBound: !!bindingMatch,
            boundTo: bindingMatch?.[1],
            isMasked: false,
            showWarning: false,
          }
        : row
    ));
  };

  const handleSecretToggle = (index: number, isSecret: boolean) => {
    commit(rows.map((row, i) => {
      if (i !== index) return row;
      // Turning a masked secret into a normal header: the real value was never shown, so it
      // must be cleared and re-entered.
      if (row.isSecret && !isSecret && row.isMasked) {
        return { ...row, isSecret, value: '', isMasked: false, showWarning: true };
      }
      return { ...row, isSecret };
    }));
  };

  const handleAdd = () => {
    setRows(prev => [...prev, { key: '', value: '', isSecret: false }]);
  };

  const handleRemove = (index: number) => {
    commit(rows.filter((_, i) => i !== index));
  };

  const handleUnbind = (index: number) => {
    commit(rows.map((row, i) =>
      i === index ? { ...row, isBound: false, boundTo: undefined, value: '' } : row
    ));
  };

  const handleSelectGlobalVar = (globalVarKey: string) => {
    if (selectedRowIndex === null) return;
    commit(rows.map((row, i) =>
      i === selectedRowIndex
        ? { ...row, isBound: true, boundTo: globalVarKey, value: '${global:' + globalVarKey + '}', isMasked: false, showWarning: false }
        : row
    ));
    setShowBindModal(false);
    setSelectedRowIndex(null);
  };

  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        {t('mcp.local.headers.title')}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        <Trans
          message="mcp.local.headers.help"
          values={{
            authorization: <code>Authorization</code>,
            secret: <strong>{t('mcp.local.headers.secretTerm')}</strong>,
          }}
        />
      </Typography>

      <Stack spacing={1.5}>
        {rows.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t('mcp.local.headers.empty')}
          </Typography>
        )}

        {rows.map((row, index) => (
          // Phones get one field per line plus a wrapping action row; the fixed
          // 32% key column and the single-line layout only apply from `sm` up (#394).
          <Stack
            key={index}
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            alignItems={{ xs: 'stretch', sm: 'flex-start' }}
            sx={{ minWidth: 0 }}
          >
            <TextField
              size="small"
              label={t('mcp.local.headers.header')}
              placeholder="Authorization"
              value={row.key}
              onChange={e => handleKeyChange(index, e.target.value)}
              fullWidth
              sx={{ flex: { xs: '1 1 auto', sm: '0 0 32%' }, minWidth: 0 }}
            />
            <TextField
              size="small"
              label={t('mcp.local.headers.value')}
              type={row.isSecret && !row.isBound ? 'password' : 'text'}
              placeholder={row.showWarning ? t('mcp.local.headers.reenter') : (row.isMasked ? t('mcp.local.headers.unchanged') : 'Basic dXNlcjpwYXNz')}
              value={row.isBound ? '' : row.value}
              onChange={e => handleValueChange(index, e.target.value)}
              error={row.showWarning}
              helperText={
                row.showWarning
                  ? t('mcp.local.headers.reenterHelp')
                  : (row.isMasked ? t('mcp.local.headers.storedSecret') : '')
              }
              InputProps={{
                readOnly: row.isBound,
                endAdornment: row.isBound ? (
                  <InputAdornment position="end">
                    <Chip
                      size="small"
                      label={t('mcp.local.headers.bound', { variable: row.boundTo ?? '' })}
                      color="primary"
                      variant="outlined"
                      onDelete={() => handleUnbind(index)}
                      deleteIcon={<CancelIcon fontSize="small" />}
                      sx={{ maxWidth: '100%' }}
                    />
                  </InputAdornment>
                ) : null
              }}
              fullWidth
              sx={{ flex: 1, minWidth: 0 }}
            />
            {/* Secret / bind / delete stay together and wrap instead of squeezing
                the key and value fields on narrow screens. */}
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 0.5,
                flexShrink: 0,
                mt: { xs: 0, sm: 0.25 }
              }}
            >
              <FormControlLabel
                control={
                  <Checkbox
                    checked={row.isSecret}
                    onChange={e => handleSecretToggle(index, e.target.checked)}
                    size="small"
                  />
                }
                label={t('mcp.local.headers.secret')}
                sx={{ mr: 0 }}
              />
              {!row.isBound && (
                <Tooltip title={t('mcp.local.headers.bind')}>
                  <IconButton
                    aria-label={t('mcp.local.headers.bind')}
                    size="small"
                    color="primary"
                    onClick={() => { setSelectedRowIndex(index); setShowBindModal(true); }}
                  >
                    <LinkIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title={t('mcp.local.headers.remove')}>
                <IconButton aria-label={t('mcp.local.headers.remove')} onClick={() => handleRemove(index)} size="small">
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Stack>
        ))}

        <Box>
          <Button startIcon={<AddIcon />} onClick={handleAdd} size="small" variant="outlined">
            {t('mcp.local.headers.add')}
          </Button>
        </Box>
      </Stack>

      {/* Bind Modal */}
      <Modal
        open={showBindModal}
        onClose={() => { setShowBindModal(false); setSelectedRowIndex(null); }}
      >
        <Box sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 400,
          maxWidth: '90%',
          bgcolor: 'background.paper',
          boxShadow: 24,
          p: 4,
          borderRadius: 2
        }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            {t('mcp.local.headers.bindTitle')}
          </Typography>
          {Object.keys(globalEnvVars).length === 0 ? (
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              {t('mcp.local.headers.noGlobals')}
            </Typography>
          ) : (
            <Box sx={{ maxHeight: 300, overflow: 'auto', mb: 2 }}>
              {Object.keys(globalEnvVars).map(key => (
                <Button
                  key={key}
                  fullWidth
                  variant="text"
                  onClick={() => handleSelectGlobalVar(key)}
                  sx={{ justifyContent: 'flex-start', textAlign: 'left', mb: 1, p: 1, borderRadius: 1 }}
                >
                  {/* Values are secrets — never display them here, just the key. */}
                  <Typography variant="body2">{key}</Typography>
                </Button>
              ))}
            </Box>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="outlined" onClick={() => { setShowBindModal(false); setSelectedRowIndex(null); }}>
              {t('mcp.local.cancel')}
            </Button>
          </Box>
        </Box>
      </Modal>
    </Box>
  );
};

export default HeadersEditor;
