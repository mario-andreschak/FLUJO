"use client";

import React from 'react';
import {
  Box,
  FormControl,
  FormControlLabel,
  Switch,
  Typography,
  Alert
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import { ExperimentalSettings } from '@/shared/types/storage/storage';
import { useStorage } from '@/frontend/contexts/StorageContext';

const log = createLogger('frontend/components/Settings/ExperimentalFeaturesSettings');

export default function ExperimentalFeaturesSettings() {
  const { settings, updateSettings } = useStorage();

  // Missing/undefined is treated as disabled — the "experimental" default.
  const experimental: ExperimentalSettings = settings?.experimental ?? { enabled: false };

  const handleEnableChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Experimental features toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        enabled: event.target.checked,
      },
    });
  };

  const handleClaudeSessionResumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Claude session resume toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        claudeSessionResume: event.target.checked,
      },
    });
  };

  const handleAutoUnloadOllamaChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Auto-unload Ollama models toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        autoUnloadOllamaModels: event.target.checked,
      },
    });
  };

  const handleMcpBetaProtocolChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`MCP beta protocol toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        mcpBetaProtocol: event.target.checked,
      },
    });
  };

  return (
    <Box sx={{ p: 2 }}>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.enabled}
              onChange={handleEnableChange}
              name="experimentalEnabled"
            />
          }
          label="Enable Experimental Features"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Experimental features may be incomplete or unstable and can change or be
          removed at any time. When enabled, they become visible in the app — for
          example the <strong>Waves</strong> entry in the top navigation.
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.claudeSessionResume ?? false}
              onChange={handleClaudeSessionResumeChange}
              name="claudeSessionResume"
            />
          }
          label="Reuse Claude session across turns (reduce token usage)"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          For models using the <strong>Claude&nbsp;subscription</strong> (Agent&nbsp;SDK)
          adapter, resume one session per node instead of re-sending the whole
          conversation each turn — so only the newest message is sent. This can
          dramatically cut token usage on long chats. It changes how conversation
          context reaches the model, so it is off by default; if you notice a model
          losing track of earlier context, turn it back off.
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.autoUnloadOllamaModels ?? false}
              onChange={handleAutoUnloadOllamaChange}
              name="autoUnloadOllamaModels"
            />
          }
          label="Auto-unload idle Ollama models"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          When a flow switches between different Ollama models on the same server,
          automatically unload the previous model from VRAM before loading the new
          one. Recommended for GPU-constrained hardware. Note: concurrent Ollama
          requests to the same server are serialised while this is on.
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.mcpBetaProtocol ?? false}
              onChange={handleMcpBetaProtocolChange}
              name="mcpBetaProtocol"
            />
          }
          label="MCP beta protocol (spec 2026-07-28)"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Connect to MCP servers using the <strong>v2 beta SDK</strong> with automatic
          version negotiation: servers that already speak the new stateless
          2026-07-28 protocol are used natively, and every other server
          transparently falls back to the classic handshake — so existing servers
          keep working. The beta SDK&apos;s API may still change before its stable
          release; if a server misbehaves with this on, turn it off and reconnect.
          Websocket servers always use the stable SDK. Changing this rebuilds
          server connections on their next use.
        </Typography>
      </FormControl>

      <Alert severity="info">
        <Typography variant="body2">
          Turning this off again hides experimental features from the navigation. It
          does not delete any data.
        </Typography>
      </Alert>
    </Box>
  );
}
