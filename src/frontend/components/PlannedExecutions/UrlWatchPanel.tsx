"use client";

import React from 'react';
import { Alert, Box, TextField, Typography } from '@mui/material';
import { UrlWatchTriggerConfig } from '@/shared/types/plannedExecution';
import SchedulePanel from './SchedulePanel';

interface UrlWatchPanelProps {
  config: UrlWatchTriggerConfig;
  onChange: (config: UrlWatchTriggerConfig) => void;
}

/**
 * URL-watch trigger editor: fetch a URL on a schedule, run the flow when the
 * content changes (hash comparison on the backend).
 */
const UrlWatchPanel = ({ config, onChange }: UrlWatchPanelProps) => (
  <Box sx={{ mt: 1 }}>
    <TextField
      fullWidth
      label="URL to watch"
      value={config.url}
      onChange={(e) => onChange({ ...config, url: e.target.value })}
      placeholder="https://example.com/status or an API/feed URL"
      margin="normal"
      type="url"
    />

    <Typography variant="subtitle2" sx={{ mt: 1 }}>
      How often to check
    </Typography>
    <SchedulePanel
      verb="Check"
      cron={config.cron}
      timezone={config.timezone}
      onChange={({ cron, timezone }) => onChange({ ...config, cron, timezone })}
    />

    <Alert severity="info" sx={{ mt: 1 }}>
      The first check only takes a snapshot; the flow runs when a later check
      finds different content, and the fetched content is handed to the flow.
      Pages that embed ever-changing bits (timestamps, session tokens) look
      &ldquo;changed&rdquo; on every check — plain APIs, feeds, and raw files
      work best.
    </Alert>
  </Box>
);

export default UrlWatchPanel;
