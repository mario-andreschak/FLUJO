"use client";

import React, { useMemo, useState } from 'react';
import {
  Box, Typography, Chip, Paper, ToggleButtonGroup, ToggleButton,
  Accordion, AccordionSummary, AccordionDetails,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ModelInputSnapshot, WireStatus, ModelInputProvenanceEntry } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';

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

const STATUS_META: Record<WireStatus, { label: string; color: ChipColor }> = {
  'system': { label: 'system', color: 'secondary' },
  'sent': { label: 'sent', color: 'success' },
  'folded': { label: 'folded', color: 'warning' },
  'scoped-out': { label: 'scoped out', color: 'info' },
  'handoff-stripped': { label: 'handoff plumbing', color: 'default' },
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
export function wireSummary(counts: ModelInputSnapshot['counts']): string {
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
  const showStatus = status && status !== 'sent' && status !== 'system';
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
        <Chip size="small" label={role} color={roleColor(role)} variant="outlined" />
        {toolCallNames && toolCallNames.length > 0 && (
          <Chip
            size="small"
            variant="outlined"
            label={`🔧 ${toolCallNames.join(', ')}`}
            sx={{ maxWidth: '100%' }}
          />
        )}
        {showStatus && (
          <Chip size="small" color={STATUS_META[status!].color} label={STATUS_META[status!].label} />
        )}
      </Box>
      {content.trim().length > 0 ? (
        <pre style={contentPre}>{content}</pre>
      ) : (
        <Typography variant="caption" color="textSecondary">(no text content)</Typography>
      )}
    </Paper>
  );
};

/**
 * Annotated full-history view: the entire threaded history with per-message
 * provenance badges (folded / scoped-out / handoff-stripped). Extracted so the
 * #162 Conversation section can offer it as the "Full history (annotated)"
 * companion to the real-chat wire render.
 */
export const AnnotatedHistory: React.FC<{ provenance: ModelInputProvenanceEntry[] }> = ({ provenance }) => (
  <Box>
    <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 0.5 }}>
      Full threaded history — greyed rows are not sent to the model.
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
        Hover a badge label to understand why a message is not on the wire:
        folded (outputMode), scoped out (inputMode), or handoff plumbing (tool-call strip).
      </Typography>
    )}
  </Box>
);

const DebuggerModelInput: React.FC<{ modelInput: ModelInputSnapshot }> = ({ modelInput }) => {
  const [view, setView] = useState<'wire' | 'annotated'>('wire');

  const { systemMessage, wireMessages, provenance, counts, inputMode } = modelInput;

  // The wire view shows non-system messages (the system message gets its own
  // prominent block above).
  const wireBody = useMemo(
    () => (wireMessages || []).filter((m) => m.role !== 'system'),
    [wireMessages],
  );

  const summary = wireSummary(counts);

  return (
    <Box sx={{ p: 1 }}>
      {/* Summary + input mode */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
        <Typography variant="caption" color="textSecondary">{summary}</Typography>
        {inputMode && inputMode !== 'full-history' && (
          <Chip size="small" variant="outlined" label={`inputMode: ${inputMode}`} />
        )}
      </Box>

      {/* Resolved system message — prominent, collapsible. */}
      <Accordion defaultExpanded sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
          <Typography variant="caption"><b>System message</b></Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 0 }}>
          {systemMessage && systemMessage.content.trim().length > 0 ? (
            <Paper variant="outlined" sx={{ p: 1, maxHeight: 260, overflowY: 'auto' }}>
              <pre style={contentPre}>{systemMessage.content}</pre>
            </Paper>
          ) : (
            <Typography variant="caption" color="textSecondary">(no system message)</Typography>
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
        <ToggleButton value="wire">What the model sees</ToggleButton>
        <ToggleButton value="annotated">Full history (annotated)</ToggleButton>
      </ToggleButtonGroup>

      {view === 'wire' ? (
        <Box>
          <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 0.5 }}>
            Wire conversation ({wireBody.length} message{wireBody.length === 1 ? '' : 's'})
          </Typography>
          {wireBody.length === 0 ? (
            <Typography variant="body2" color="textSecondary">
              No conversation messages — the model sees only the system message.
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
