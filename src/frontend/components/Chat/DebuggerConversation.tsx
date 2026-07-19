"use client";

import React, { useMemo, useState } from 'react';
import {
  Box, Typography, Chip, Paper,
  Accordion, AccordionSummary, AccordionDetails,
  ToggleButtonGroup, ToggleButton,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ModelInputSnapshot } from '@/backend/execution/flow/types';
import type { ChatMessage } from './index';
import ChatMessages from './ChatMessages';
import { AnnotatedHistory, wireSummary } from './DebuggerModelInput';

/**
 * Conversation section of the Visual Debugger (issue #162).
 *
 * Shows the *wired* conversation for the currently-selected Process-node model
 * call using the REAL chat renderer (`ChatMessages`) — so the debugger renders
 * tool-call timelines, tool results and attribution pills exactly as the chat
 * does, reflecting the conversation after all fold / inputMode-scope /
 * handoff-strip plumbing but before the model call. A toggle switches to the
 * annotated full-history provenance view (folded / scoped-out / handoff-stripped
 * rows greyed out) so nothing dropped from the wire becomes invisible.
 *
 * The render is strictly READ-ONLY: every mutating callback passed to
 * `ChatMessages` is an inert no-op and no tool-approval / edit affordances are
 * wired, so inspecting a step can never mutate the conversation.
 */

// Inert callbacks — the debugger conversation must never mutate anything.
const noop = () => {};

interface DebuggerConversationProps {
  modelInput: ModelInputSnapshot;
  /** Owning conversation id — used only to key the ChatMessages render window. */
  conversationId?: string;
}

const DebuggerConversation: React.FC<DebuggerConversationProps> = ({ modelInput, conversationId }) => {
  const [view, setView] = useState<'wire' | 'annotated'>('wire');
  const { systemMessage, wireMessages, provenance, counts, inputMode } = modelInput;

  // The system message gets its own prominent block; the chat render shows the
  // conversation body only. wireMessages is FlujoChatMessage[] which is a
  // superset of ChatMessage, so it feeds ChatMessages directly.
  const wireBody = useMemo(
    () => ((wireMessages || []).filter((m) => m.role !== 'system') as unknown as ChatMessage[]),
    [wireMessages],
  );

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 1 }}>
      {/* Summary + input mode */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
        <Typography variant="caption" color="textSecondary">{wireSummary(counts)}</Typography>
        {inputMode && inputMode !== 'full-history' && (
          <Chip size="small" variant="outlined" label={`inputMode: ${inputMode}`} />
        )}
      </Box>

      {/* Resolved system message — prominent, collapsible. */}
      <Accordion sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
          <Typography variant="caption"><b>System message</b></Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 0 }}>
          {systemMessage && systemMessage.content.trim().length > 0 ? (
            <Paper variant="outlined" sx={{ p: 1, maxHeight: 220, overflowY: 'auto' }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: '0.75rem', fontFamily: 'inherit' }}>
                {systemMessage.content}
              </pre>
            </Paper>
          ) : (
            <Typography variant="caption" color="textSecondary">(no system message)</Typography>
          )}
        </AccordionDetails>
      </Accordion>

      {/* View toggle: what the model sees (real chat render) vs annotated history. */}
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

      {/* Content-capped preview note (WIRE_CONTENT_MAX): so truncation isn't
          mistaken for stripping. */}
      <Box sx={{ flexGrow: 1, overflowY: 'auto', minHeight: 0 }}>
        {view === 'wire' ? (
          wireBody.length === 0 ? (
            <Typography variant="body2" color="textSecondary" sx={{ p: 1 }}>
              No conversation messages — the model sees only the system message.
            </Typography>
          ) : (
            <ChatMessages
              messages={wireBody}
              conversationId={conversationId ? `debug-${conversationId}` : undefined}
              onToggleDisabled={noop}
              onSplitConversation={noop}
            />
          )
        ) : (
          <AnnotatedHistory provenance={provenance} />
        )}
      </Box>
    </Box>
  );
};

export default DebuggerConversation;
