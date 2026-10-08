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
import { useI18n } from '@/frontend/contexts/I18nContext';

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
  const { t } = useI18n();
  const formId = React.useId();
  return (
    <Stack spacing={3}>
      <Box>
        <Typography component="label" htmlFor={`${formId}-name`} variant="subtitle2" gutterBottom sx={{ display: 'block' }}>
          {t('mcp.local.form.name')}
        </Typography>
        <TextField
          id={`${formId}-name`}
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
        <Typography component="label" htmlFor={`${formId}-root`} variant="subtitle2" gutterBottom sx={{ display: 'block' }}>
          {t('mcp.local.form.rootPath')}
        </Typography>
        <TextField
          id={`${formId}-root`}
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
                  aria-label={t('mcp.local.form.selectRoot')}
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
