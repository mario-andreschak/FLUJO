"use client";

import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import { WebhookTriggerConfig } from '@/shared/types/plannedExecution';

interface WebhookPanelProps {
  config: WebhookTriggerConfig;
  onChange: (config: WebhookTriggerConfig) => void;
  /** The execution id — undefined while creating (URL exists only after save). */
  executionId?: string;
}

/**
 * Webhook trigger editor: shows the call URL + token for saved executions,
 * with copy buttons, token regeneration, and the external-callers opt-in.
 */
const WebhookPanel = ({ config, onChange, executionId }: WebhookPanelProps) => {
  const [copied, setCopied] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = executionId ? `${origin}/api/webhooks/${executionId}` : '';

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      {!executionId && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The webhook URL and its secret token are created when you save.
          Re-open this dialog afterwards to copy them.
        </Alert>
      )}

      {executionId && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
              fullWidth
              label="Webhook URL"
              value={url}
              InputProps={{ readOnly: true }}
              size="small"
            />
            <Tooltip title="Copy URL">
              <IconButton onClick={() => copy('url', url)}>
                {copied === 'url' ? <CheckIcon color="success" /> : <ContentCopyIcon />}
              </IconButton>
            </Tooltip>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
            <TextField
              fullWidth
              label="Secret token"
              value={config.token}
              InputProps={{ readOnly: true }}
              size="small"
              type="password"
            />
            <Tooltip title="Copy token">
              <IconButton onClick={() => copy('token', config.token)}>
                {copied === 'token' ? <CheckIcon color="success" /> : <ContentCopyIcon />}
              </IconButton>
            </Tooltip>
            <Button
              size="small"
              onClick={() => onChange({ ...config, token: '' })}
              sx={{ whiteSpace: 'nowrap' }}
            >
              New token
            </Button>
          </Box>
          {config.token === '' && (
            <Typography variant="caption" color="text.secondary">
              A new token will be generated when you save.
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            Callers send a POST with the token in the <code>X-Flujo-Token</code>{' '}
            header (or <code>?token=…</code>). The request body becomes part of
            the flow&apos;s input — treat it as untrusted data in your prompt.
          </Typography>
        </>
      )}

      <FormControlLabel
        sx={{ mt: 1, display: 'flex' }}
        control={
          <Checkbox
            checked={config.allowExternal === true}
            onChange={(e) => onChange({ ...config, allowExternal: e.target.checked })}
          />
        }
        label="Allow calls from other machines (default: this computer only)"
      />
      {config.allowExternal && (
        <Alert severity="warning">
          FLUJO assumes a single user on this machine. If you expose it beyond
          localhost (port forwarding, tunnels), securing that access is your
          responsibility — anyone with the URL and token can run this flow.
        </Alert>
      )}
    </Box>
  );
};

export default WebhookPanel;
