"use client";

import React, { useState } from 'react';
import {
  Box,
  Typography,
  Alert,
} from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import EnvEditor from '../mcp/MCPEnvManager/EnvEditor';
import { MASKED_STRING } from '@/shared/types/constants';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useTimeout } from '@/frontend/hooks/timing';

const SUCCESS_MESSAGE_MS = 3000;

export default function GlobalEnvSettings() {
  const { globalEnvVars, setGlobalEnvVars, deleteGlobalEnvVar } = useStorage();
  const { t } = useI18n();
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  useTimeout(() => setMessage(null), message?.type === 'success' ? SUCCESS_MESSAGE_MS : null, message);

  const handleSave = async (vars: Record<string, { value: string, metadata: { isSecret: boolean } } | string>) => {
    try {
      // Filter out secret variables that have the masked value
      const filteredVars = Object.fromEntries(
        Object.entries(vars).filter(([key, value]) => {
          return typeof value === 'string' || !value.metadata.isSecret || value.value !== MASKED_STRING;
        })
      );

      await setGlobalEnvVars(filteredVars);
      setMessage({
        type: 'success',
        text: t('settings.globalEnv.success'),
      });
    } catch {
      setMessage({
        type: 'error',
        text: t('settings.globalEnv.failed'),
      });
    }
  };

  return (
    <Box sx={{ width: '100%' }}>   
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('settings.globalEnv.description')}
      </Typography>

      {message && (
        <Alert severity={message.type} sx={{ mb: 2 }}>
          {message.text}
        </Alert>
      )}

      <EnvEditor 
        serverName={t('settings.globalEnv.serverName')}
        initialEnv={globalEnvVars} 
        onSave={handleSave}
        onDelete={deleteGlobalEnvVar}
      />
    </Box>
  );
}
