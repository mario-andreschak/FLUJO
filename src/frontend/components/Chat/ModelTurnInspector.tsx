"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  Divider,
  Paper,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelTurnSnapshot } from '@/shared/types/modelTurn';
import { chatService } from '@/frontend/services/chat';

export type ModelTurnInspectorTab = 'canonical' | 'wire' | 'request';

interface ModelTurnInspectorProps {
  snapshot: ModelTurnSnapshot;
  conversationId: string;
  tab: ModelTurnInspectorTab;
  onTabChange: (tab: ModelTurnInspectorTab) => void;
}

const json = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const bytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

interface InvocationParameter {
  name: string;
  value: unknown;
}

interface InvocationView {
  before?: string;
  callee: string;
  parameters: InvocationParameter[];
  argumentSource: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

/**
 * Describe the concrete adapter invocation without repeating diagnostics that
 * happened to be stored beside its arguments. Older Codex archives included a
 * `thread` diagnostic block, for example, although runStreamed only receives
 * input and options.
 */
export function invocationView(snapshot: ModelTurnSnapshot): InvocationView {
  const request = asRecord(snapshot.sdkRequest);
  const operation = snapshot.entry.operation.replace(/\(stream\)$/, '');

  if (snapshot.entry.adapter === 'codex-cli' && request) {
    const parameters = [
      { name: 'input', value: request.input },
      { name: 'options', value: request.options },
    ];
    return {
      callee: 'thread.runStreamed',
      parameters,
      argumentSource: 'input, options',
    };
  }

  if (snapshot.entry.adapter === 'claude-cli' && request) {
    return {
      before: 'const prompt = promptStream();',
      callee: 'query',
      parameters: [
        { name: 'prompt', value: request.prompt },
        { name: 'options', value: request.options },
      ],
      argumentSource: '{ prompt, options }',
    };
  }

  if (snapshot.entry.adapter === 'openrouter-media') {
    return {
      callee: 'fetch',
      parameters: [{ name: 'request', value: snapshot.sdkRequest }],
      argumentSource: 'url, { method: "POST", body: JSON.stringify(request) }',
    };
  }

  const root = snapshot.entry.adapter === 'gemini'
    ? 'ai'
    : snapshot.entry.adapter === 'anthropic'
      ? 'client'
      : 'openai';
  return {
    callee: `${root}.${operation}`,
    parameters: [{ name: 'request', value: snapshot.sdkRequest }],
    argumentSource: 'request',
  };
}

function CodeToken({
  name,
  selected,
  onSelect,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onSelect}
      aria-label={`Inspect ${name}`}
      aria-pressed={selected}
      sx={{
        appearance: 'none',
        border: 0,
        borderRadius: 0.75,
        px: 0.35,
        py: 0.1,
        mx: 0.1,
        color: selected ? 'primary.contrastText' : 'primary.light',
        bgcolor: selected ? 'primary.main' : 'transparent',
        font: 'inherit',
        cursor: 'pointer',
        '&:hover': { bgcolor: selected ? 'primary.dark' : 'action.selected' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      {name}
    </Box>
  );
}

function RequestCodeCanvas({ snapshot }: { snapshot: ModelTurnSnapshot }) {
  const invocation = useMemo(() => invocationView(snapshot), [snapshot]);
  const [selectedName, setSelectedName] = useState(invocation.parameters[0]?.name ?? 'request');
  useEffect(() => {
    setSelectedName(invocation.parameters[0]?.name ?? 'request');
  }, [invocation]);
  const selected = invocation.parameters.find(parameter => parameter.name === selectedName)
    ?? invocation.parameters[0];

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }} data-testid="request-code-canvas">
      <Box sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2">Adapter call</Typography>
        <Typography variant="caption" color="text.secondary">
          Click a parameter to inspect the value captured at dispatch.
        </Typography>
      </Box>
      <Divider />
      <Box
        sx={{
          p: 2,
          overflowX: 'auto',
          bgcolor: '#111827',
          color: '#e5e7eb',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 13,
          lineHeight: 1.8,
          whiteSpace: 'pre',
        }}
      >
        {invocation.before && <Box sx={{ color: '#9ca3af' }}>{invocation.before}</Box>}
        <Box component="span" sx={{ color: '#c084fc' }}>const</Box>
        {' response = '}
        <Box component="span" sx={{ color: '#c084fc' }}>await</Box>
        {` ${invocation.callee}(`}
        {invocation.argumentSource === 'input, options' ? (
          <>
            <CodeToken name="input" selected={selectedName === 'input'} onSelect={() => setSelectedName('input')} />
            {', '}
            <CodeToken name="options" selected={selectedName === 'options'} onSelect={() => setSelectedName('options')} />
          </>
        ) : invocation.argumentSource === '{ prompt, options }' ? (
          <>
            {'{ '}
            <CodeToken name="prompt" selected={selectedName === 'prompt'} onSelect={() => setSelectedName('prompt')} />
            {', '}
            <CodeToken name="options" selected={selectedName === 'options'} onSelect={() => setSelectedName('options')} />
            {' }'}
          </>
        ) : invocation.argumentSource.includes('JSON.stringify') ? (
          <>
            {'url, { method: "POST", body: JSON.stringify('}
            <CodeToken name="request" selected={selectedName === 'request'} onSelect={() => setSelectedName('request')} />
            {') }'}
          </>
        ) : (
          <CodeToken name="request" selected={selectedName === 'request'} onSelect={() => setSelectedName('request')} />
        )}
        {');'}
      </Box>
      <Box sx={{ px: 1.5, py: 0.9, bgcolor: 'action.hover', borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" sx={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontWeight: 700 }}>
          {selected?.name}
        </Typography>
      </Box>
      <Box
        component="pre"
        data-testid="request-parameter-value"
        sx={{
          m: 0,
          p: 1.5,
          maxHeight: '55vh',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 12,
          lineHeight: 1.55,
        }}
      >
        {json(selected?.value)}
      </Box>
    </Paper>
  );
}

function MessageList({
  messages,
  provenance,
}: {
  messages: ReadonlyArray<FlujoChatMessage | object>;
  provenance?: ModelTurnSnapshot['provenance'];
}) {
  const statusById = useMemo(
    () => new Map((provenance ?? []).filter(item => item.id).map(item => [item.id!, item])),
    [provenance],
  );

  return (
    <Box sx={{ display: 'grid', gap: 1.25 }}>
      {messages.map((message, index) => {
        const record = message as unknown as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id : undefined;
        const role = typeof record.role === 'string' ? record.role : 'unknown';
        const status = id ? statusById.get(id) : undefined;
        return (
          <Paper key={id ?? index} variant="outlined" sx={{ overflow: 'hidden' }}>
            <Box sx={{ px: 1.25, py: 0.75, display: 'flex', gap: 0.75, alignItems: 'center' }}>
              <Chip size="small" label={role} variant="outlined" />
              {status && (
                <Chip
                  size="small"
                  label={status.status}
                  color={status.status === 'sent' || status.status === 'system'
                    ? 'success'
                    : status.status === 'emergency-stripped'
                      ? 'error'
                      : status.status === 'content-truncated'
                        ? 'warning'
                        : 'default'}
                  variant="outlined"
                />
              )}
              <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                {index + 1}
              </Typography>
            </Box>
            <Divider />
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.25,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 12,
                lineHeight: 1.55,
                bgcolor: 'action.hover',
              }}
            >
              {json(record)}
            </Box>
          </Paper>
        );
      })}
    </Box>
  );
}

export default function ModelTurnInspector({
  snapshot,
  conversationId,
  tab,
  onTabChange,
}: ModelTurnInspectorProps) {
  const { entry } = snapshot;

  return (
    <Box data-testid="model-turn-inspector" sx={{ maxWidth: 1100, mx: 'auto', pb: 4 }}>
      <Paper
        data-testid="model-turn-inspector-header"
        variant="outlined"
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 3,
          mb: 1.5,
          p: 1.25,
          bgcolor: 'background.paper',
          boxShadow: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={tab}
            onChange={(_event, value: ModelTurnInspectorTab | null) => value && onTabChange(value)}
            aria-label="Model turn detail"
            sx={{ flexShrink: 0 }}
          >
            <ToggleButton value="canonical">Canonical</ToggleButton>
            <ToggleButton value="wire">Wired</ToggleButton>
            <ToggleButton value="request">Request Detail</ToggleButton>
          </ToggleButtonGroup>
          <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
          <Typography variant="subtitle2">
            {entry.node.nodeName || entry.node.nodeId}
          </Typography>
          <Chip size="small" label={entry.modelName} variant="outlined" />
          <Chip size="small" label={`${entry.adapter} · ${entry.operation}`} variant="outlined" />
          <Chip
            size="small"
            label={entry.outcome}
            color={entry.outcome === 'completed' ? 'success' : entry.outcome === 'error' ? 'error' : 'default'}
          />
          <Typography variant="caption" color="text.secondary" sx={{ ml: { sm: 'auto' } }}>
            {new Date(entry.timestamp).toLocaleString()}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          Dispatch {entry.attempt} · {entry.canonicalMessageCount} canonical · {entry.wireMessageCount} wire · {entry.mediaCount} media
        </Typography>
      </Paper>

      {snapshot.contextCompaction?.events.map((event, index) => (
        <Alert
          key={`${event.kind}-${index}`}
          severity={event.kind === 'emergency-refit' ? 'warning' : 'info'}
          variant="outlined"
          sx={{ mb: 1 }}
        >
          <b>{event.kind}</b>: {event.reason}
          {event.before !== undefined && event.after !== undefined
            ? ` (${event.before.toLocaleString()} → ${event.after.toLocaleString()} ${event.unit ?? ''})`
            : ''}
          {event.omittedMessages ? ` · ${event.omittedMessages} omitted` : ''}
          {event.truncatedMessages ? ` · ${event.truncatedMessages} truncated` : ''}
        </Alert>
      ))}

      {snapshot.visualCompaction && (
        <Alert severity={snapshot.visualCompaction.route === 'image' ? 'warning' : 'info'} variant="outlined" sx={{ mb: 1 }}>
          Visual context route: {snapshot.visualCompaction.route}
          {snapshot.visualCompaction.candidate
            ? ` · ${snapshot.visualCompaction.candidate.messageCount} old messages evaluated`
            : ''}
          {snapshot.visualCompaction.fallbackReason ? ` · ${snapshot.visualCompaction.fallbackReason}` : ''}
        </Alert>
      )}

      {tab === 'canonical' && (
        <>
          <Alert severity="info" variant="outlined" sx={{ mb: 1.25 }}>
            The canonical node-threaded conversation before provider wire shaping.
          </Alert>
          <MessageList messages={snapshot.canonicalMessages} provenance={snapshot.provenance} />
        </>
      )}

      {tab === 'wire' && (
        <>
          <Alert severity="info" variant="outlined" sx={{ mb: 1.25 }}>
            The final hydrated provider-neutral conversation supplied to the adapter.
          </Alert>
          <MessageList messages={snapshot.genericWire} />
        </>
      )}

      {tab === 'request' && (
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {snapshot.media.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.75 }}>SDK media parameters</Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 1 }}>
                {snapshot.media.map(media => {
                  const src = chatService.modelTurnMediaUrl(conversationId, entry.id, media.id);
                  return (
                    <Paper key={media.id} variant="outlined" sx={{ p: 1, minWidth: 0 }}>
                      {media.kind === 'image' ? (
                        <Box component="img" src={src} alt={media.parameterPath} sx={{ width: '100%', maxHeight: 220, objectFit: 'contain', borderRadius: 1, bgcolor: 'action.hover' }} />
                      ) : media.kind === 'audio' ? (
                        <Box component="audio" controls src={src} sx={{ width: '100%' }} />
                      ) : media.kind === 'video' ? (
                        <Box component="video" controls src={src} sx={{ width: '100%', maxHeight: 240, borderRadius: 1 }} />
                      ) : (
                        <Typography component="a" href={src} target="_blank" rel="noreferrer" variant="body2">
                          Open archived file
                        </Typography>
                      )}
                      <Typography variant="caption" sx={{ display: 'block', mt: 0.75, overflowWrap: 'anywhere' }}>
                        {media.parameterPath}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {media.mimeType} · {bytes(media.byteLength)}
                      </Typography>
                    </Paper>
                  );
                })}
              </Box>
            </Box>
          )}
          <RequestCodeCanvas snapshot={snapshot} />
        </Box>
      )}
    </Box>
  );
}
