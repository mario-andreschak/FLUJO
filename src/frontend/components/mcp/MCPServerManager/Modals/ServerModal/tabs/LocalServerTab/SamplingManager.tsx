'use client';

import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Switch,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  Alert,
} from '@mui/material';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { MCPSamplingPolicy } from '@/shared/types/mcp';
import { Model } from '@/shared/types/model';
import { modelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/.../SamplingManager');

interface SamplingManagerProps {
  policy?: MCPSamplingPolicy;
  onChange: (policy: MCPSamplingPolicy) => void;
}

/**
 * Per-server sampling trust policy ("Let this tool use your AI"). MCP sampling lets the
 * server ask FLUJO to run LLM calls on its behalf; since there's no human to approve each
 * call in a headless flow, the user grants standing permission here by picking which model
 * answers and a rate cap. Opt-in — off means FLUJO won't advertise sampling at all.
 */
const SamplingManager: React.FC<SamplingManagerProps> = ({ policy, onChange }) => {
  const [models, setModels] = useState<Model[]>([]);
  const enabled = !!policy?.enabled;

  useEffect(() => {
    let cancelled = false;
    modelService
      .loadModels()
      .then((list) => {
        if (!cancelled) setModels(Array.isArray(list) ? list : []);
      })
      .catch((e) => log.warn('Failed to load models for sampling policy', e));
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (changes: Partial<MCPSamplingPolicy>) => {
    onChange({ enabled, modelId: policy?.modelId, maxCallsPerMinute: policy?.maxCallsPerMinute, ...changes });
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <SmartToyIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
        <Typography variant="subtitle1">Let this tool use your AI</Typography>
        <Switch
          checked={enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          size="small"
          sx={{ ml: 1 }}
        />
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Allows this server to ask FLUJO to run AI calls on its behalf (MCP sampling). Off by
        default. When on, the server can spend the selected model&apos;s API budget — only
        enable it for servers you trust.
      </Typography>

      {enabled && (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <FormControl size="small" sx={{ minWidth: 260 }} error={!policy?.modelId}>
            <InputLabel id="sampling-model-label">Model</InputLabel>
            <Select
              labelId="sampling-model-label"
              label="Model"
              value={models.some((m) => m.id === policy?.modelId) ? policy?.modelId : ''}
              onChange={(e) => patch({ modelId: e.target.value || undefined })}
            >
              {models.length === 0 && (
                <MenuItem value="" disabled>
                  No models configured
                </MenuItem>
              )}
              {models.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  {m.displayName || m.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            size="small"
            type="number"
            label="Max calls / minute"
            sx={{ width: 160 }}
            value={policy?.maxCallsPerMinute ?? ''}
            placeholder="10"
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              patch({ maxCallsPerMinute: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
            helperText="Default 10"
          />

          {!policy?.modelId && (
            <Alert severity="warning" sx={{ width: '100%' }}>
              Pick a model — sampling requests will be rejected until one is selected.
            </Alert>
          )}
        </Box>
      )}
    </Box>
  );
};

export default SamplingManager;
