"use client";

import React, { useMemo, useState } from 'react';
import {
  Box, Typography, Chip, Paper, ToggleButtonGroup, ToggleButton,
  Accordion, AccordionSummary, AccordionDetails,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ModelInputSnapshot, WireStatus, ModelInputProvenanceEntry } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { useI18n } from '@/frontend/contexts/I18nContext';

/**
 * Conversation-aware "Model Input" viewer for the Visual Debugger (issue #153).
 *
 * Because of FLUJO's wire-shaping optimizations — conversation folding
 * (outputMode), inputMode scoping, and handoff/tool-call stripping — the message
 * list the model actually receives differs from the persisted conversation. This
 * component surfaces, for one Process-node model call:
 *   - the resolved SYSTEM message (prominent, collapsible),
 *   - the exact WIRE conversation the model sees,
 *   - a toggle to an ANNOTATED full-history view that marks which messages were
 *     folded / scoped-out / handoff-stripped, and why.
 *
 * It renders `DebugStep.modelInput` (a ModelInputSnapshot) which is derived from
 * the same pipeline functions the runtime uses, so what is shown is faithful.
 */

type ChipColor = 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning';

const STATUS_META: Record<WireStatus, { color: ChipColor }> = {
  'system': { color: 'secondary' },
  'sent': { color: 'success' },
  'folded': { color: 'warning' },
  'scoped-out': { color: 'info' },
  'handoff-stripped': { color: 'default' },
};

function roleColor(role: string): ChipColor {
  switch (role) {
    case 'system': return 'secondary';
    case 'user': return 'primary';
    case 'assistant': return 'success';
    case 'tool': return 'info';
    default: return 'default';
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    try { return JSON.stringify(content, null, 2); } catch { return String(content); }
  }
  if (content == null) return '';
  try { return JSON.stringify(content, null, 2); } catch { return String(content); }
}

const contentPre: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  fontSize: '0.75rem',
  fontFamily: 'inherit',
};

/**
 * One-line summary of how the persisted history maps onto the wire the model
 * receives (shared by the inspector accordion and the #162 Conversation
 * section so both read identically).
 */
export function wireSummary(
  counts: ModelInputSnapshot['counts'],
  t?: (key: any, values?: Record<string, string | number>) => string,
): string {
  if (t) {
    return [
      t('chat.debug.summary', { history: counts.threaded, sent: counts.sent }),
      counts.folded ? t('chat.debug.foldedCount', { count: counts.folded }) : '',
      counts.scopedOut ? t('chat.debug.scopedCount', { count: counts.scopedOut }) : '',
      counts.handoffStripped ? t('chat.debug.handoffCount', { count: counts.handoffStripped }) : '',
    ].filter(Boolean).join(' · ');
  }
  return `${counts.threaded} in history → ${counts.sent} sent`
    + (counts.folded ? ` · ${counts.folded} folded` : '')
    + (counts.scopedOut ? ` · ${counts.scopedOut} scoped out` : '')
    + (counts.handoffStripped ? ` · ${counts.handoffStripped} handoff-stripped` : '');
}

/** One message row in the wire view (or annotated history). */
const MessageRow: React.FC<{
  role: string;
  content: string;
  toolCallNames?: string[];
  status?: WireStatus;
  faded?: boolean;
}> = ({ role, content, toolCallNames, status, faded }) => {
  const { t } = useI18n();
  const showStatus = status && status !== 'sent' && status !== 'system';
  const localizedRole = role === 'user'
    ? t('chat.messages.you')
    : role === 'assistant'
      ? t('chat.messages.agent')
      : role === 'tool'
        ? t('chat.messages.tool')
        : role === 'system'
          ? t('chat.messages.system')
          : role;
  const statusLabel = status === 'system'
    ? t('chat.debug.status.system')
    : status === 'sent'
      ? t('chat.debug.status.sent')
      : status === 'folded'
        ? t('chat.debug.status.folded')
        : status === 'scoped-out'
          ? t('chat.debug.status.scoped')
          : t('chat.debug.status.handoff');
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1,
        mb: 0.75,
        opacity: faded ? 0.55 : 1,
        borderStyle: faded ? 'dashed' : 'solid',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5, flexWrap: 'wrap' }}>
        <Chip size="small" label={localizedRole} color={roleColor(role)} variant="outlined" />
        {toolCallNames && toolCallNames.length > 0 && (
          <Chip
            size="small"
            variant="outlined"
            label={`🔧 ${toolCallNames.join(', ')}`}
            sx={{ maxWidth: '100%' }}
          />
        )}
        {showStatus && (
          <Chip size="small" color={STATUS_META[status!].color} label={statusLabel} />
        )}
      </Box>
      {content.trim().length > 0 ? (
        <pre style={contentPre}>{content}</pre>
      ) : (
        <Typography variant="caption" color="textSecondary">{t('chat.debug.noText')}</Typography>
      )}
    </Paper>
  );
};

/**
 * Annotated full-history view: the entire threaded history with per-message
 * provenance badges (folded / scoped-out / handoff-stripped). Extracted so the
 * regular chat's model-input view can offer it as the "Full history (annotated)"
 * companion to the real-chat wire render.
 */
export const AnnotatedHistory: React.FC<{ provenance: ModelInputProvenanceEntry[] }> = ({ provenance }) => {
  const { t } = useI18n();
  return <Box>
    <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 0.5 }}>
      {t('chat.debug.historyHelp')}
    </Typography>
    {provenance.map((p: ModelInputProvenanceEntry, i: number) => (
      <MessageRow
        key={p.id ?? `hist-${i}`}
        role={p.role}
        content={p.preview ?? ''}
        toolCallNames={p.toolCallNames}
        status={p.status}
        faded={p.status !== 'sent' && p.status !== 'system'}
      />
    ))}
    {provenance.some((p) => p.status !== 'sent' && p.status !== 'system') && (
      <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 1 }}>
        {t('chat.debug.badgeHelp')}
      </Typography>
    )}
  </Box>;
};

const DebuggerModelInput: React.FC<{ modelInput: ModelInputSnapshot }> = ({ modelInput }) => {
  const { t, tp, formatNumber } = useI18n();
  const [view, setView] = useState<'wire' | 'annotated'>('wire');

  const { systemMessage, wireMessages, provenance, counts, inputMode, visualCompaction } = modelInput;

  // The wire view shows non-system messages (the system message gets its own
  // prominent block above).
  const wireBody = useMemo(
    () => (wireMessages || []).filter((m) => m.role !== 'system'),
    [wireMessages],
  );

  const summary = wireSummary(counts, t);

  return (
    <Box sx={{ p: 1 }}>
      {/* Summary + input mode */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
        <Typography variant="caption" color="textSecondary">{summary}</Typography>
        {inputMode && inputMode !== 'full-history' && (
          <Chip size="small" variant="outlined" label={`inputMode: ${inputMode}`} />
        )}
      </Box>

      {visualCompaction && (
        <Paper variant="outlined" sx={{ p: 1, mb: 1 }}>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip size="small" color={visualCompaction.route === 'image' ? 'success' : 'default'} label={t('chat.debug.visualRoute', { route: visualCompaction.route })} />
            <Chip size="small" variant="outlined" label={t('chat.debug.vision', { capability: visualCompaction.capability })} />
            {visualCompaction.evaluationOnly && <Chip size="small" variant="outlined" label={t('chat.debug.evaluationOnly')} />}
            {visualCompaction.fallbackReason && <Chip size="small" variant="outlined" label={visualCompaction.fallbackReason} />}
          </Box>
          {visualCompaction.estimates && (
            <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 0.5 }}>
              {t('chat.debug.visualEstimates', {
                raw: formatNumber(visualCompaction.estimates.rawTextTokens),
                image: formatNumber(visualCompaction.estimates.imageTokens),
                sidecar: formatNumber(visualCompaction.estimates.sidecarTokens),
                savings: formatNumber(visualCompaction.estimates.netSavings),
                percent: formatNumber(visualCompaction.estimates.savingsPercent, { maximumFractionDigits: 1 }),
                pages: tp('chat.debug.pages', visualCompaction.pages.length),
                bytes: formatNumber(visualCompaction.renderedBytes),
                latency: formatNumber(visualCompaction.latencyMs),
              })}
            </Typography>
          )}
          {visualCompaction.sourceResourceUri && (
            <Typography variant="caption" sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere' }}>
              {t('chat.debug.exactSource', { uri: visualCompaction.sourceResourceUri, hash: visualCompaction.sourceSha256 ?? '—' })}
            </Typography>
          )}
        </Paper>
      )}

      {/* Resolved system message — prominent, collapsible. */}
      <Accordion defaultExpanded sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
          <Typography variant="caption"><b>{t('chat.debug.systemMessage')}</b></Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 0 }}>
          {systemMessage && systemMessage.content.trim().length > 0 ? (
            <Paper variant="outlined" sx={{ p: 1, maxHeight: 260, overflowY: 'auto' }}>
              <pre style={contentPre}>{systemMessage.content}</pre>
            </Paper>
          ) : (
            <Typography variant="caption" color="textSecondary">{t('chat.debug.noSystem')}</Typography>
          )}
        </AccordionDetails>
      </Accordion>

      {/* View toggle: what the model sees vs annotated full history. */}
      <ToggleButtonGroup
        size="small"
        exclusive
        value={view}
        onChange={(_e, v) => { if (v) setView(v); }}
        sx={{ my: 1 }}
      >
        <ToggleButton value="wire">{t('chat.debug.modelView')}</ToggleButton>
        <ToggleButton value="annotated">{t('chat.debug.fullHistory')}</ToggleButton>
      </ToggleButtonGroup>

      {view === 'wire' ? (
        <Box>
          <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 0.5 }}>
            {tp('chat.debug.wireConversation', wireBody.length)}
          </Typography>
          {wireBody.length === 0 ? (
            <Typography variant="body2" color="textSecondary">
              {t('chat.debug.noConversation')}
            </Typography>
          ) : (
            wireBody.map((m: FlujoChatMessage, i: number) => (
              <MessageRow
                key={m.id ?? `wire-${i}`}
                role={m.role as string}
                content={textOf(m.content)}
                toolCallNames={
                  m.role === 'assistant' && Array.isArray(m.tool_calls)
                    ? m.tool_calls
                        .map((tc) => (tc.type === 'function' ? tc.function.name : undefined))
                        .filter((n): n is string => !!n)
                    : undefined
                }
              />
            ))
          )}
        </Box>
      ) : (
        <AnnotatedHistory provenance={provenance} />
      )}
    </Box>
  );
};

export default DebuggerModelInput;
