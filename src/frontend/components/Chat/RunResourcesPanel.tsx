"use client";

import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  CircularProgress,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import ImageIcon from '@mui/icons-material/Image';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import LinkIcon from '@mui/icons-material/Link';
import type { RunResourceEntry } from '@/shared/types/runResources';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Chat/RunResourcesPanel');

interface RunResourcesPanelProps {
  conversationId: string;
  /** Bump to refetch (Chat increments it on each resource:write event). */
  refreshToken?: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindIcon(kind: RunResourceEntry['kind']) {
  switch (kind) {
    case 'image': return <ImageIcon fontSize="small" sx={{ color: '#009688' }} />;
    case 'audio': return <AudiotrackIcon fontSize="small" sx={{ color: '#009688' }} />;
    case 'link': return <LinkIcon fontSize="small" sx={{ color: '#009688' }} />;
    default: return <DescriptionIcon fontSize="small" sx={{ color: '#009688' }} />;
  }
}

function producerLabel(entry: RunResourceEntry): string {
  const p = entry.producedBy;
  switch (p.source) {
    case 'tool-result': return `tool ${p.server ?? '?'}/${p.toolName ?? '?'}`;
    case 'tool-args': return `tool args ${p.server ?? '?'}/${p.toolName ?? '?'}`;
    case 'capture': return `step ${p.nodeName ?? p.nodeId ?? '?'}`;
    case 'mcp-link': return `link from ${p.server ?? '?'}`;
    default: return 'run';
  }
}

/**
 * The run-data panel (Tier 3): lists the run-scoped resources captured for a
 * conversation — auto-captured tool results, captureResource outputs, tracked
 * links — with producer lineage and read counts. Mounted in the debugger's
 * inspector; refreshed live via `refreshToken`.
 */
const RunResourcesPanel: React.FC<RunResourcesPanelProps> = ({ conversationId, refreshToken }) => {
  const [resources, setResources] = useState<RunResourceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    fetch(`/v1/chat/conversations/${encodeURIComponent(conversationId)}/resources`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((body: { resources?: RunResourceEntry[] }) => {
        if (!cancelled) {
          setResources(Array.isArray(body.resources) ? body.resources : []);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          log.warn('Failed to load run resources', err);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => { cancelled = true; };
  }, [conversationId, refreshToken]);

  if (error) {
    return <Typography variant="caption" color="text.secondary">Run data unavailable ({error})</Typography>;
  }
  if (resources === null) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', p: 1 }}><CircularProgress size={16} /></Box>;
  }
  if (resources.length === 0) {
    return <Typography variant="caption" color="text.secondary">No data artifacts captured in this run yet.</Typography>;
  }

  return (
    <List dense disablePadding>
      {[...resources].sort((a, b) => b.createdAt - a.createdAt).map((entry) => (
        <ListItem key={entry.id} disableGutters sx={{ alignItems: 'flex-start' }}>
          <ListItemIcon sx={{ minWidth: 30, mt: 0.5 }}>{kindIcon(entry.kind)}</ListItemIcon>
          <ListItemText
            primary={
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {entry.name ?? `${entry.kind}-${entry.id.slice(0, 8)}`}
                </Typography>
                {entry.mimeType && <Chip label={entry.mimeType} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />}
                <Typography variant="caption" color="text.secondary">{formatSize(entry.size)}</Typography>
              </Box>
            }
            secondary={
              <Typography variant="caption" color="text.secondary" component="span" sx={{ wordBreak: 'break-all' }}>
                by {producerLabel(entry)}
                {entry.readBy.length > 0 ? ` · read ${entry.readBy.length}×` : ''}
                {' · '}{entry.uri}
              </Typography>
            }
          />
        </ListItem>
      ))}
    </List>
  );
};

export default RunResourcesPanel;
