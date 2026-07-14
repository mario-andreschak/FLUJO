"use client";

import React, { useState } from 'react';
import {
  Box,
  Chip,
  LinearProgress,
  Popover,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import DataUsageIcon from '@mui/icons-material/DataUsage';
import type { Conversation } from './index';

/** 12345 → "12.3k", 950 → "950". */
export const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `${n}`;

interface ConversationStatsProps {
  usage: NonNullable<Conversation['usage']> | undefined;
  contextInfo: Conversation['contextInfo'];
  /** For resolving node ids in the per-node breakdown to display labels. */
  availableNodes: { id: string; label: string }[];
}

/**
 * Compact token/context summary for the chat header: total tokens (click for
 * the per-node breakdown) and, when the active model's context window is
 * configured, a context-usage meter based on the provider-reported prompt
 * size of the latest call.
 */
const ConversationStats: React.FC<ConversationStatsProps> = ({ usage, contextInfo, availableNodes }) => {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  if (!usage && !contextInfo) return null;

  const nodeLabel = (nodeId: string) =>
    availableNodes.find(n => n.id === nodeId)?.label || `${nodeId.substring(0, 8)}…`;

  const byNode = usage?.byNode ? Object.entries(usage.byNode) : [];

  // Cache RE-READ tokens are a subset of promptTokens that was re-read cheaply
  // from the provider prompt cache. Counting them as fresh input made warmed
  // conversations report absurd totals (#87), so the headline shows the FRESH
  // figure (total minus cached reads) and the cached amount is called out
  // separately in the tooltip/breakdown.
  const cachedReads = usage?.cacheReadTokens ?? 0;
  const freshPrompt = usage ? Math.max(0, usage.promptTokens - cachedReads) : 0;
  const freshTotal = usage ? Math.max(0, usage.totalTokens - cachedReads) : 0;

  // Context meter: provider-reported prompt tokens of the latest call vs the
  // bound model's configured window. Rendered only when both are known.
  const contextPct =
    contextInfo?.contextWindow && contextInfo.contextWindow > 0
      ? Math.min(100, Math.round((contextInfo.promptTokens / contextInfo.contextWindow) * 100))
      : undefined;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
      {usage && freshTotal > 0 && (
        <>
          <Tooltip title={`Tokens this conversation — ${freshPrompt.toLocaleString()} prompt / ${usage.completionTokens.toLocaleString()} completion${cachedReads > 0 ? ` (+${cachedReads.toLocaleString()} cached reads, not counted)` : ''}. Click for the per-node breakdown.`}>
            <Chip
              icon={<DataUsageIcon />}
              label={`${formatTokens(freshTotal)} tokens`}
              size="small"
              variant="outlined"
              onClick={(e) => setAnchorEl(e.currentTarget)}
              sx={{ cursor: 'pointer' }}
            />
          </Tooltip>
          <Popover
            open={Boolean(anchorEl)}
            anchorEl={anchorEl}
            onClose={() => setAnchorEl(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            <Box sx={{ p: 2, maxWidth: 420 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Token usage by node
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Node</TableCell>
                    <TableCell align="right">Prompt</TableCell>
                    <TableCell align="right">Completion</TableCell>
                    <TableCell align="right">Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {byNode.map(([nodeId, n]) => (
                    <TableRow key={nodeId}>
                      <TableCell>
                        <Tooltip title={nodeId}>
                          <span>{nodeLabel(nodeId)}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right">{n.promptTokens.toLocaleString()}</TableCell>
                      <TableCell align="right">{n.completionTokens.toLocaleString()}</TableCell>
                      <TableCell align="right">{n.totalTokens.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 'bold' }}>Total</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{usage.promptTokens.toLocaleString()}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{usage.completionTokens.toLocaleString()}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{usage.totalTokens.toLocaleString()}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              {cachedReads > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  Prompt totals include {cachedReads.toLocaleString()} tokens re-read from the
                  prompt cache. The header chip shows the fresh figure
                  ({freshTotal.toLocaleString()}) with those cached reads excluded.
                </Typography>
              )}
            </Box>
          </Popover>
        </>
      )}

      {contextInfo && contextPct !== undefined && (
        <Tooltip
          title={`Context of the latest call${contextInfo.modelDisplayName ? ` (${contextInfo.modelDisplayName})` : ''}: ${contextInfo.promptTokens.toLocaleString()} of ${contextInfo.contextWindow!.toLocaleString()} tokens`}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 140 }}>
            <LinearProgress
              variant="determinate"
              value={contextPct}
              color={contextPct >= 90 ? 'error' : contextPct >= 70 ? 'warning' : 'primary'}
              sx={{ flex: 1, height: 6, borderRadius: 3 }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {formatTokens(contextInfo.promptTokens)}/{formatTokens(contextInfo.contextWindow!)} ({contextPct}%)
            </Typography>
          </Box>
        </Tooltip>
      )}

      {contextInfo && contextPct === undefined && (
        <Tooltip title={`Prompt size of the latest call${contextInfo.modelDisplayName ? ` (${contextInfo.modelDisplayName})` : ''}. Set the model's Context Window in its settings to see a usage meter.`}>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            ctx {formatTokens(contextInfo.promptTokens)}
          </Typography>
        </Tooltip>
      )}
    </Box>
  );
};

export default ConversationStats;
