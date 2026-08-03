'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloudDoneRoundedIcon from '@mui/icons-material/CloudDoneRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import GitHubIcon from '@mui/icons-material/GitHub';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import type { Model } from '@/shared/types/model';
import type { McpAssistantCandidate, McpAssistantResearchResult } from '@/shared/types/mcp/assistant';
import { modelService } from '@/frontend/services/model';
import { installMcpRecommendation, researchMcpConnection } from '@/frontend/services/mcp/assistant';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface McpAiConnectionPanelProps {
  onInstalled: (serverName: string) => void | Promise<void>;
  onAuthenticate: (serverName: string) => Promise<void>;
  onManual: () => void;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
}

function planText(candidate: McpAssistantCandidate): string {
  if (candidate.plan.transport === 'stdio') {
    return [candidate.plan.command, ...(candidate.plan.args ?? [])].filter(Boolean).join(' ');
  }
  return candidate.plan.serverUrl ?? '';
}

export default function McpAiConnectionPanel({
  onInstalled,
  onAuthenticate,
  onManual,
}: McpAiConnectionPanelProps) {
  const theme = useTheme();
  const { t } = useI18n();
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [query, setQuery] = useState('');
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [result, setResult] = useState<McpAssistantResearchResult | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    modelService.loadModels()
      .then((loaded) => {
        if (cancelled) return;
        setModels(loaded);
        setModelId((current) => loaded.some((model) => model.id === current) ? current : loaded[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled) setError(t('mcp.ai.modelsFailed'));
      });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [t]);

  const selected = useMemo(
    () => result?.candidates.find((candidate) => candidate.id === selectedId) ?? null,
    [result, selectedId],
  );

  const startResearch = async () => {
    if (!query.trim() || !modelId || working) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setWorking(true);
    setError(null);
    setSuccess(null);
    setResult(null);
    setSelectedId('');
    setApproved(false);
    setInputs({});
    setProgress([]);
    try {
      const next = await researchMcpConnection(
        { query: query.trim(), modelId },
        (event) => {
          if (event.type === 'progress') {
            setProgress((current) => [...current.filter((message) => message !== event.message), event.message].slice(-5));
          }
        },
        controller.signal,
      );
      setResult(next);
      setSelectedId(next.recommendedId ?? next.candidates[0]?.id ?? '');
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setWorking(false);
    }
  };

  const selectCandidate = (candidate: McpAssistantCandidate) => {
    setSelectedId(candidate.id);
    setApproved(false);
    setInputs({});
    setError(null);
  };

  const install = async () => {
    if (!selected || !approved || installing) return;
    setInstalling(true);
    setError(null);
    setSuccess(null);
    try {
      const installResult = await installMcpRecommendation({
        registryName: selected.registryName,
        transport: selected.plan.transport,
        approved: true,
        inputs,
        authMode: selected.authMode,
      });
      if (!installResult.installed || !installResult.serverName) {
        throw new Error(installResult.error || t('mcp.ai.installFailed'));
      }
      setSuccess(installResult.alreadyExisted
        ? t('mcp.ai.alreadyConnected', { name: installResult.serverName })
        : t('mcp.ai.connected', { name: installResult.serverName }));
      if (installResult.needsAuthentication) await onAuthenticate(installResult.serverName);
      await onInstalled(installResult.serverName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Stack spacing={2.2}>
      <Box>
        <Typography variant="overline" color="primary.main">{t('mcp.ai.eyebrow')}</Typography>
        <Typography variant="h4">{t('mcp.ai.title')}</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.7, maxWidth: 760 }}>
          {t('mcp.ai.description')}
        </Typography>
      </Box>

      <Paper
        variant="outlined"
        sx={{
          p: { xs: 1.6, sm: 2 },
          borderRadius: 3,
          bgcolor: alpha(theme.palette.primary.main, 0.035),
        }}
      >
        <Stack spacing={1.5}>
          <TextField
            autoFocus
            multiline
            minRows={2}
            maxRows={5}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void startResearch();
              }
            }}
            placeholder={t('mcp.ai.placeholder')}
            label={t('mcp.ai.requestLabel')}
            disabled={working}
            inputProps={{ maxLength: 400 }}
          />
          <Box sx={{ display: 'flex', gap: 1.2, alignItems: 'center', flexWrap: 'wrap' }}>
            <FormControl size="small" sx={{ minWidth: 230, flex: { xs: '1 1 100%', sm: '0 1 300px' } }}>
              <InputLabel id="mcp-ai-model-label">{t('mcp.ai.model')}</InputLabel>
              <Select
                labelId="mcp-ai-model-label"
                label={t('mcp.ai.model')}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                disabled={working || models.length === 0}
              >
                {models.map((model) => (
                  <MenuItem key={model.id} value={model.id}>{model.displayName || model.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button
              variant="contained"
              size="large"
              startIcon={working ? <CircularProgress size={18} color="inherit" /> : <SearchRoundedIcon />}
              onClick={() => void startResearch()}
              disabled={working || !query.trim() || !modelId}
            >
              {working ? t('mcp.ai.researching') : t('mcp.ai.research')}
            </Button>
          </Box>
        </Stack>
      </Paper>

      {working ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }} aria-live="polite">
          <Stack spacing={1.2}>
            {progress.length === 0 ? <Typography color="text.secondary">{t('mcp.ai.starting')}</Typography> : null}
            {progress.map((message, index) => (
              <Box key={message} sx={{ display: 'flex', alignItems: 'center', gap: 1.2, opacity: index === progress.length - 1 ? 1 : 0.6 }}>
                {index === progress.length - 1 ? <CircularProgress size={17} /> : <CheckCircleRoundedIcon color="success" fontSize="small" />}
                <Typography variant="body2">{message}</Typography>
              </Box>
            ))}
          </Stack>
        </Paper>
      ) : null}

      {error ? <Alert severity="error" onClose={() => setError(null)}>{error}</Alert> : null}
      {success ? <Alert severity="success" icon={<CloudDoneRoundedIcon />}>{success}</Alert> : null}

      {result ? (
        <Stack spacing={1.5}>
          <Alert severity={result.candidates.length ? 'info' : 'warning'}>{result.summary}</Alert>

          {result.candidates.length === 0 ? (
            <Button variant="outlined" onClick={onManual}>{t('mcp.ai.openManual')}</Button>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, .9fr) minmax(0, 1.1fr)' }, gap: 1.5 }}>
              <Stack spacing={1}>
                {result.candidates.map((candidate) => {
                  const active = candidate.id === selectedId;
                  return (
                    <Paper
                      key={candidate.id}
                      component="button"
                      type="button"
                      variant="outlined"
                      onClick={() => selectCandidate(candidate)}
                      sx={{
                        p: 1.5,
                        borderRadius: 2.5,
                        textAlign: 'left',
                        font: 'inherit',
                        color: 'text.primary',
                        cursor: 'pointer',
                        bgcolor: active ? alpha(theme.palette.primary.main, 0.09) : 'background.paper',
                        borderColor: active ? 'primary.main' : 'divider',
                        transition: 'border-color 150ms ease, transform 150ms ease',
                        '&:hover': { borderColor: 'primary.main', transform: 'translateY(-1px)' },
                      }}
                    >
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="subtitle1" sx={{ fontWeight: 720 }}>{candidate.title}</Typography>
                          <Typography variant="caption" color="text.secondary">{candidate.registryName}</Typography>
                        </Box>
                        {candidate.recommended ? <Chip size="small" color="primary" label={t('mcp.ai.bestMatch')} /> : null}
                      </Box>
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.8, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {candidate.description}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 0.7, mt: 1.1, flexWrap: 'wrap' }}>
                        <Chip size="small" variant="outlined" label={candidate.plan.transport === 'stdio' ? t('mcp.ai.local') : t('mcp.ai.remote')} />
                        {candidate.githubStars !== undefined ? <Chip size="small" icon={<GitHubIcon />} label={formatCount(candidate.githubStars)} /> : null}
                        {candidate.weeklyDownloads !== undefined ? <Chip size="small" icon={<DownloadRoundedIcon />} label={`${formatCount(candidate.weeklyDownloads)}/wk`} /> : null}
                        {candidate.authMode === 'oauth-dcr' ? <Chip size="small" color="success" label="OAuth 2.1 DCR" /> : null}
                        {candidate.authMode === 'none' && candidate.plan.transport !== 'stdio' ? <Chip size="small" color="success" label={t('mcp.ai.noOAuth')} /> : null}
                      </Box>
                    </Paper>
                  );
                })}
              </Stack>

              {selected ? (
                <Paper variant="outlined" sx={{ p: { xs: 1.6, sm: 2 }, borderRadius: 3 }}>
                  <Stack spacing={1.4}>
                    <Box>
                      <Typography variant="h6">{t('mcp.ai.reviewTitle')}</Typography>
                      <Typography variant="body2" color="text.secondary">{selected.freeNote}</Typography>
                    </Box>
                    <Box component="ul" sx={{ pl: 2.4, my: 0 }}>
                      {selected.reasons.map((reason) => <Typography component="li" variant="body2" key={reason}>{reason}</Typography>)}
                    </Box>
                    {selected.warnings.length ? <Alert severity="warning">{selected.warnings.join(' ')}</Alert> : null}
                    {selected.authHelp ? <Alert severity="info">{selected.authHelp}</Alert> : null}
                    <Divider />
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        {selected.plan.transport === 'stdio' ? t('mcp.ai.commandToRun') : t('mcp.ai.endpointToConnect')}
                      </Typography>
                      <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1.2, borderRadius: 1.5, bgcolor: 'action.hover', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>
                        {planText(selected)}
                      </Box>
                    </Box>
                    {selected.requiredInputs.map((name) => (
                      <TextField
                        key={name}
                        type="password"
                        size="small"
                        label={name}
                        value={inputs[name] ?? ''}
                        onChange={(event) => setInputs((current) => ({ ...current, [name]: event.target.value }))}
                        helperText={t('mcp.ai.secretHelper')}
                        autoComplete="off"
                      />
                    ))}
                    <FormControlLabel
                      control={<Checkbox checked={approved} onChange={(event) => setApproved(event.target.checked)} />}
                      label={selected.plan.transport === 'stdio'
                        ? t('mcp.ai.approveLocal')
                        : t('mcp.ai.approveRemote')}
                    />
                    <Button
                      variant="contained"
                      size="large"
                      startIcon={installing ? <CircularProgress size={18} color="inherit" /> : <AutoAwesomeRoundedIcon />}
                      disabled={installing || !approved || selected.requiredInputs.some((name) => !inputs[name]?.trim())}
                      onClick={() => void install()}
                    >
                      {installing ? t('mcp.ai.installing') : t('mcp.ai.connectBest')}
                    </Button>
                    {selected.repositoryUrl ? (
                      <Link href={selected.repositoryUrl} target="_blank" rel="noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13 }}>
                        {t('mcp.ai.inspectSource')} <OpenInNewRoundedIcon fontSize="inherit" />
                      </Link>
                    ) : null}
                  </Stack>
                </Paper>
              ) : null}
            </Box>
          )}

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {result.sources.map((source) => (
              <Chip
                key={source.id}
                component="a"
                clickable
                href={source.url}
                target="_blank"
                rel="noreferrer"
                size="small"
                color={source.status === 'searched' ? 'default' : 'warning'}
                label={`${source.label}: ${source.detail ?? source.status}`}
              />
            ))}
          </Box>
        </Stack>
      ) : null}
    </Stack>
  );
}
