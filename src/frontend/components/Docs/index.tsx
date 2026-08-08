"use client";

import React, { useMemo, useState } from 'react';
import {
  Box,
  Chip,
  Container,
  Divider,
  InputAdornment,
  Link as MuiLink,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import MenuBookRoundedIcon from '@mui/icons-material/MenuBookRounded';
import { API_GROUPS, ApiEndpoint, HttpMethod } from './apiReference';
import PageHeader from '@/frontend/components/shared/PageHeader';
import { useI18n } from '@/frontend/contexts/I18nContext';
import StickySearchBar from '@/frontend/components/shared/StickySearchBar';
import { useAutoFocusSearch } from '@/frontend/hooks/useAutoFocusSearch';

const GROUP_MESSAGE_KEYS = {
  openai: { name: 'docs.group.openai.name', description: 'docs.group.openai.description' },
  conversations: { name: 'docs.group.conversations.name', description: 'docs.group.conversations.description' },
  model: { name: 'docs.group.model.name', description: 'docs.group.model.description' },
  flow: { name: 'docs.group.flow.name', description: 'docs.group.flow.description' },
  'planned-executions': { name: 'docs.group.planned.name', description: 'docs.group.planned.description' },
  mcp: { name: 'docs.group.mcp.name', description: 'docs.group.mcp.description' },
  'mcp-proxy': { name: 'docs.group.proxy.name', description: 'docs.group.proxy.description' },
  'mcp-flows': { name: 'docs.group.mcpFlows.name', description: 'docs.group.mcpFlows.description' },
  oauth: { name: 'docs.group.oauth.name', description: 'docs.group.oauth.description' },
  env: { name: 'docs.group.env.name', description: 'docs.group.env.description' },
  storage: { name: 'docs.group.storage.name', description: 'docs.group.storage.description' },
  system: { name: 'docs.group.system.name', description: 'docs.group.system.description' },
} as const;

const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: '#2e7d32',
  POST: '#1565c0',
  PUT: '#ed6c02',
  PATCH: '#9c27b0',
  DELETE: '#c62828',
  OPTIONS: '#616161',
};

function MethodChip({ method }: { method: HttpMethod }) {
  return (
    <Chip
      label={method}
      size="small"
      sx={{
        bgcolor: METHOD_COLORS[method],
        color: '#fff',
        fontWeight: 700,
        fontFamily: 'var(--font-geist-mono), monospace',
        fontSize: '0.7rem',
        height: 22,
      }}
    />
  );
}

function EndpointCard({ endpoint }: { endpoint: ApiEndpoint }) {
  const { t } = useI18n();
  const paramsLabel = endpoint.paramsLabel === 'Body'
    ? t('docs.label.body')
    : endpoint.paramsLabel === 'Query'
      ? t('docs.label.query')
      : endpoint.paramsLabel === 'Form data'
        ? t('docs.label.form')
        : t('docs.parameters');
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
        <MethodChip method={endpoint.method} />
        {endpoint.alsoMethods?.map((m) => <MethodChip key={m} method={m} />)}
        <Typography
          component="code"
          sx={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.9rem', wordBreak: 'break-all' }}
        >
          {endpoint.path}
        </Typography>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: endpoint.params?.length ? 1.5 : 0 }}>
        {endpoint.summary}
      </Typography>

      {endpoint.params && endpoint.params.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, textTransform: 'uppercase', color: 'text.secondary' }}>
            {paramsLabel}
          </Typography>
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
            {endpoint.params.map((p) => (
              <Box component="li" key={p.name} sx={{ mb: 0.25 }}>
                <Typography variant="body2" component="span">
                  <Box
                    component="code"
                    sx={{ fontFamily: 'var(--font-geist-mono), monospace', fontWeight: 600 }}
                  >
                    {p.name}
                  </Box>
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {' '}
                    {p.type}
                    {p.required ? ` · ${t('docs.required')}` : ''} — {p.description}
                  </Box>
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {endpoint.response && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          <Box component="span" sx={{ fontWeight: 600 }}>
            {t('docs.response')}{' '}
          </Box>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            {endpoint.response}
          </Box>
        </Typography>
      )}

      {endpoint.notes?.map((note, i) => (
        <Typography key={i} variant="caption" sx={{ display: 'block', mt: 1, color: 'warning.main' }}>
          ⚠ {note}
        </Typography>
      ))}

      {endpoint.details && (
        <Box
          component="pre"
          sx={{
            mt: 1.5,
            p: 1.5,
            bgcolor: 'action.hover',
            borderRadius: 1,
            fontSize: '0.75rem',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
            m: 0,
            mb: 0,
          }}
        >
          {endpoint.details}
        </Box>
      )}
    </Paper>
  );
}

export default function Docs() {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const searchInputRef = useAutoFocusSearch();
  const [origin, setOrigin] = useState('');

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return API_GROUPS;
    return API_GROUPS.map((group) => {
      const endpoints = group.endpoints.filter((e) => {
        const haystack = `${e.method} ${(e.alsoMethods ?? []).join(' ')} ${e.path} ${e.summary}`.toLowerCase();
        return haystack.includes(q) || group.name.toLowerCase().includes(q);
      });
      return { ...group, endpoints };
    }).filter((g) => g.endpoints.length > 0);
  }, [query]);

  return (
    <>
      <PageHeader
        eyebrow={t('docs.eyebrow')}
        title={t('docs.title')}
        description={t('docs.description')}
        icon={MenuBookRoundedIcon}
        maxWidth={960}
      />
      <Container maxWidth="md" sx={{ py: { xs: 3, md: 5 } }}>

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          {t('docs.baseUrl')}
        </Typography>
        <Box
          component="code"
          sx={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.9rem' }}
        >
          {origin || 'http://localhost:4200'}
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('docs.baseHelp', { url: (origin || 'http://localhost:4200') + '/v1' })}
        </Typography>
      </Paper>

      <StickySearchBar mode="page" sx={{ mb: 3 }}>
        <TextField
          fullWidth
          size="small"
          inputRef={searchInputRef}
          placeholder={t('docs.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
      </StickySearchBar>

      {filteredGroups.length === 0 && (
        <Typography color="text.secondary">{t('docs.noMatches', { query })}</Typography>
      )}

      {filteredGroups.map((group) => (
        <Box key={group.id} sx={{ mb: 4 }} id={group.id}>
          <Typography variant="h6" gutterBottom>
            {GROUP_MESSAGE_KEYS[group.id as keyof typeof GROUP_MESSAGE_KEYS]
              ? t(GROUP_MESSAGE_KEYS[group.id as keyof typeof GROUP_MESSAGE_KEYS].name)
              : group.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {GROUP_MESSAGE_KEYS[group.id as keyof typeof GROUP_MESSAGE_KEYS]
              ? t(GROUP_MESSAGE_KEYS[group.id as keyof typeof GROUP_MESSAGE_KEYS].description)
              : group.description}
          </Typography>
          {group.endpoints.map((e) => (
            <EndpointCard key={`${e.method} ${e.path}`} endpoint={e} />
          ))}
        </Box>
      ))}

      <Divider sx={{ my: 3 }} />
      <Typography variant="caption" color="text.secondary">
        <MuiLink href="https://github.com/mario-andreschak/FLUJO" target="_blank" rel="noopener">
          {t('docs.security')}
        </MuiLink>
      </Typography>
      </Container>
    </>
  );
}
