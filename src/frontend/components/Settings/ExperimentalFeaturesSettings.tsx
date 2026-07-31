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

  const handleFlowBasedGeneratorChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Flow-based generator toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        flowBasedGenerator: event.target.checked,
      },
    });
  };

  const handleProtectedPathsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Protected paths toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        protectedPathsEnabled: event.target.checked,
      },
    });
  };

  const handleSnapshotsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Filesystem snapshots toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        snapshotsEnabled: event.target.checked,
      },
    });
  };

  const handleShowModelsWithoutToolsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Show models without tool capabilities toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        showModelsWithoutToolCapabilities: event.target.checked,
      },
    });
  };

  const handleVisualCompactionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Visual context compaction toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        visualCompactionEnabled: event.target.checked,
      },
    });
  };

  const handleVisualToolResultsOnlyChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Visual compaction tool-results-only toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        visualCompactionToolResultsOnly: event.target.checked,
      },
    });
  };

  const handleVisualEvaluationModeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Visual compaction evaluation mode toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        visualCompactionEvaluationMode: event.target.checked,
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
              checked={experimental.visualCompactionEnabled ?? false}
              onChange={handleVisualCompactionChange}
              name="visualCompactionEnabled"
            />
          }
          label="Visual context compaction"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Experimental and off by default. For explicitly vision-capable models,
          FLUJO may replace a complete old, bulky context range with dense PNG
          pages only when provider-aware estimates show a context reduction. Exact
          source remains in run data; secrets, uncertain capability, and failures
          always keep the safe text route.
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2, ml: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.visualCompactionToolResultsOnly !== false}
              onChange={handleVisualToolResultsOnlyChange}
              name="visualCompactionToolResultsOnly"
              disabled={!experimental.visualCompactionEnabled}
            />
          }
          label="Only archive old tool results"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Safe default: only complete oversized tool-call/result groups are
          eligible. Turn this off to let the router consider other old bulky text;
          recent turns and incomplete tool pairs are never archived.
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2, ml: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.visualCompactionEvaluationMode ?? false}
              onChange={handleVisualEvaluationModeChange}
              name="visualCompactionEvaluationMode"
              disabled={!experimental.visualCompactionEnabled}
            />
          }
          label="Evaluate visual routing without sending images"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Records comparable raw, text, summary, and image estimates in the
          debugger while preserving the current text wire. Use this for live
          evaluation before enabling automatic image selection.
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
              checked={experimental.showModelsWithoutToolCapabilities ?? false}
              onChange={handleShowModelsWithoutToolsChange}
              name="showModelsWithoutToolCapabilities"
            />
          }
          label="Show Models without tool capabilities"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Provider model lists hide models explicitly known not to support tool
          calls. Turn this on to reveal image generators and other non-tool
          models. Models with unknown capabilities remain visible either way.
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

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.flowBasedGenerator ?? false}
              onChange={handleFlowBasedGeneratorChange}
              name="flowBasedGenerator"
              disabled={!experimental.enabled}
            />
          }
          label="Flow-based Flow Generator"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Run Generate Flow through an editable, multi-stage FLUJO Flow. Its
          architect inventories real building blocks and authors the complete
          specification; its compiler validates, repairs, and returns an unsaved
          draft. The proven generator plus AI-Improve remains the default when
          this is off.
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.protectedPathsEnabled ?? false}
              onChange={handleProtectedPathsChange}
              name="protectedPathsEnabled"
            />
          }
          label="Protect sensitive home-directory paths"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Add a defense-in-depth deny list to installed <strong>filesystem</strong>
          {' '}and <strong>bash</strong> MCP packages. When enabled, sensitive locations
          such as Documents, Desktop, Downloads, and credential directories remain
          blocked even when they are included in a configured root. This is off by
          default, so configured roots normally grant access to their full contents.
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.snapshotsEnabled ?? true}
              onChange={handleSnapshotsChange}
              name="snapshotsEnabled"
            />
          }
          label="Enable filesystem snapshots"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Capture restorable snapshots around installed <strong>filesystem</strong>
          {' '}and <strong>bash</strong> package writes. Turning this off prevents new
          captures and snapshot-based revert. An operator can always disable
          snapshots with <strong>FLUJO_SNAPSHOTS=0</strong>.
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
