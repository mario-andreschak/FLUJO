'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  type McpLoadedSkill,
  type McpServerSkillsResult,
  type McpSkillEntry,
} from '@/shared/types/mcp';
import { mcpService } from '@/frontend/services/mcp';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface Props {
  serverName: string;
}

function manifestDigest(entry: McpSkillEntry): string | undefined {
  if (entry.resources === 'dynamic') return undefined;
  return entry.resources.find((resource) => resource.uri === entry.uri)?.digest;
}

/**
 * Explicit, session-memory-only Skills loader. Nothing is inserted into trusted
 * Persona instructions and discovery alone never activates remote content.
 */
const MCPSkillsManager: React.FC<Props> = ({ serverName }) => {
  const { t } = useI18n();
  const [result, setResult] = useState<McpServerSkillsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingUri, setLoadingUri] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Map<string, McpLoadedSkill>>(new Map());

  const refresh = useCallback(async () => {
    setLoading(true);
    mcpService.clearSkillsCache(serverName);
    try {
      const first = await mcpService.listServerSkills(serverName);
      const skills = [...first.skills];
      let cursor = first.nextCursor;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor) && skills.length <= 1024) {
        seen.add(cursor);
        const page = await mcpService.listServerSkills(serverName, cursor);
        if (page.error) {
          setResult({ ...first, skills, error: page.error });
          return;
        }
        skills.push(...page.skills);
        cursor = page.nextCursor;
      }
      const next = { ...first, skills, nextCursor: cursor };
      setResult(next);
      setLoaded((current) => {
        const valid = new Map<string, McpLoadedSkill>();
        for (const entry of skills) {
          const prior = current.get(entry.uri);
          if (prior && prior.manifest.digest === manifestDigest(entry)) {
            valid.set(entry.uri, prior);
          }
        }
        return valid;
      });
    } finally {
      setLoading(false);
    }
  }, [serverName]);

  useEffect(() => {
    setResult(null);
    setLoaded(new Map());
    void refresh();
  }, [refresh]);

  const load = async (entry: McpSkillEntry) => {
    if (entry.resources === 'dynamic') return;
    setLoadingUri(entry.uri);
    try {
      const response = await mcpService.loadServerSkill(serverName, entry.uri);
      if (!response.success || !response.data) {
        setResult((current) =>
          current ? { ...current, error: response.error || t('mcp.skills.loadFailed') } : current,
        );
        return;
      }
      setLoaded((current) => new Map(current).set(entry.uri, response.data!));
      window.dispatchEvent(
        new CustomEvent('flujo:mcp-skill-loaded', {
          detail: response.data,
        }),
      );
    } finally {
      setLoadingUri(null);
    }
  };

  if (loading && !result) {
    return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>;
  }

  if (!result) return null;
  if (result.availability === 'disabled') {
    return <Alert severity="info">{t('mcp.skills.disabled')}</Alert>;
  }
  if (result.availability === 'unsupported') {
    return <Alert severity="info">{t('mcp.skills.unsupported')}</Alert>;
  }

  return (
    <Stack spacing={2}>
      <Alert severity="warning">{t('mcp.skills.warning')}</Alert>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {t('mcp.skills.server', { server: serverName })}
        </Typography>
        <Button
          size="small"
          startIcon={<RefreshIcon />}
          onClick={() => void refresh()}
          disabled={loading}
        >
          {t('mcp.skills.refresh')}
        </Button>
      </Box>
      {result.error && <Alert severity="error">{result.error}</Alert>}
      {!result.error && result.skills.length === 0 && (
        <Alert severity="info">{t('mcp.skills.empty')}</Alert>
      )}
      {result.skills.map((entry) => {
        const digest = manifestDigest(entry);
        const verified = loaded.get(entry.uri);
        return (
          <Card variant="outlined" key={entry.uri}>
            <CardContent>
              <Stack spacing={1.25}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography variant="h6">{entry.frontmatter.name}</Typography>
                  <Chip
                    size="small"
                    color={verified ? 'success' : 'default'}
                    label={verified ? t('mcp.skills.verified') : t('mcp.skills.unverified')}
                  />
                  {entry.resources === 'dynamic' && (
                    <Chip size="small" color="warning" label={t('mcp.skills.dynamic')} />
                  )}
                </Box>
                <Typography>{entry.frontmatter.description}</Typography>
                <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                  {entry.uri}
                </Typography>
                <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                  {digest || t('mcp.skills.noDigest')}
                </Typography>
                {verified && (
                  <Alert severity="success">
                    {t('mcp.skills.loaded')} {verified.manifest.digest}
                  </Alert>
                )}
                <Box>
                  <Button
                    variant="contained"
                    size="small"
                    disabled={entry.resources === 'dynamic' || loadingUri === entry.uri}
                    onClick={() => void load(entry)}
                  >
                    {loadingUri === entry.uri
                      ? t('mcp.skills.loading')
                      : t('mcp.skills.load')}
                  </Button>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        );
      })}
    </Stack>
  );
};

export default MCPSkillsManager;
