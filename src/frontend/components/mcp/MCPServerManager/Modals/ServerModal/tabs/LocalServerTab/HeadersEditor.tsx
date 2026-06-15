'use client';

import React from 'react';
import {
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';

interface HeadersEditorProps {
  headers: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
}

// Internal representation keeps an ordered list so editing a key doesn't reorder rows
// or collapse duplicate/empty keys while the user is typing.
interface HeaderRow {
  key: string;
  value: string;
}

const toRows = (headers: Record<string, string>): HeaderRow[] =>
  Object.entries(headers || {}).map(([key, value]) => ({ key, value }));

const toRecord = (rows: HeaderRow[]): Record<string, string> => {
  const record: Record<string, string> = {};
  rows.forEach(({ key, value }) => {
    const trimmedKey = key.trim();
    if (trimmedKey) {
      record[trimmedKey] = value;
    }
  });
  return record;
};

const HeadersEditor: React.FC<HeadersEditorProps> = ({ headers, onChange }) => {
  // Derive rows from props, but keep a local copy so an in-progress empty key isn't lost.
  const [rows, setRows] = React.useState<HeaderRow[]>(() => toRows(headers));

  // Re-sync when the incoming headers change identity (e.g. editing a different server).
  const headersKey = JSON.stringify(headers || {});
  const lastSyncedRef = React.useRef(headersKey);
  React.useEffect(() => {
    if (lastSyncedRef.current !== headersKey && headersKey !== JSON.stringify(toRecord(rows))) {
      setRows(toRows(headers));
      lastSyncedRef.current = headersKey;
    }
  }, [headersKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next: HeaderRow[]) => {
    setRows(next);
    const record = toRecord(next);
    lastSyncedRef.current = JSON.stringify(record);
    onChange(record);
  };

  const handleKeyChange = (index: number, key: string) => {
    commit(rows.map((row, i) => (i === index ? { ...row, key } : row)));
  };

  const handleValueChange = (index: number, value: string) => {
    commit(rows.map((row, i) => (i === index ? { ...row, value } : row)));
  };

  const handleAdd = () => {
    setRows(prev => [...prev, { key: '', value: '' }]);
  };

  const handleRemove = (index: number) => {
    commit(rows.filter((_, i) => i !== index));
  };

  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        Custom HTTP Headers
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Sent on every request to the server (e.g. an <code>Authorization</code> header or any
        custom headers the server requires).
      </Typography>

      <Stack spacing={1.5}>
        {rows.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No custom headers configured.
          </Typography>
        )}

        {rows.map((row, index) => (
          <Stack key={index} direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              label="Header"
              placeholder="Authorization"
              value={row.key}
              onChange={e => handleKeyChange(index, e.target.value)}
              sx={{ flex: '0 0 40%' }}
            />
            <TextField
              size="small"
              label="Value"
              placeholder="Basic dXNlcjpwYXNz"
              value={row.value}
              onChange={e => handleValueChange(index, e.target.value)}
              sx={{ flex: 1 }}
            />
            <Tooltip title="Remove header">
              <IconButton aria-label="remove header" onClick={() => handleRemove(index)} size="small">
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        ))}

        <Box>
          <Button startIcon={<AddIcon />} onClick={handleAdd} size="small" variant="outlined">
            Add Header
          </Button>
        </Box>
      </Stack>
    </Box>
  );
};

export default HeadersEditor;
