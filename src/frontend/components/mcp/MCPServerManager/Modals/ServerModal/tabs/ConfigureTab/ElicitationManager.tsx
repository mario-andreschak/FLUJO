'use client';

import React from 'react';
import { Box, Typography, Switch, Alert } from '@mui/material';
import QuizIcon from '@mui/icons-material/Quiz';
import { MCPElicitationPolicy } from '@/shared/types/mcp';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface ElicitationManagerProps {
  /** The effective switch, read with mcpElicitationEnabled(). */
  enabled: boolean;
  onChange: (policy: MCPElicitationPolicy) => void;
}

/**
 * Per-server elicitation switch. MCP elicitation lets the server ask the user
 * for a form answer or to open a link during a tool call (elicitation/create,
 * MCP spec 2026-07-28). On unless the user turns it off; when off, FLUJO
 * declares no form mode and the server cannot ask for input.
 */
const ElicitationManager: React.FC<ElicitationManagerProps> = ({ enabled, onChange }) => {
  const { t } = useI18n();

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <QuizIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
        <Typography variant="subtitle1">{t('mcp.local.elicitation.title')}</Typography>
        <Switch
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          size="small"
          sx={{ ml: 1 }}
        />
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {t('mcp.local.elicitation.help')}
      </Typography>
      {enabled && (
        <Alert severity="info" sx={{ mt: 0.5 }}>
          {t('mcp.local.elicitation.enabled')}
        </Alert>
      )}
    </Box>
  );
};

export default ElicitationManager;
