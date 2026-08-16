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
import { useI18n } from '@/frontend/contexts/I18nContext';
import { summarizeTokenMeter } from '@/shared/utils/tokenUsage';

/** 12345 → "12.3k", 950 → "950". */
export const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `${n}`;

interface ConversationStatsProps {
  usage: NonNullable<Conversation['usage']> | undefined;
  contextInfo: Conversation['contextInfo'];
  /** For resolving node ids in the per-node breakdown to display labels. */
  availableNodes: { id: string; label: string }[];
  /** Reduce labels and meters to a single phone-friendly header row. */
  compact?: boolean;
}

/**
 * Compact token/context summary for the chat header: total tokens (click for
 * the per-node breakdown) and, when the active model's context window is
 * configured, a context-usage meter based on the provider-reported prompt
 * size of the latest call.
 */
const ConversationStats: React.FC<ConversationStatsProps> = ({ usage, contextInfo, availableNodes, compact = false }) => {
  const { t, formatNumber } = useI18n();
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
  const meter = usage ? summarizeTokenMeter(usage) : undefined;
  const cachedReads = meter?.cacheReadTokens ?? 0;
  const cacheWrites = meter?.cacheWriteTokens ?? 0;
  const freshPrompt = meter?.freshPromptTokens ?? 0;
  const freshTotal = meter?.meterTotalTokens ?? 0;

  // Context meter: provider-reported prompt tokens of the latest call vs the
  // bound model's configured window. Rendered only when both are known.
  const contextPct =
    contextInfo?.contextWindow && contextInfo.contextWindow > 0
      ? Math.min(100, Math.round((contextInfo.promptTokens / contextInfo.contextWindow) * 100))
      : undefined;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: compact ? 0.5 : 1.5, flexShrink: 0 }}>
      {usage && freshTotal > 0 && (
        <>
          <Tooltip title={t('chat.stats.tooltip', {
            prompt: formatNumber(freshPrompt),
            completion: formatNumber(usage.completionTokens),
            cached: cachedReads > 0 ? t('chat.stats.cached', { count: formatNumber(cachedReads) }) : '',
            written: cacheWrites > 0 ? t('chat.stats.written', { count: formatNumber(cacheWrites) }) : '',
          })}>
            <Chip
              icon={<DataUsageIcon />}
              label={compact ? formatTokens(freshTotal) : t('chat.stats.tokens', { count: formatTokens(freshTotal) })}
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
            <Box sx={{ p: 2, maxWidth: 'min(680px, calc(100vw - 24px))', overflowX: 'auto' }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                {t('chat.stats.title')}
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('chat.stats.node')}</TableCell>
                    <TableCell align="right">{t('chat.stats.prompt')}</TableCell>
                    <TableCell align="right">{t('chat.stats.completion')}</TableCell>
                    <TableCell align="right">{t('chat.stats.cachedRead')}</TableCell>
                    <TableCell align="right">{t('chat.stats.cacheWrite')}</TableCell>
                    <TableCell align="right">{t('chat.stats.total')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {byNode.map(([nodeId, n]) => {
                    const nodeMeter = summarizeTokenMeter(n);
                    return (
                      <TableRow key={nodeId}>
                        <TableCell>
                          <Tooltip title={nodeId}>
                            <span>{nodeLabel(nodeId)}</span>
                          </Tooltip>
                        </TableCell>
                        <TableCell align="right">{formatNumber(nodeMeter.freshPromptTokens)}</TableCell>
                        <TableCell align="right">{formatNumber(nodeMeter.completionTokens)}</TableCell>
                        <TableCell align="right">{formatNumber(nodeMeter.cacheReadTokens)}</TableCell>
                        <TableCell align="right">{formatNumber(nodeMeter.cacheWriteTokens)}</TableCell>
                        <TableCell align="right">{formatNumber(nodeMeter.meterTotalTokens)}</TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 'bold' }}>{t('chat.stats.total')}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{formatNumber(freshPrompt)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{formatNumber(usage.completionTokens)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{formatNumber(cachedReads)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{formatNumber(cacheWrites)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{formatNumber(freshTotal)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              {cachedReads > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  {t('chat.stats.cacheHelp', { cached: formatNumber(cachedReads), fresh: formatNumber(freshTotal) })}
                </Typography>
              )}
              {cacheWrites > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  {t('chat.stats.cacheWriteHelp', { written: formatNumber(cacheWrites) })}
                </Typography>
              )}
            </Box>
          </Popover>
        </>
      )}

      {contextInfo && contextPct !== undefined && !compact && (
        <Tooltip
          title={t('chat.stats.context', {
            model: contextInfo.modelDisplayName ? t('chat.stats.model', { model: contextInfo.modelDisplayName }) : '',
            used: formatNumber(contextInfo.promptTokens),
            total: formatNumber(contextInfo.contextWindow!),
          })}
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

      {contextInfo && contextPct !== undefined && compact && (
        <Tooltip title={t('chat.stats.context', {
          model: contextInfo.modelDisplayName ? t('chat.stats.model', { model: contextInfo.modelDisplayName }) : '',
          used: formatNumber(contextInfo.promptTokens),
          total: formatNumber(contextInfo.contextWindow!),
        })}>
          <Typography variant="caption" color={contextPct >= 90 ? 'error.main' : 'text.secondary'} sx={{ whiteSpace: 'nowrap' }}>
            ctx {contextPct}%
          </Typography>
        </Tooltip>
      )}

      {contextInfo && contextPct === undefined && (
        <Tooltip title={t('chat.stats.noWindow', {
          model: contextInfo.modelDisplayName ? t('chat.stats.model', { model: contextInfo.modelDisplayName }) : '',
        })}>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            ctx {formatTokens(contextInfo.promptTokens)}
          </Typography>
        </Tooltip>
      )}
    </Box>
  );
};

export default ConversationStats;
