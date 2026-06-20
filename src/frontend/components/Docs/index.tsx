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
import { API_GROUPS, ApiEndpoint, HttpMethod } from './apiReference';

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
            {endpoint.paramsLabel ?? 'Parameters'}
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
                    {p.required ? ' · required' : ''} — {p.description}
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
            Response:{' '}
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
    </Paper>
  );
}

export default function Docs() {
  const [query, setQuery] = useState('');
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
    <Container maxWidth="md" sx={{ py: 5 }}>
      <Typography variant="h4" gutterBottom>
        API Documentation
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
        FLUJO exposes an OpenAI-compatible chat API and a REST surface for managing models, MCP
        servers, flows, and conversations. All endpoints are served from this instance.
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          Base URL
        </Typography>
        <Box
          component="code"
          sx={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.9rem' }}
        >
          {origin || 'http://localhost:4200'}
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Point any OpenAI SDK at{' '}
          <Box component="code" sx={{ fontFamily: 'var(--font-geist-mono), monospace' }}>
            {(origin || 'http://localhost:4200') + '/v1'}
          </Box>{' '}
          and set the model to{' '}
          <Box component="code" sx={{ fontFamily: 'var(--font-geist-mono), monospace' }}>
            flow-&lt;NAME&gt;
          </Box>
          . Any API key value is accepted locally.
        </Typography>
      </Paper>

      <TextField
        fullWidth
        size="small"
        placeholder="Search endpoints (path, method, description)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{ mb: 3 }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
      />

      {filteredGroups.length === 0 && (
        <Typography color="text.secondary">No endpoints match “{query}”.</Typography>
      )}

      {filteredGroups.map((group) => (
        <Box key={group.id} sx={{ mb: 4 }} id={group.id}>
          <Typography variant="h6" gutterBottom>
            {group.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {group.description}
          </Typography>
          {group.endpoints.map((e) => (
            <EndpointCard key={`${e.method} ${e.path}`} endpoint={e} />
          ))}
        </Box>
      ))}

      <Divider sx={{ my: 3 }} />
      <Typography variant="caption" color="text.secondary">
        Secrets (API keys, encryption passwords, OAuth tokens) are encrypted at rest and never
        returned to the browser in clear text. See the project{' '}
        <MuiLink href="https://github.com/mario-andreschak/FLUJO" target="_blank" rel="noopener">
          repository
        </MuiLink>{' '}
        for source-level details.
      </Typography>
    </Container>
  );
}
