'use client';

import React from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import HomeWorkOutlinedIcon from '@mui/icons-material/HomeWorkOutlined';
import type { MCPRuntimeHomeMode } from '@/shared/types/mcp';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface RuntimeHomeManagerProps {
  mode?: MCPRuntimeHomeMode;
  onChange: (mode: MCPRuntimeHomeMode) => void;
}

/** Per-server override for stdio HOME/config/cache inheritance. */
const RuntimeHomeManager: React.FC<RuntimeHomeManagerProps> = ({ mode, onChange }) => {
  const { t } = useI18n();
  const value = mode ?? 'inherit';

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <HomeWorkOutlinedIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
        <Typography variant="subtitle1">{t('mcp.local.runtimeHome.title')}</Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        {t('mcp.local.runtimeHome.help')}
      </Typography>
      <FormControl size="small" sx={{ minWidth: 280 }}>
        <InputLabel id="mcp-runtime-home-mode-label">
          {t('mcp.local.runtimeHome.mode')}
        </InputLabel>
        <Select
          labelId="mcp-runtime-home-mode-label"
          label={t('mcp.local.runtimeHome.mode')}
          value={value}
          onChange={(event) => onChange(event.target.value as MCPRuntimeHomeMode)}
        >
          <MenuItem value="inherit">{t('mcp.local.runtimeHome.inherit')}</MenuItem>
          <MenuItem value="isolated">{t('mcp.local.runtimeHome.isolated')}</MenuItem>
          <MenuItem value="host">{t('mcp.local.runtimeHome.host')}</MenuItem>
        </Select>
      </FormControl>
    </Box>
  );
};

export default RuntimeHomeManager;
