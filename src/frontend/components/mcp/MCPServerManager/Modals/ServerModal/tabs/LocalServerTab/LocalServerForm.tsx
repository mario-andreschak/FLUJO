'use client';

import React from 'react';
import FolderIcon from '@mui/icons-material/Folder';
import {
  Box,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography
} from '@mui/material';

interface LocalServerFormProps {
  name: string;
  setName: (name: string) => void;
  rootPath: string;
  setRootPath: (rootPath: string) => void;
  onRootPathSelect: () => void;
}

const LocalServerForm: React.FC<LocalServerFormProps> = ({
  name,
  setName,
  rootPath,
  setRootPath,
  onRootPathSelect
}) => {
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Server Name
        </Typography>
        <TextField
          fullWidth
          size="small"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="my-mcp-server"
          variant="outlined"
          required
        />
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          MCP Server Root Path
        </Typography>
        <TextField
          fullWidth
          size="small"
          value={rootPath}
          onChange={e => setRootPath(e.target.value)}
          placeholder="/path/to/server/root"
          variant="outlined"
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  onClick={onRootPathSelect}
                  edge="end"
                >
                  <FolderIcon />
                </IconButton>
              </InputAdornment>
            ),
          }}
        />
      </Box>
    </Stack>
  );
};

export default LocalServerForm;
