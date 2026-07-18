"use client";

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Button,
  FormControl,
  InputLabel,
  Select,
  Switch,
  FormControlLabel,
  Collapse,
  CircularProgress
} from '@mui/material';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import BlockIcon from '@mui/icons-material/Block';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import MicIcon from '@mui/icons-material/Mic';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HandymanIcon from '@mui/icons-material/Handyman';
import TerminalIcon from '@mui/icons-material/Terminal';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import EditIcon from '@mui/icons-material/Edit';
import ThumbUpIcon from '@mui/icons-material/ThumbUp'; // For Approve
import ThumbDownIcon from '@mui/icons-material/ThumbDown'; // For Reject
import ArrowRightAltIcon from '@mui/icons-material/ArrowRightAlt'; // For handoff marker
import { ChatMessage } from './index';
import OpenAI from 'openai'; // Import OpenAI types for tool calls
import { displayToolName } from '@/utils/shared/common'; // Friendly tool-name decode
import { HANDOFF_TOOL_PREFIX, slugifyHandoffTarget } from '@/shared/utils/handoffNaming';
import { type ToolCallPair, groupToolCallsByAnchor, collectHandoffToolCallIds } from './toolCallPairing'; // #95: merge tool call + result onto the narration anchor
import McpAppFrame from './McpAppFrame'; // #97: read-only, sandboxed MCP App (ui:// resource) renderer
import { createLogger } from '@/utils/logger'; // Import the logger

const log = createLogger('frontend/components/Chat/ChatMessages'); // Initialize logger

// How many messages render initially / how many more each expander click adds.
// Long conversations previously rendered EVERY bubble on every update; the
// window keeps steady-state work proportional to what is actually on screen.
const MESSAGES_WINDOW_INITIAL = 50;
const MESSAGES_WINDOW_STEP = 200;

interface ChatMessagesProps {
  messages: ChatMessage[];
  pendingToolCalls?: OpenAI.ChatCompletionMessageToolCall[] | null; // Add pending calls prop
  availableNodes?: { id: string; label: string }[]; // Add available nodes for dropdown
  /** Resets the render window when the user switches conversations. */
  conversationId?: string;
  onToggleDisabled: (messageId: string) => void;
  onSplitConversation: (messageId: string) => void;
  onEditMessage?: (messageId: string, content: string, processNodeId?: string | null) => void;
  onApproveToolCall?: (toolCallId: string) => void; // Add approve handler prop
  onRejectToolCall?: (toolCallId: string) => void; // Add reject handler prop
}

// Type guard to check if a message has tool_calls
function hasToolCalls(message: ChatMessage): message is ChatMessage & { tool_calls: OpenAI.ChatCompletionMessageToolCall[] } {
  return message.role === 'assistant' && 'tool_calls' in message && Array.isArray(message.tool_calls);
}

// --- Handoff rendering (issue: declutter routing in chat) ---
// A handoff shows up as an ordinary assistant tool_call named `handoff_to_<slug>`
// (often with empty args) plus a `tool` result of `{"handoff":true,...}`. Both
// hit the generic tool accordions and read as noise. We detect them and render a
// single slim "Handoff → Target" marker instead, suppressing the empty result.

/** True when a tool function name is a handoff (matches the runtime prefix). */
function isHandoffToolName(name?: string): boolean {
  return !!name && (name.startsWith(HANDOFF_TOOL_PREFIX) || name === 'handoff');
}

/** True when a tool-result message is the meaningless `{handoff:true}` blob. */
function isHandoffResult(message: ChatMessage): boolean {
  if (message.role !== 'tool' || typeof message.content !== 'string') return false;
  try {
    return JSON.parse(message.content)?.handoff === true;
  } catch {
    return false;
  }
}

/**
 * Human-readable name for a handoff target. Prefer the exact node label (matched
 * by slugifying each available node the same way the tool name was built), and
 * fall back to de-slugifying the tool name (`handoff_to_finish_node` → "Finish
 * Node"). The optional numeric collision suffix (`_2`) is tolerated in matching.
 */
function handoffTargetLabel(toolName: string, availableNodes: { id: string; label: string }[]): string {
  const slug = toolName.startsWith(HANDOFF_TOOL_PREFIX)
    ? toolName.slice(HANDOFF_TOOL_PREFIX.length)
    : toolName;
  const bareSlug = slug.replace(/_\d+$/, ''); // drop a trailing collision suffix
  const match = availableNodes.find((n) => {
    const nodeSlug = slugifyHandoffTarget(n.label);
    return nodeSlug === slug || nodeSlug === bareSlug;
  });
  if (match?.label) return match.label;
  // De-slugify: underscores → spaces, Title Case.
  return bareSlug
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'target node';
}

// Compact token count for the per-message chip (12345 → "12.3k").
const formatTokenCount = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `${n}`;

// Format timestamp
const formatTime = (timestamp: number) => {
  // Add a check for valid timestamp before formatting
  if (typeof timestamp !== 'number' || isNaN(timestamp)) {
    log.warn('formatTime received invalid timestamp:', timestamp);
    return 'Invalid Date';
  }
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Markdown renderers are pure of any per-message state, so they live at module
// scope: a stable identity means memoized bubbles don't re-parse/re-render
// their markdown when the list re-renders.
const MARKDOWN_COMPONENTS: Components = {
  p: (props) => <Typography variant="body1" sx={{ mb: 0.5, whiteSpace: 'pre-line' }}>{props.children}</Typography>,
  h1: (props) => <Typography variant="h5" sx={{ mt: 2, mb: 0.5 }}>{props.children}</Typography>,
  h2: (props) => <Typography variant="h6" sx={{ mt: 2, mb: 0.5 }}>{props.children}</Typography>,
  h3: (props) => <Typography variant="subtitle1" sx={{ mt: 1.5, mb: 0.5 }}>{props.children}</Typography>,
  h4: (props) => <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>{props.children}</Typography>,
  h5: (props) => <Typography variant="body1" sx={{ mt: 1, mb: 0.5, fontWeight: 'bold' }}>{props.children}</Typography>,
  h6: (props) => <Typography variant="body2" sx={{ mt: 1, mb: 0.5, fontWeight: 'bold' }}>{props.children}</Typography>,
  ul: (props) => <Box component="ul" sx={{ pl: 2, mb: 1 }}>{props.children}</Box>,
  ol: (props) => <Box component="ol" sx={{ pl: 2, mb: 1 }}>{props.children}</Box>,
  li: (props) => <Box component="li" sx={{ mb: 0.5, whiteSpace: 'pre-line' }}>{props.children}</Box>,
  a: (props) => <Typography component="a" sx={{ color: 'primary.main' }} href={props.href}>{props.children}</Typography>,
  blockquote: (props) => (
    <Box component="blockquote" sx={{
      borderLeft: '4px solid',
      borderColor: 'divider',
      pl: 2,
      py: 0.5,
      my: 1,
      bgcolor: 'action.hover',
      borderRadius: '4px'
    }}>{props.children}</Box>
  ),
  code: ({ node, className, children, ...props }: any) => {
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !match && !className;
    return isInline ? (
      <Typography component="code" sx={{
        bgcolor: 'action.hover', px: 0.5, py: 0.25, borderRadius: '4px', fontFamily: 'monospace',
        wordBreak: 'break-all', // Break inline code if needed
      }}>{children}</Typography>
    ) : (
      <Box component="pre" sx={{
        bgcolor: 'action.hover', p: 1.5, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace',
        fontSize: '0.875rem', my: 1, whiteSpace: 'pre-wrap', // Ensure wrapping in code blocks
        wordBreak: 'break-word', // Break long words in code blocks
      }}>{children}</Box>
    );
  }
};

/**
 * Renders a tool result body — either the raw string or the "rendered" view
 * that understands the MCP `{ content: [...] }` shape (text → markdown,
 * image/audio → inline media, everything else → pretty-printed JSON). Extracted
 * so the merged tool-call timeline (#95) and the legacy orphan tool bubble share
 * a single implementation.
 */
const ToolResultView: React.FC<{ content: unknown; showRaw: boolean }> = ({ content, showRaw }) => {
  if (showRaw) {
    return (
      <Box
        component="pre"
        sx={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          fontSize: '0.8rem',
          p: 1,
          borderRadius: 1,
          border: 1,
          borderColor: (theme) => (theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb'),
          bgcolor: 'action.hover',
          color: (theme) => theme.palette.text.primary,
          overflow: 'auto',
          maxHeight: '300px',
        }}
      >
        {typeof content === 'string' ? content : '[Invalid tool content]'}
      </Box>
    );
  }

  if (typeof content !== 'string') {
    return (
      <Typography variant="body2" fontStyle="italic" color="text.secondary">
        [Invalid tool content]
      </Typography>
    );
  }

  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      {(() => {
        try {
          const parsedContent = JSON.parse(content);
          // MCP structured content: an array of text/image/audio parts.
          if (parsedContent && Array.isArray(parsedContent.content)) {
            return (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {parsedContent.content.map((item: any, index: number) => {
                  if (item.type === 'text') {
                    return <ReactMarkdown key={index} remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>;
                  } else if (item.type === 'image' && item.data && item.mimeType) {
                    return (
                      <img
                        key={index}
                        src={`data:${item.mimeType};base64,${item.data}`}
                        alt={`Tool Result Image ${index + 1}`}
                        style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px', marginTop: '8px' }}
                      />
                    );
                  } else if (item.type === 'audio' && item.data && item.mimeType) {
                    return (
                      <audio
                        key={index}
                        controls
                        src={`data:${item.mimeType};base64,${item.data}`}
                        style={{ width: '100%', marginTop: '8px' }}
                      >
                        Your browser does not support the audio element.
                      </audio>
                    );
                  } else {
                    return (
                      <Box
                        key={index}
                        component="pre"
                        sx={{
                          whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.8rem', p: 1,
                          borderRadius: 1, border: 1, borderColor: (theme) => (theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb'),
                          bgcolor: 'action.hover', color: (theme) => theme.palette.text.primary, overflow: 'auto', mt: 1,
                        }}
                      >
                        {`Unsupported content type: ${item.type}\n${JSON.stringify(item, null, 2)}`}
                      </Box>
                    );
                  }
                })}
              </Box>
            );
          }
          // Valid JSON but not the MCP shape: pretty-print it.
          return <ReactMarkdown remarkPlugins={[remarkGfm]}>{`\`\`\`json\n${JSON.stringify(parsedContent, null, 2)}\n\`\`\``}</ReactMarkdown>;
        } catch (e) {
          // Not JSON: render the raw string as markdown.
          return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
        }
      })()}
    </Box>
  );
};

type ToolCallStatus = 'pending' | 'done' | 'error';

/** Classify a tool result: pending (none yet), error (MCP `isError` / an `error` field), else done. */
function toolCallStatus(result?: ChatMessage): ToolCallStatus {
  if (!result) return 'pending';
  if (typeof result.content === 'string') {
    try {
      const parsed = JSON.parse(result.content);
      if (parsed && (parsed.isError === true || parsed.error != null)) return 'error';
    } catch {
      /* a non-JSON string result is a normal (done) result */
    }
  }
  return 'done';
}

function toolCallStatusIcon(status: ToolCallStatus): React.ReactElement {
  if (status === 'pending') return <CircularProgress size={14} thickness={6} />;
  if (status === 'error') return <ErrorOutlineIcon fontSize="small" />;
  return <CheckCircleOutlineIcon fontSize="small" />;
}

/**
 * Merged tool-call view (#95): a horizontal, wrapping timeline of the assistant
 * turn's (non-handoff) tool calls, rendered at the bottom of its bubble. Each
 * node shows the tool name + a status chip (pending spinner / done check / error).
 * Clicking a node expands an inline panel showing that call's parameters AND its
 * result together — replacing the old separate tool-call and tool-result bubbles.
 * One panel open at a time. Expansion + the per-result raw/rendered toggle are
 * local state; the component is keyed by the stable message id so the state
 * survives the parent list's re-renders.
 */
const ToolCallTimeline: React.FC<{ pairs: ToolCallPair<ChatMessage>[]; messageId: string }> = ({ pairs, messageId }) => {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [rawByKey, setRawByKey] = useState<Record<string, boolean>>({});
  const keyFor = (pair: ToolCallPair<ChatMessage>, index: number) =>
    pair.toolCall.id || `tc-${messageId}-${index}`;

  return (
    <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', color: 'primary.main', mb: 1 }}>
        <HandymanIcon fontSize="small" sx={{ mr: 1 }} />
        <Typography variant="body2">
          {pairs.length === 1 ? 'The assistant used a tool' : `The assistant used ${pairs.length} tools`}
        </Typography>
      </Box>

      {/* Horizontal, wrapping timeline of clickable nodes. */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5 }}>
        {pairs.map((pair, index) => {
          const key = keyFor(pair, index);
          const status = toolCallStatus(pair.result);
          const isOpen = expandedKey === key;
          return (
            <React.Fragment key={key}>
              {index > 0 && (
                <Box sx={{ width: 14, height: '2px', bgcolor: 'divider', flexShrink: 0 }} />
              )}
              <Tooltip title={isOpen ? 'Hide call & result' : 'Show call & result'}>
                <Chip
                  icon={toolCallStatusIcon(status)}
                  label={displayToolName(pair.toolCall.function.name)}
                  size="small"
                  clickable
                  variant={isOpen ? 'filled' : 'outlined'}
                  color={status === 'error' ? 'error' : status === 'pending' ? 'default' : 'primary'}
                  onClick={() => setExpandedKey(isOpen ? null : key)}
                  sx={{ maxWidth: '100%' }}
                />
              </Tooltip>
            </React.Fragment>
          );
        })}
      </Box>

      {/* One expandable panel per node (single-open model). */}
      {pairs.map((pair, index) => {
        const key = keyFor(pair, index);
        let formattedArgs = pair.toolCall.function.arguments;
        try {
          formattedArgs = JSON.stringify(JSON.parse(pair.toolCall.function.arguments), null, 2);
        } catch (e) { /* keep the original string */ }
        const showRaw = !!rawByKey[key];

        return (
          <Collapse key={key} in={expandedKey === key} unmountOnExit>
            <Box sx={{ mt: 1, p: 1, borderRadius: 1, bgcolor: 'rgba(0, 0, 0, 0.03)' }}>
              {/* Call parameters */}
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
                <HandymanIcon fontSize="small" sx={{ mr: 0.5, color: 'primary.main' }} />
                <Typography variant="caption" sx={{ fontWeight: 'bold' }}>Parameters</Typography>
                <Chip
                  label={`ID: ${pair.toolCall.id ? pair.toolCall.id.substring(0, 8) : 'N/A'}...`}
                  size="small" color="default" variant="outlined"
                  sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                />
              </Box>
              <Box component="pre" sx={{
                bgcolor: 'action.hover', p: 1, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace',
                fontSize: '0.75rem', my: 0.5, maxHeight: '150px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {formattedArgs}
              </Box>

              {/* Matching result (or a pending placeholder) */}
              <Box sx={{ display: 'flex', alignItems: 'center', mt: 1, mb: 0.5 }}>
                <TerminalIcon fontSize="small" sx={{ mr: 0.5, color: 'text.secondary' }} />
                <Typography variant="caption" sx={{ fontWeight: 'bold' }}>Result</Typography>
                {pair.result && (
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={showRaw}
                        onChange={(e) => setRawByKey((prev) => ({ ...prev, [key]: e.target.checked }))}
                      />
                    }
                    label="Raw"
                    sx={{ ml: 'auto', mr: 0, '& .MuiTypography-root': { fontSize: '0.75rem' } }}
                  />
                )}
              </Box>
              {pair.result ? (
                <ToolResultView content={pair.result.content} showRaw={showRaw} />
              ) : (
                <Typography
                  variant="body2"
                  fontStyle="italic"
                  color="text.secondary"
                  sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                >
                  <CircularProgress size={14} thickness={6} /> Waiting for the tool to respond…
                </Typography>
              )}

              {/* #97: an MCP App (ui:// resource) linked to this tool result,
                  rendered read-only in a sandboxed iframe. Present only when the
                  server has the MCP Apps opt-in enabled (gated server-side). */}
              {pair.result?.ui?.uri && pair.result.ui.serverName && (
                <McpAppFrame serverName={pair.result.ui.serverName} uri={pair.result.ui.uri} />
              )}
            </Box>
          </Collapse>
        );
      })}
    </Box>
  );
};

/** Edit state, present only on the single bubble currently being edited. */
interface BubbleEditState {
  content: string;
  nodeId: string | null;
}

interface MessageBubbleProps {
  message: ChatMessage;
  /** Resolved node label for the attribution pill (id shown in the tooltip). */
  nodeLabel?: string;
  /** Stable reference (memoized by the parent) — used by the edit-mode Select. */
  availableNodes: { id: string; label: string }[];
  /** Raw/rendered toggle for the LEGACY standalone (orphan) tool-result bubble. */
  showRaw: boolean;
  /**
   * #95: for an assistant message, its ordered non-handoff tool-call/result
   * pairs (computed once by the container). Undefined for other roles or an
   * assistant turn with no non-handoff tool calls.
   */
  toolCallPairs?: ToolCallPair<ChatMessage>[];
  /**
   * #95 (follow-up): handoff tool calls hoisted from suppressed tool-call-only
   * messages in the same assistant run, rendered as slim markers on this anchor
   * bubble (in addition to any handoffs the message owns itself).
   */
  hoistedHandoffs?: OpenAI.ChatCompletionMessageToolCall[];
  /** Non-null only while THIS bubble is in edit mode. */
  edit: BubbleEditState | null;
  onMenuOpen: (event: React.MouseEvent<HTMLElement>, messageId: string) => void;
  onToggleRaw: (messageId: string, checked: boolean) => void;
  onEditContentChange: (content: string) => void;
  onEditNodeChange: (nodeId: string) => void;
  /** Passed only to the bubble being edited (undefined elsewhere, keeps memo stable). */
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
}

/**
 * One message bubble, memoized. This is the chat's hot render path: markdown
 * parsing (ReactMarkdown) happens in here, so the memo boundary is what stops
 * every SSE event / indicator tick from re-parsing the entire conversation.
 * All props are primitives, stable callbacks, or per-bubble values that only
 * change when THIS message changes.
 */
const MessageBubble = React.memo<MessageBubbleProps>(function MessageBubble({
  message,
  nodeLabel,
  availableNodes,
  showRaw,
  toolCallPairs,
  hoistedHandoffs,
  edit,
  onMenuOpen,
  onToggleRaw,
  onEditContentChange,
  onEditNodeChange,
  onSaveEdit,
  onCancelEdit,
}) {
  // Subflow steps (depth > 0) render nested: indented per level, marked with a
  // guide line + chip. They are display-only (never sent back as history).
  const depth = message.depth ?? 0;
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
        opacity: message.disabled ? 0.5 : 1,
        ...(depth > 0 && {
          pl: 3 * depth,
          borderLeft: '2px solid',
          borderColor: 'divider',
          ml: 1,
        }),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
          {message.role === 'user'
            ? 'You'
            : message.role === 'assistant'
              ? 'Assistant'
              : message.role === 'tool'
                ? 'Tool'
                : 'System'} • {formatTime(message.timestamp)}
        </Typography>

        {message.processNodeId && (
          <Tooltip title={`${nodeLabel ? `${nodeLabel} — ` : ''}Process Node ID: ${message.processNodeId}`}>
            <Chip
              label={`Node: ${nodeLabel || `${message.processNodeId.substring(0, 6)}...`}`}
              size="small"
              color="primary"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
            />
          </Tooltip>
        )}

        {depth > 0 && (
          <Tooltip title={`Nested subflow step (depth ${depth})`}>
            <Chip
              label="Subflow step"
              size="small"
              color="secondary"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
            />
          </Tooltip>
        )}

        {message.disabled && (
          <Chip
            label="Disabled"
            size="small"
            color="default"
            variant="outlined"
            sx={{ height: 20, fontSize: '0.7rem' }}
          />
        )}

        {message.usage && (
          <Tooltip title={`${message.usage.promptTokens.toLocaleString()} prompt + ${message.usage.completionTokens.toLocaleString()} completion tokens (provider-reported)`}>
            <Chip
              label={`${formatTokenCount(message.usage.totalTokens)} tok`}
              size="small"
              color="default"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
            />
          </Tooltip>
        )}

        <IconButton
          size="small"
          onClick={(e) => onMenuOpen(e, message.id)}
          sx={{ ml: 1 }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Box>

      <Paper
        elevation={1}
        sx={{
          p: 2,
          maxWidth: '75vw', // Set max width to 75% of viewport width
          borderRadius: 2,
          bgcolor: message.role === 'user'
            ? 'primary.light'
            : message.role === 'assistant' || message.role === 'tool'
              ? 'background.paper'
              : 'info.light',
          color: message.role === 'user'
            ? 'primary.contrastText'
            : message.role === 'assistant' || message.role === 'tool'
              ? 'text.primary'
              : 'info.contrastText',
          position: 'relative',
          borderLeft: message.role === 'tool' ? '4px solid' : 'none',
          borderColor: message.role === 'tool' ? 'grey.400' : 'transparent',
          overflowWrap: 'break-word', // Ensure long words break
          wordBreak: 'break-word', // Ensure words break correctly
          // NOTE: do NOT set white-space: pre-wrap here. react-markdown emits
          // literal "\n" text nodes *between* block elements; a pre-wrap
          // container renders those as visible blank lines on top of the
          // paragraph block margins, which doubled the spacing for every
          // newline. Whitespace is instead preserved per-block (see the `p`
          // and `li` renderers above, which use `pre-line`).
          overflow: 'hidden', // Prevent content from visually overflowing the paper
        }}
      >
        {edit ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <textarea
              value={edit.content}
              onChange={(e) => onEditContentChange(e.target.value)}
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                backgroundColor: 'white',
                color: 'black',
              }}
            />
            <FormControl fullWidth size="small" sx={{ mt: 1 }}>
              <InputLabel id="node-id-select-label">Process Node</InputLabel>
              <Select
                labelId="node-id-select-label"
                id="node-id-select"
                value={edit.nodeId || (availableNodes.length > 0 ? availableNodes[0].id : "")}
                label="Process Node"
                onChange={(e) => onEditNodeChange(e.target.value)}
              >
                {availableNodes.map((node) => (
                  <MenuItem key={node.id} value={node.id}>
                    {node.label || node.id.substring(0, 8)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
              <Button
                variant="outlined"
                size="small"
                onClick={onCancelEdit}
              >
                Cancel
              </Button>
              <Button
                variant="contained"
                size="small"
                onClick={onSaveEdit}
              >
                Save
              </Button>
            </Box>
          </Box>
        ) : (
          <>
            {/* Render message content only if it's a string and not a tool message */}
            {message.role !== 'tool' && typeof message.content === 'string' && (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={MARKDOWN_COMPONENTS}
              >
                {message.content}
              </ReactMarkdown>
            )}
            {/* Multipart content (text + images): a user turn that carried a
                pasted/attached image is stored as an OpenAI content-part
                array. Render text parts as markdown and image_url parts as
                inline images. */}
            {message.role !== 'tool' && Array.isArray(message.content) && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {(message.content as any[]).map((part, partIndex) => {
                  if (part?.type === 'text') {
                    return (
                      <ReactMarkdown key={partIndex} remarkPlugins={[remarkGfm]}>
                        {part.text}
                      </ReactMarkdown>
                    );
                  }
                  if (part?.type === 'image_url' && part.image_url?.url) {
                    return (
                      <img
                        key={partIndex}
                        src={part.image_url.url}
                        alt={`Image ${partIndex + 1}`}
                        style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }}
                      />
                    );
                  }
                  return null;
                })}
              </Box>
            )}
            {/* Fallback for non-string, non-array content (e.g., assistant message with only tool calls) */}
            {message.role !== 'tool' && typeof message.content !== 'string' && !Array.isArray(message.content) && !hasToolCalls(message) && (
               <Typography variant="body2" fontStyle="italic" color="text.secondary">
                 [No text content]
               </Typography>
            )}
          </>
        )}

        {/* Handoffs: render each as a slim "→ Target" marker rather than an empty
            tool accordion (they usually carry no args and just clutter the chat).
            #95 (follow-up): also render handoff markers hoisted from suppressed
            tool-call-only messages in the same assistant run, so a handoff whose
            own bubble was folded away still shows its routing on the anchor. */}
        {(() => {
          const ownHandoffs = hasToolCalls(message)
            ? message.tool_calls.filter((tc) => isHandoffToolName(tc.function.name))
            : [];
          const allHandoffs = [...ownHandoffs, ...(hoistedHandoffs ?? [])];
          // Restyled (issue #134): a proper outlined chip instead of small grey
          // italic text, so a routing handoff reads as a distinct, compact
          // element rather than looking like an error/aside.
          return (
            <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {allHandoffs.map((toolCall, hIndex) => (
                <Chip
                  key={toolCall.id || `handoff-${message.id}-${hIndex}`}
                  size="small"
                  variant="outlined"
                  color="secondary"
                  icon={<ArrowRightAltIcon fontSize="small" />}
                  label={`Handoff → ${handoffTargetLabel(toolCall.function.name, availableNodes)}`}
                  sx={{ maxWidth: '100%', fontWeight: 500 }}
                />
              ))}
            </Box>
          );
        })()}

        {/* #95: merged tool-call timeline. The old vertical stack of tool-call
            accordions (plus the separate downstream tool-result bubbles) is
            replaced by one horizontal timeline at the bottom of the assistant
            bubble; clicking a node reveals that call's parameters AND its result
            together. Pairs are handoff-filtered and computed by the container. */}
        {toolCallPairs && toolCallPairs.length > 0 && (
          <ToolCallTimeline pairs={toolCallPairs} messageId={message.id} />
        )}

        {/* Display tool call result for tool messages. Handoff results are the
            meaningless `{handoff:true}` blob — suppressed; the marker above says it all. */}
        {message.role === 'tool' && message.tool_call_id && !isHandoffResult(message) && (
          <Box>
            <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary', mb: 1 }}>
              <TerminalIcon fontSize="small" sx={{ mr: 1 }} />
              The tool responded to the assistant
            </Typography>

            <Accordion
              defaultExpanded={false} // dont Auto-expand the tool result
              sx={{ mb: 0.5, '&:before': { display: 'none' }, boxShadow: 'none', bgcolor: 'rgba(0, 0, 0, 0.02)' }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <TerminalIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
                  <Typography variant="subtitle2">Tool Result</Typography>
                  <Chip
                    label={`ID: ${message.tool_call_id.substring(0, 8)}...`}
                    size="small" color="default" variant="outlined"
                    sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                  />
                  {/* Add Toggle Switch */}
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={showRaw}
                        onChange={(e) => onToggleRaw(message.id, e.target.checked)}
                        onClick={(e) => e.stopPropagation()} // Prevent accordion toggle on switch click
                      />
                    }
                    label="Raw"
                    sx={{ mr: 1, ml: 'auto', '& .MuiTypography-root': { fontSize: '0.75rem' } }}
                    onClick={(e) => e.stopPropagation()} // Prevent accordion toggle on label click
                  />
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0, pb: 1, overflow: 'hidden' }}>
                {/* #95: rendering shared with the merged timeline via ToolResultView. */}
                <ToolResultView content={message.content} showRaw={showRaw} />
              </AccordionDetails>
            </Accordion>
          </Box>
        )}

        {/* Display attachments if any */}
        {message.attachments && message.attachments.length > 0 && (
          <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Attachments:
            </Typography>

            {message.attachments.map((attachment) => (
              attachment.type === 'image' ? (
                <Box key={attachment.id} sx={{ mb: 0.5 }}>
                  <img
                    src={attachment.content}
                    alt={attachment.originalName || 'image attachment'}
                    style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }}
                  />
                </Box>
              ) : (
                <Box
                  key={attachment.id}
                  sx={{ display: 'flex', alignItems: 'center', p: 1, borderRadius: 1, bgcolor: 'rgba(0, 0, 0, 0.04)', mb: 0.5 }}
                >
                  {attachment.type === 'document' ? (
                    <AttachFileIcon fontSize="small" sx={{ mr: 1 }} />
                  ) : (
                    <MicIcon fontSize="small" sx={{ mr: 1 }} />
                  )}
                  {/* Ensure attachment names wrap */}
                  <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
                    {attachment.originalName || `${attachment.type} attachment`}
                  </Typography>
                </Box>
              )
            ))}
          </Box>
        )}
      </Paper>
    </Box>
  );
});

const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  pendingToolCalls, // Destructure new prop
  availableNodes = [], // Destructure with default empty array
  conversationId,
  onToggleDisabled,
  onSplitConversation,
  onEditMessage,
  onApproveToolCall, // Destructure new prop
  onRejectToolCall // Destructure new prop
}) => {
  // --- Render window (long-conversation performance) ---
  const [visibleCount, setVisibleCount] = useState<number>(MESSAGES_WINDOW_INITIAL);
  useEffect(() => {
    setVisibleCount(MESSAGES_WINDOW_INITIAL);
  }, [conversationId]);

  const totalCount = Array.isArray(messages) ? messages.length : 0;
  const hiddenCount = Math.max(0, totalCount - visibleCount);
  const visibleMessages = useMemo(
    () => (Array.isArray(messages) ? (hiddenCount > 0 ? messages.slice(hiddenCount) : messages) : []),
    [messages, hiddenCount]
  );

  // #95 (follow-up): group each contiguous assistant run's (non-handoff) tool
  // calls onto ONE anchor bubble — the run's narration message — so the
  // Claude-subscription split-message shape (narration, then one empty
  // tool-call message per call) renders as a single combined timeline instead
  // of a standalone bubble per call. Computed over the FULL list (not just the
  // window) so grouping still holds across the window boundary; standalone
  // tool-result bubbles a timeline consumed are skipped in the loop below.
  const {
    pairsByAnchorId,
    handoffsByAnchorId,
    consumedToolCallIds,
    groups,
  } = useMemo(() => groupToolCallsByAnchor(messages), [messages]);

  // #134: the set of tool_call_ids belonging to handoff assistant calls. Their
  // `role:'tool'` results are suppressed regardless of body shape (not just the
  // exact `{handoff:true}` blob), so a handoff never leaves a stray result
  // bubble cluttering the transcript.
  const handoffResultToolCallIds = useMemo(() => collectHandoffToolCallIds(messages), [messages]);

  // Ids currently mounted (the render window is a suffix of the message list).
  const visibleIdSet = useMemo(
    () => new Set(visibleMessages.map((m) => m.id)),
    [visibleMessages]
  );

  // Resolve the grouping to concrete per-message render instructions, applying
  // the window-boundary fallback: if an anchor is scrolled out of view while
  // its hoisted tool-call messages are still visible, promote the earliest
  // visible group member to host the timeline so it never silently disappears.
  const { renderPairsById, renderHandoffsById, suppressedIds } = useMemo(() => {
    const renderPairsById = new Map<string, ToolCallPair<ChatMessage>[]>();
    const renderHandoffsById = new Map<string, OpenAI.ChatCompletionMessageToolCall[]>();
    const suppressedIds = new Set<string>();
    for (const group of groups) {
      const pairs = pairsByAnchorId.get(group.anchorId) ?? [];
      const handoffs = handoffsByAnchorId.get(group.anchorId) ?? [];
      const effectiveId = group.memberIds.find((id) => visibleIdSet.has(id)) ?? group.anchorId;
      if (pairs.length > 0) renderPairsById.set(effectiveId, pairs);
      if (handoffs.length > 0) renderHandoffsById.set(effectiveId, handoffs);
      for (const id of group.hoistedIds) {
        if (id !== effectiveId) suppressedIds.add(id);
      }
    }
    return { renderPairsById, renderHandoffsById, suppressedIds };
  }, [groups, pairsByAnchorId, handoffsByAnchorId, visibleIdSet]);

  // Auto-scroll is owned by the parent (Chat/index.tsx), which holds the scroll
  // container ref and implements position-aware stick-to-bottom + a jump-to-latest
  // button. This component no longer scrolls on its own.

  // Message menu state
  const [menuAnchorEl, setMenuAnchorEl] = React.useState<null | HTMLElement>(null);
  const [activeMessageId, setActiveMessageId] = React.useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = React.useState<string | null>(null);
  const [isEditing, setIsEditing] = React.useState<boolean>(false);
  const [editContent, setEditContent] = React.useState<string>('');
  const [editNodeId, setEditNodeId] = React.useState<string | null>(null);
  // State to manage raw view toggle for each tool message
  const [showRawToolResult, setShowRawToolResult] = React.useState<Record<string, boolean>>({});

  // Stable callbacks handed to every (memoized) bubble.
  const handleMenuOpen = useCallback((event: React.MouseEvent<HTMLElement>, messageId: string) => {
    log.debug(`handleMenuOpen called with messageId: ${messageId}`);
    setMenuAnchorEl(event.currentTarget);
    setActiveMessageId(messageId);
  }, []);

  const handleToggleRaw = useCallback((messageId: string, checked: boolean) => {
    setShowRawToolResult(prev => ({ ...prev, [messageId]: checked }));
  }, []);

  const handleEditContentChange = useCallback((content: string) => {
    setEditContent(content);
  }, []);

  const handleEditNodeChange = useCallback((nodeId: string) => {
    // Always use the string value, never null
    setEditNodeId(nodeId);
  }, []);

  const handleMenuClose = () => {
    setMenuAnchorEl(null);
    setActiveMessageId(null);
  };

  const handleToggleDisabled = () => {
    if (activeMessageId) {
      onToggleDisabled(activeMessageId);
      handleMenuClose();
    }
  };

  const handleSplitConversation = () => {
    if (activeMessageId) {
      onSplitConversation(activeMessageId);
      handleMenuClose();
    }
  };

  const handleStartEditing = () => {
    if (activeMessageId) {
      const message = messages.find(m => m.id === activeMessageId);
      // Ensure content is a string before setting it for editing
      if (message && message.role === 'user' && typeof message.content === 'string') {
        setEditContent(message.content);
        // Use existing processNodeId or first available node if any, never null
        setEditNodeId(message.processNodeId || (availableNodes.length > 0 ? availableNodes[0].id : ""));
        setEditingMessageId(activeMessageId);
        setIsEditing(true);
      }
      handleMenuClose();
    }
  };

  const handleSaveEdit = () => {
    if (editingMessageId && onEditMessage) {
      // Always pass the string value of editNodeId, never null
      onEditMessage(editingMessageId, editContent, editNodeId || "");
      setIsEditing(false);
      setEditingMessageId(null);
      setEditNodeId(null);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditingMessageId(null);
    setEditNodeId(null);
  };

  // Resolve node ids to display labels once per availableNodes change.
  const nodeLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of availableNodes) {
      map.set(node.id, node.label);
    }
    return map;
  }, [availableNodes]);

  // Find the active message *before* rendering the Menu
  // This avoids potential state timing issues within the IIFE
  const activeMsgForMenu = useMemo(() => {
    if (!activeMessageId) return null;
    return messages.find(m => m.id === activeMessageId) || null;
  }, [activeMessageId, messages]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Older messages are kept out of the DOM until requested */}
      {hiddenCount > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setVisibleCount(count => count + MESSAGES_WINDOW_STEP)}
          >
            Show earlier messages ({hiddenCount} more)
          </Button>
        </Box>
      )}

      {visibleMessages.map((message, index) => {
        // Handoff tool results are the meaningless `{handoff:true}` blob; the
        // "Handoff to X" marker on the paired assistant call already conveys the
        // routing, so skip the result entirely rather than render an empty bubble.
        if (isHandoffResult(message)) return null;
        // #134: also suppress a handoff result whose body is NOT the exact
        // `{handoff:true}` blob, matched via its paired handoff tool-call id.
        if (
          message.role === 'tool' &&
          typeof message.tool_call_id === 'string' &&
          handoffResultToolCallIds.has(message.tool_call_id)
        ) {
          return null;
        }
        // #95: a tool result that was merged into an assistant timeline is not
        // rendered as its own bubble. Orphan results (parent call outside the
        // window / missing) are NOT consumed, so they fall through to the legacy
        // standalone tool bubble below and nothing silently disappears.
        if (
          message.role === 'tool' &&
          typeof message.tool_call_id === 'string' &&
          consumedToolCallIds.has(message.tool_call_id)
        ) {
          return null;
        }
        // #95 (follow-up): this assistant message's tool calls were hoisted onto
        // a still-visible anchor; suppress its now-empty standalone bubble.
        if (suppressedIds.has(message.id)) return null;
        const isThisEditing = isEditing && message.id === editingMessageId;
        return (
          <MessageBubble
            key={message.id || `msg-${hiddenCount + index}`} // Use message.id as key, fallback to global index
            message={message}
            nodeLabel={message.processNodeId ? nodeLabelById.get(message.processNodeId) : undefined}
            availableNodes={availableNodes}
            showRaw={!!showRawToolResult[message.id]}
            toolCallPairs={renderPairsById.get(message.id)}
            hoistedHandoffs={renderHandoffsById.get(message.id)}
            edit={isThisEditing ? { content: editContent, nodeId: editNodeId } : null}
            onMenuOpen={handleMenuOpen}
            onToggleRaw={handleToggleRaw}
            onEditContentChange={handleEditContentChange}
            onEditNodeChange={handleEditNodeChange}
            onSaveEdit={isThisEditing ? handleSaveEdit : undefined}
            onCancelEdit={isThisEditing ? handleCancelEdit : undefined}
          />
        );
      })}

      {/* Menu for message actions */}
      <Menu
        anchorEl={menuAnchorEl}
        open={Boolean(menuAnchorEl)}
        onClose={handleMenuClose}
      >
        {/* Use pre-calculated activeMsgForMenu */}
        {activeMsgForMenu && (() => {
          log.debug('Entering menu item rendering logic', { activeMessageId });
          log.debug('Active message object for menu:', activeMsgForMenu);
          log.debug('Active message role for menu:', activeMsgForMenu?.role);
          try {
            const hasOnEditMessageProp = !!onEditMessage;
            const shouldShowEdit = activeMsgForMenu.role === 'user' && hasOnEditMessageProp;

            log.debug('Rendering Edit Message menu item check', {
              activeMessageId: activeMsgForMenu.id, // Use ID from the message object
              messageRole: activeMsgForMenu.role,
              onEditMessagePropType: typeof onEditMessage,
              hasOnEditMessageProp,
              shouldShowEdit
            });

            if (shouldShowEdit) {
              return (
                <MenuItem onClick={handleStartEditing}>
                  <ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>
                  <ListItemText>Edit Message</ListItemText>
                </MenuItem>
              );
            }
            return null;
          } catch (error) {
            log.error('Error rendering Edit Message menu item', { error });
            return null; // Return null on error
          }
        })()}

        {/* Other Menu Items - Use activeMsgForMenu if needed, or keep original logic if activeMessageId state is sufficient */}
        <MenuItem onClick={handleToggleDisabled}>
          <ListItemIcon><BlockIcon fontSize="small" /></ListItemIcon>
          <ListItemText>
            {/* Use activeMsgForMenu here as well for consistency */}
            {activeMsgForMenu?.disabled ? 'Enable Message' : 'Disable Message'}
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={handleSplitConversation}>
          <ListItemIcon><CallSplitIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Split Conversation Here</ListItemText>
        </MenuItem>
      </Menu>


      {/* Display Pending Tool Calls for Approval */}
      {/* Add null check for pendingToolCalls before accessing length */}
      {pendingToolCalls && pendingToolCalls.length > 0 && (
        <Paper
          elevation={2}
          sx={{ p: 2, mt: 2, bgcolor: 'warning.light', border: '1px solid', borderColor: 'warning.main', borderRadius: 2 }}
        >
          <Typography variant="h6" sx={{ mb: 1, display: 'flex', alignItems: 'center' }}>
            <HandymanIcon sx={{ mr: 1 }} /> Tool Approval Required
          </Typography>
          <Typography variant="body2" sx={{ mb: 2 }}>
            The assistant wants to use the following tool(s). Please approve or reject each request.
          </Typography>
          {pendingToolCalls.map((toolCall, ptcIndex) => { // Added index for key
            const toolName = displayToolName(toolCall.function.name);
            let formattedArgs = toolCall.function.arguments;
            try {
              const parsedArgs = JSON.parse(toolCall.function.arguments);
              formattedArgs = JSON.stringify(parsedArgs, null, 2);
            } catch (e) { /* Use original string */ }

            return (
              <Accordion
                key={toolCall.id || `ptc-${ptcIndex}`} // Use toolCall.id as key
                defaultExpanded={true} // Expand by default for approval
                sx={{ mb: 1, '&:before': { display: 'none' }, boxShadow: 1 }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                    <HandymanIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
                    <Typography variant="subtitle2" sx={{ fontWeight: 'bold', flexGrow: 1 }}>
                      {toolName}
                    </Typography>
                    <Chip
                      label={`ID: ${toolCall.id ? toolCall.id.substring(0, 8) : 'N/A'}...`}
                      size="small" variant="outlined"
                      sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                    />
                  </Box>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>
                  <Box component="pre" sx={{
                    bgcolor: 'action.hover', p: 1, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace',
                    fontSize: '0.75rem', my: 0.5, maxHeight: '150px', whiteSpace: 'pre-wrap', // Ensure wrapping
                    wordBreak: 'break-word', // Ensure breaking
                  }}>
                    {formattedArgs}
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
                    <Button
                      variant="outlined" color="error" size="small" startIcon={<ThumbDownIcon />}
                      onClick={() => onRejectToolCall && onRejectToolCall(toolCall.id)}
                      disabled={!onRejectToolCall}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="contained" color="success" size="small" startIcon={<ThumbUpIcon />}
                      onClick={() => onApproveToolCall && onApproveToolCall(toolCall.id)}
                      disabled={!onApproveToolCall}
                    >
                      Approve
                    </Button>
                  </Box>
                </AccordionDetails>
              </Accordion>
            );
          })}
        </Paper>
      )}
    </Box>
  );
};

export default ChatMessages;
