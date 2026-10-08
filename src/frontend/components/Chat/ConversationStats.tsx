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
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
    : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `${n}`;

interface ConversationStatsProps {
  usage: NonNullable<Conversation['usage']> | undefined;
  contextInfo: Conversation['contextInfo'];
  /** For resolving node ids in the per-node breakdown to display labels. */
  availableNodes: { id: string; label: string }[];
  /** Reduce labels and meters to a single phone-friendly header row. */
  compact?: boolean;
}

/**
 * Conversation-wide input/output totals, with the latest individual
 * request's context displayed independently. Click for full processed totals.
 */
const ConversationStats: React.FC<ConversationStatsProps> = ({ usage, contextInfo, availableNodes, compact = false }) => {
  const { t, formatNumber } = useI18n();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  if (!usage && !contextInfo) return null;

  const nodeLabel = (nodeId: string) =>
    availableNodes.find(n => n.id === nodeId)?.label || `${nodeId.substring(0, 8)}…`;

  const byNode = usage?.byNode ? Object.entries(usage.byNode) : [];

  // Input includes cached reads on every provider; cache columns are subsets.
  const meter = usage ? summarizeTokenMeter(usage) : undefined;
  const cachedReads = meter?.cacheReadTokens ?? 0;
  const cacheWrites = meter?.cacheWriteTokens ?? 0;
  const promptTokens = usage?.promptTokens ?? 0;

  const contextTokens = contextInfo?.totalTokens ?? contextInfo?.promptTokens;
  const hasContext = typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens >= 0;
  const contextPct =
    hasContext && contextInfo?.contextWindow && contextInfo.contextWindow > 0
      ? Math.round((contextTokens / contextInfo.contextWindow) * 100)
      : undefined;

  const contextTooltip = hasContext && contextInfo?.contextWindow
    ? `${t('chat.stats.context', {
      model: contextInfo.modelDisplayName ? t('chat.stats.model', { model: contextInfo.modelDisplayName }) : '',
      used: formatNumber(contextTokens!),
      total: formatNumber(contextInfo.contextWindow),
    })}${contextInfo.contextWindowSource === 'configured' ? ` ${t('chat.stats.configuredWindow')}` : ''}`
    : '';

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: compact ? 0.5 : 1.5, flexShrink: 0 }}>
      {usage && meter!.processedTotalTokens > 0 && (
        <>
          <Tooltip title={t('chat.stats.tooltip', {
            prompt: formatNumber(promptTokens),
            completion: formatNumber(usage.completionTokens),
            cached: cachedReads > 0 ? t('chat.stats.cached', { count: formatNumber(cachedReads) }) : '',
            written: cacheWrites > 0 ? t('chat.stats.written', { count: formatNumber(cacheWrites) }) : '',
          })}>
            <Chip
              icon={<DataUsageIcon />}
              label={t(compact ? 'chat.stats.inputOutputCompact' : 'chat.stats.inputOutput', {
                input: formatTokens(promptTokens),
                output: formatTokens(meter!.completionTokens),
              })}
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
                        <TableCell align="right">{formatNumber(n.promptTokens)}</TableCell>
                        <TableCell align="right">{formatNumber(nodeMeter.completionTokens)}</TableCell>
                        <TableCell align="right">{n.cacheReadTokens == null ? '—' : formatNumber(nodeMeter.cacheReadTokens)}</TableCell>
                        <TableCell align="right">{n.cacheWriteTokens == null ? '—' : formatNumber(nodeMeter.cacheWriteTokens)}</TableCell>
                        <TableCell align="right">{formatNumber(nodeMeter.processedTotalTokens)}</TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 'bold' }}>{t('chat.stats.total')}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{formatNumber(promptTokens)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{formatNumber(usage.completionTokens)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{usage.cacheReadTokens == null ? '—' : formatNumber(cachedReads)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{usage.cacheWriteTokens == null ? '—' : formatNumber(cacheWrites)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{formatNumber(meter!.processedTotalTokens)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              {cachedReads > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  {t('chat.stats.cacheHelp', { cached: formatNumber(cachedReads) })}
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
          title={contextTooltip}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 140 }}>
            <LinearProgress
              variant="determinate"
              value={Math.min(100, contextPct)}
              color={contextPct >= 90 ? 'error' : contextPct >= 70 ? 'warning' : 'primary'}
              sx={{ flex: 1, height: 6, borderRadius: 3 }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {t('chat.stats.contextLabel')} {formatTokens(contextTokens!)}/{formatTokens(contextInfo.contextWindow!)} ({contextPct}%)
            </Typography>
          </Box>
        </Tooltip>
      )}

      {contextInfo && contextPct !== undefined && compact && (
        <Tooltip title={contextTooltip}>
          <Typography variant="caption" color={contextPct >= 90 ? 'error.main' : 'text.secondary'} sx={{ whiteSpace: 'nowrap' }}>
            ctx {contextPct}%
          </Typography>
        </Tooltip>
      )}

      {contextInfo && hasContext && contextPct === undefined && (
        <Tooltip title={t('chat.stats.noWindow', {
          model: contextInfo.modelDisplayName ? t('chat.stats.model', { model: contextInfo.modelDisplayName }) : '',
        })}>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            {t('chat.stats.contextLabel')} {formatTokens(contextTokens!)}
          </Typography>
        </Tooltip>
      )}
      {contextInfo && !hasContext && (
        <Tooltip title={t('chat.stats.contextUnavailableHelp')}>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            {t('chat.stats.contextUnavailable')}
          </Typography>
        </Tooltip>
      )}
    </Box>
  );
};

export default ConversationStats;
