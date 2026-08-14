"use client";

import React, { useMemo, useState } from 'react';
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

type InspectorTab = 'canonical' | 'wire' | 'request';

interface ModelTurnInspectorProps {
  snapshot: ModelTurnSnapshot;
  conversationId: string;
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
                  color={status.status === 'sent' || status.status === 'system' ? 'success' : 'default'}
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

export default function ModelTurnInspector({ snapshot, conversationId }: ModelTurnInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('wire');
  const { entry } = snapshot;

  return (
    <Box data-testid="model-turn-inspector" sx={{ maxWidth: 1100, mx: 'auto', pb: 4 }}>
      <Paper variant="outlined" sx={{ mb: 1.5, p: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
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

      <ToggleButtonGroup
        exclusive
        size="small"
        value={tab}
        onChange={(_event, value: InspectorTab | null) => value && setTab(value)}
        aria-label="Model turn detail"
        sx={{ mb: 1.5 }}
      >
        <ToggleButton value="canonical">Canonical</ToggleButton>
        <ToggleButton value="wire">Wired</ToggleButton>
        <ToggleButton value="request">Request Detail</ToggleButton>
      </ToggleButtonGroup>

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
          <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
            <Box sx={{ px: 1.25, py: 0.75 }}>
              <Typography variant="subtitle2">{entry.adapter} SDK parameters</Typography>
            </Box>
            <Divider />
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                maxHeight: '65vh',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                bgcolor: 'action.hover',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 12,
                lineHeight: 1.55,
              }}
            >
              {json(snapshot.sdkRequest)}
            </Box>
          </Paper>
        </Box>
      )}
    </Box>
  );
}
