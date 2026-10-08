'use client';

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded';
import BuildCircleRoundedIcon from '@mui/icons-material/BuildCircleRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import type { Model } from '@/shared/types/model';
import type { McpTroubleshootContext, McpTroubleshootPatch, McpTroubleshootResult } from '@/shared/types/mcp/assistant';
import { modelService } from '@/frontend/services/model';
import { troubleshootMcpConnection } from '@/frontend/services/mcp/assistant';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface McpInstallTroubleshooterProps {
  context: Omit<McpTroubleshootContext, 'modelId'>;
  onApplyPatch: (patch: McpTroubleshootPatch) => void;
}

function patchLines(patch: McpTroubleshootPatch): string[] {
  return [
    patch.command ? `command → ${patch.command}` : null,
    patch.args ? `args → ${patch.args.join(' ')}` : null,
    patch.serverUrl ? `URL → ${patch.serverUrl}` : null,
    patch.rootPath ? `root → ${patch.rootPath}` : null,
    patch.installCommand ? `install → ${patch.installCommand}` : null,
    patch.buildCommand ? `build → ${patch.buildCommand}` : null,
    patch.addEnvNames?.length ? `add empty env fields → ${patch.addEnvNames.join(', ')}` : null,
    patch.addHeaderNames?.length ? `add empty header fields → ${patch.addHeaderNames.join(', ')}` : null,
  ].filter((line): line is string => Boolean(line));
}

export default function McpInstallTroubleshooter({ context, onApplyPatch }: McpInstallTroubleshooterProps) {
  const { t } = useI18n();
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<McpTroubleshootResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    modelService.loadModels().then((loaded) => {
      if (cancelled) return;
      setModels(loaded);
      setModelId((current) => loaded.some((model) => model.id === current) ? current : loaded[0]?.id ?? '');
    }).catch(() => {
      if (!cancelled) setError(t('mcp.ai.modelsFailed'));
    });
    return () => { cancelled = true; };
  }, [t]);

  const diagnose = async () => {
    if (!modelId || working) return;
    setWorking(true);
    setError(null);
    setResult(null);
    setApplied(false);
    try {
      setResult(await troubleshootMcpConnection({ ...context, modelId }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const lines = result?.patch ? patchLines(result.patch) : [];

  return (
    <Paper variant="outlined" sx={{ mt: 2, p: 2, borderRadius: 2.5 }}>
      <Stack spacing={1.4}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <BuildCircleRoundedIcon color="primary" />
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{t('mcp.troubleshoot.title')}</Typography>
            <Typography variant="body2" color="text.secondary">{t('mcp.troubleshoot.description')}</Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel id="mcp-troubleshoot-model-label">{t('mcp.ai.model')}</InputLabel>
            <Select
              labelId="mcp-troubleshoot-model-label"
              label={t('mcp.ai.model')}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={working || models.length === 0}
            >
              {models.map((model) => <MenuItem key={model.id} value={model.id}>{model.displayName || model.name}</MenuItem>)}
            </Select>
          </FormControl>
          <Button
            variant="outlined"
            startIcon={working ? <CircularProgress size={17} /> : <AutoFixHighRoundedIcon />}
            onClick={() => void diagnose()}
            disabled={working || !modelId}
          >
            {working ? t('mcp.troubleshoot.diagnosing') : t('mcp.troubleshoot.askAi')}
          </Button>
          <Chip size="small" variant="outlined" label={t('mcp.troubleshoot.privacy')} />
        </Box>
        {error ? <Alert severity="error">{error}</Alert> : null}
        {result ? (
          <Stack spacing={1.2}>
            <Alert severity="info">{result.diagnosis}</Alert>
            {result.steps.length ? (
              <Box component="ol" sx={{ my: 0, pl: 2.7 }}>
                {result.steps.map((step) => <Typography component="li" variant="body2" key={step} sx={{ mb: 0.4 }}>{step}</Typography>)}
              </Box>
            ) : null}
            {result.authHelp ? <Alert severity="warning">{result.authHelp}</Alert> : null}
            {result.researchedUrls?.length ? (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {result.researchedUrls.map((url) => (
                  <Link key={url} href={url} target="_blank" rel="noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, fontSize: 12 }}>
                    {t('mcp.troubleshoot.researchedSource')} <OpenInNewRoundedIcon fontSize="inherit" />
                  </Link>
                ))}
              </Box>
            ) : null}
            {result.patch && lines.length ? (
              <Paper variant="outlined" sx={{ p: 1.4, bgcolor: 'action.hover' }}>
                <Typography variant="subtitle2">{t('mcp.troubleshoot.proposedChanges')}</Typography>
                <Box component="ul" sx={{ my: 0.8, pl: 2.4 }}>
                  {lines.map((line) => <Typography component="li" variant="body2" sx={{ fontFamily: 'monospace' }} key={line}>{line}</Typography>)}
                </Box>
                <Button
                  size="small"
                  variant="contained"
                  disabled={applied}
                  onClick={() => {
                    onApplyPatch(result.patch!);
                    setApplied(true);
                  }}
                >
                  {applied ? t('mcp.troubleshoot.applied') : t('mcp.troubleshoot.apply')}
                </Button>
              </Paper>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}
