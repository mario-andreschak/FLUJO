'use client';

import React from 'react';
import { Box, Typography, Switch, Alert } from '@mui/material';
import QuizIcon from '@mui/icons-material/Quiz';
import { MCPElicitationPolicy } from '@/shared/types/mcp';

interface ElicitationManagerProps {
  policy?: MCPElicitationPolicy;
  onChange: (policy: MCPElicitationPolicy) => void;
}

/**
 * Per-server elicitation opt-in toggle. MCP elicitation lets the server ask the
 * user for additional input during a tool call (elicitation/create, MCP spec
 * 2026-07-28). Opt-in: when off, FLUJO declares NO elicitation capability and
 * the server cannot request user input. Unattended/scheduled runs auto-cancel
 * elicitation requests. URL-mode elicitation is not yet supported.
 */
const ElicitationManager: React.FC<ElicitationManagerProps> = ({ policy, onChange }) => {
  const enabled = !!policy?.enabled;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <QuizIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
        <Typography variant="subtitle1">Allow this tool to ask you questions</Typography>
        <Switch
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          size="small"
          sx={{ ml: 1 }}
        />
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Allows this server to request additional information from you mid-tool-call (MCP
        elicitation). Off by default. Only enable for servers you trust. Unattended
        (scheduled) runs auto-cancel elicitation requests. URL-mode is not yet supported.
      </Typography>
      {enabled && (
        <Alert severity="info" sx={{ mt: 0.5 }}>
          When enabled, this server may pause execution and display a form asking for
          your input. You can cancel at any time.
        </Alert>
      )}
    </Box>
  );
};

export default ElicitationManager;
