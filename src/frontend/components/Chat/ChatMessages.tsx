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
  Switch,
  FormControlLabel,
  Collapse,
  CircularProgress,
  TextField,
  Select,
  Checkbox,
  Radio,
  RadioGroup,
  FormControl,
  FormLabel,
  InputLabel,
  FormHelperText,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import ReactMarkdown from 'react-markdown';
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
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ThumbUpIcon from '@mui/icons-material/ThumbUp'; // For Approve
import ThumbDownIcon from '@mui/icons-material/ThumbDown'; // For Reject
import ArrowRightAltIcon from '@mui/icons-material/ArrowRightAlt'; // For handoff marker
import RestoreIcon from '@mui/icons-material/Restore';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import LinkRoundedIcon from '@mui/icons-material/LinkRounded';
import { ChatMessage } from './index';
import { magicLinkUrl } from '@/frontend/utils/magicLink';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import { copyText } from '@/frontend/components/shared/CopyLinkButton';
import RevertPreviewDialog from './RevertPreviewDialog';
import { FEATURES } from '@/config/features';
import type { QueuedMessage } from './chatQueue'; // #221: inline pending bubbles
import OpenAI from 'openai'; // Import OpenAI types for tool calls
import { displayToolName } from '@/utils/shared/common'; // Friendly tool-name decode
import { HANDOFF_TOOL_PREFIX, slugifyHandoffTarget } from '@/shared/utils/handoffNaming';
import { type ToolCallPair, groupToolCallsByAnchor, collectHandoffToolCallIds } from './toolCallPairing'; // #95: merge tool call + result onto the narration anchor
import type { FlujoFunctionToolCall } from '@/shared/types/openai';
import McpAppFrame from './McpAppFrame'; // #97: read-only, sandboxed MCP App (ui:// resource) renderer
import { createLogger } from '@/utils/logger'; // Import the logger
import type { LazyToolPayloadRef, McpAppModelContext } from '@/shared/types/chat';
import { mediaDataUrl, type ModelMediaPart } from '@/shared/types/model/media';
import { summarizeTokenMeter } from '@/shared/utils/tokenUsage';
import {
  MARKDOWN_LINK_COMPONENTS,
  markdownLinkVars,
} from '@/frontend/components/shared/MarkdownLink';
import { useI18n } from '@/frontend/contexts/I18nContext';
import SubflowLaneChip from './SubflowLaneChip';
import { formatPartialJson } from '@/frontend/utils/partialJson';
import {
  groupMcpAppOccurrences,
  latestMcpAppResultIdsByResource,
} from './mcpAppProjection';
import { ChatMarkdownContent } from './ChatMarkdown';

const log = createLogger('frontend/components/Chat/ChatMessages'); // Initialize logger

// How many messages render initially / how many more each expander click adds.
// Long conversations previously rendered EVERY bubble on every update; the
// window keeps steady-state work proportional to what is actually on screen.
const MESSAGES_WINDOW_INITIAL = 50;
const MESSAGES_WINDOW_STEP = 200;

/** Shape of a pending elicitation request surfaced from the `run:awaiting_elicitation` SSE event. */
export interface PendingElicitation {
  elicitationId: string;
  message: string;
  requestedSchema: Record<string, unknown>;
}

/** One prompt of a model-initiated `question` tool call (issue #258). */
export interface PendingQuestionPrompt {
  prompt: string;
  options: string[];
  multiple?: boolean;
  custom?: boolean;
}

/** Shape of a pending question surfaced from the `run:awaiting_question` SSE event. */
export interface PendingQuestion {
  questionId: string;
  questions: PendingQuestionPrompt[];
}

interface ChatMessagesProps {
  messages: ChatMessage[];
  pendingToolCalls?: OpenAI.ChatCompletionMessageFunctionToolCall[] | null; // Add pending calls prop
  /** Active elicitation request from the server, if any. */
  pendingElicitation?: PendingElicitation | null;
  availableNodes?: { id: string; label: string }[]; // Add available nodes for dropdown
  /** Resets the render window when the user switches conversations. */
  conversationId?: string;
  /** Id of the message currently being edited in the ChatInput (or null). */
  editingMessageId?: string | null;
  onToggleDisabled: (messageId: string) => void;
  /** Split off the head of the thread: start → the picked message (inclusive). */
  onSplitConversation: (messageId: string) => void;
  /**
   * Mirror of `onSplitConversation`: split off the TAIL of the thread — the
   * picked message → end. Optional so read-only hosts (debugger, flow
   * generator preview) can omit it and simply not show the entry.
   */
  onSplitConversationFromHere?: (messageId: string) => void;
  /** Called after a confirmed message-scoped worktree revert. */
  onRevertToHere?: (messageId: string) => void;
  /** Start editing a message — opens the editor in the ChatInput, not inline. */
  onBeginEditMessage?: (messageId: string) => void;
  onApproveToolCall?: (toolCallId: string, always?: boolean) => void; // Add approve handler prop
  onRejectToolCall?: (toolCallId: string, always?: boolean, feedback?: string) => void; // Add reject handler prop (feedback: issue #247)
  onCancelToolCall?: (toolCallId: string) => void; // Issue #357: cancel one in-flight tool call
  /** Submit elicitation form — called with the collected field values. */
  onSubmitElicitation?: (elicitationId: string, content: Record<string, string | number | boolean | string[]>) => void;
  /** Cancel the pending elicitation request. */
  onCancelElicitation?: (elicitationId: string) => void;
  /** Active model-initiated question (issue #258), if any. */
  pendingQuestion?: PendingQuestion | null;
  /** Answer a pending question — one array of selected labels per question, in order. */
  onAnswerQuestion?: (questionId: string, answers: string[][]) => void;
  /** Decline a pending question (the user chose not to answer). */
  onDeclineQuestion?: (questionId: string) => void;
  /** Stable immediate-turn channel for an MCP App's `ui/message` request. */
  onAppMessage?: (text: string) => boolean | Promise<boolean>;
  /**
   * Stable future-turn-only channel for `ui/update-model-context`. This must
   * never submit a chat message.
   */
  onUpdateModelContext?: (
    appKey: string,
    context: McpAppModelContext,
  ) => boolean | Promise<boolean>;
  /** Register inline Views so conversation navigation can await teardown. */
  onRegisterAppTeardown?: (
    registrationKey: string,
    teardown: (() => Promise<void>) | null,
  ) => void;
  /**
   * #216: route a tool result's `ui://` app into the docked canvas surface
   * instead of rendering it inline. Clicking the bubble launcher is the same
   * click-to-mount consent gate for every server. When omitted, apps render
   * inline as before.
   */
  onOpenInCanvas?: (info: CanvasLaunchInfo) => void;
  /** Allowed MCP Apps reveal themselves unless the user opted into click-only launch. */
  autoOpenMcpApps?: boolean;
  /** Result ids observed after initial conversation hydration and eligible for one auto-launch. */
  autoOpenMcpAppResultIds?: ReadonlySet<string>;
  /** Conversation-scoped App identities the user explicitly closed. */
  dismissedMcpAppKeys?: ReadonlySet<string>;
  /**
   * #375: true while the user has collapsed the whole canvas dock — blocks
   * every AUTOMATIC (non-user-initiated) open until they manually re-open
   * something or expand the dock again.
   */
  autoOpenSuppressed?: boolean;
  /** Clear a persisted dismissal when the user explicitly opens a launcher. */
  onMcpAppManualOpen?: (appKey: string) => void;
  /**
   * #374: a specific message to scroll to and briefly highlight (from a
   * `?conversation=<id>&message=<id>` magic link). Expands the render window
   * if the target message is currently outside it.
   */
  anchorMessageId?: string | null;
  /**
   * #221: messages the user submitted while a run was in flight (queued).
   * Rendered as dimmed pending bubbles after the last real message so the user
   * can see them immediately instead of them appearing only as tiny chips above
   * the input.
   */
  queuedMessages?: QueuedMessage[];
  /**
   * Why the queue is held (chatQueue.drainHoldReason) — shown on the pending
   * bubbles instead of the "Queued" spinner, so a message parked behind an
   * errored/stopped/paused run doesn't keep pretending it is about to send.
   */
  queueHoldReason?: string | null;
}

/** #216: payload handed up when the user opens a tool's app in the canvas. */
export interface CanvasLaunchInfo {
  serverName: string;
  uri: string;
  toolName?: string;
  toolArgs?: string;
  resultContent?: string;
  /** Cancellation outcome sent instead of the result, when present. */
  cancelledReason?: string;
  /** Whether the tool invocation failed. */
  isError?: boolean;
  /** Stable identity of the selected tool-result delivery. */
  updateId?: string | number;
  /** True when this handoff originated from the live-result auto-open policy. */
  automatic?: boolean;
  /**
   * #375: false when this frame already failed its post-handshake validation
   * (unsupported display mode / access revoked). Defensive guard so an
   * errored frame can never be routed into the canvas, even from a stale
   * closure. Undefined is treated as healthy.
   */
  healthy?: boolean;
}

// Type guard to check if a message has tool_calls
function hasToolCalls(message: ChatMessage): message is ChatMessage & { tool_calls: FlujoFunctionToolCall[] } {
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

/** Plain text represented by a message body, for the header copy action. */
export function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      return typeof record.content === 'string' ? record.content : '';
    })
    .filter(Boolean)
    .join('\n');
}

const MessageMediaView: React.FC<{ media: ModelMediaPart[] }> = ({ media }) => {
  const { t } = useI18n();
  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1 }}>
    {media.map((part, index) => {
      const src = mediaDataUrl(part);
      const key = part.resourceUri ?? part.url ?? `${part.type}-${index}`;
      if (!src) return null;
      if (part.type === 'image') {
        return (
          <Box
            key={key}
            component="img"
            src={src}
            alt={part.name ?? t('chat.messages.generatedImage', { number: index + 1 })}
            sx={{ maxWidth: '100%', height: 'auto', borderRadius: 1 }}
          />
        );
      }
      if (part.type === 'audio') {
        return (
          <Box key={key}>
            <Box component="audio" controls src={src} sx={{ width: '100%' }} />
            {part.transcript && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {part.transcript}
              </Typography>
            )}
          </Box>
        );
      }
      if (part.type === 'video') {
        return (
          <Box
            key={key}
            component="video"
            controls
            src={src}
            sx={{ maxWidth: '100%', maxHeight: 560, borderRadius: 1 }}
          />
        );
      }
      return (
        <Button
          key={key}
          component="a"
          href={src}
          download={part.name || true}
          target="_blank"
          rel="noopener noreferrer"
          variant="outlined"
          size="small"
          startIcon={<AttachFileIcon />}
          sx={{ alignSelf: 'flex-start' }}
        >
          {part.name ?? t('chat.messages.downloadFile')}
        </Button>
      );
    })}
  </Box>;
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
          borderColor: (theme) => theme.palette.divider,
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
                    return <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} components={MARKDOWN_LINK_COMPONENTS}>{item.text}</ReactMarkdown>;
                  } else if (item.type === 'image' && item.data && item.mimeType) {
                    return (
                      // MCP tool images are data URLs, which the Next image optimizer does not support.
                      // eslint-disable-next-line @next/next/no-img-element
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
                  } else if (item.type === 'video' && item.data && item.mimeType) {
                    return (
                      <video
                        key={index}
                        controls
                        src={`data:${item.mimeType};base64,${item.data}`}
                        style={{ maxWidth: '100%', maxHeight: '560px', marginTop: '8px' }}
                      >
                        Your browser does not support the video element.
                      </video>
                    );
                  } else {
                    return (
                      <Box
                        key={index}
                        component="pre"
                        sx={{
                          whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.8rem', p: 1,
                          borderRadius: 1, border: 1, borderColor: (theme) => theme.palette.divider,
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
          return <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_LINK_COMPONENTS}>{`\`\`\`json\n${JSON.stringify(parsedContent, null, 2)}\n\`\`\``}</ReactMarkdown>;
        } catch (e) {
          // Not JSON: render the raw string as markdown.
          return <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_LINK_COMPONENTS}>{content}</ReactMarkdown>;
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

const toolPayloadRequestCache = new Map<string, Promise<string>>();

function requestToolPayload(payload: LazyToolPayloadRef): Promise<string> {
  let request = toolPayloadRequestCache.get(payload.uri);
  if (!request) {
    request = fetch(payload.href).then(async (response) => {
      if (!response.ok) throw new Error(`Tool payload request failed (${response.status})`);
      return response.text();
    });
    toolPayloadRequestCache.set(payload.uri, request);
    // Deduplicate only concurrent reads. Retaining resolved multi-megabyte
    // strings here would turn expansion into a new long-lived memory cache;
    // the mounted panel owns the value and the browser HTTP cache handles a
    // later reopen.
    request.then(
      () => { if (toolPayloadRequestCache.get(payload.uri) === request) toolPayloadRequestCache.delete(payload.uri); },
      () => { if (toolPayloadRequestCache.get(payload.uri) === request) toolPayloadRequestCache.delete(payload.uri); },
    );
  }
  return request;
}

function useLazyToolPayload(payload: LazyToolPayloadRef | undefined, fallback: string): {
  value: string;
  loading: boolean;
  error: boolean;
} {
  const [state, setState] = useState({
    value: fallback,
    loading: Boolean(payload),
    error: false,
  });
  useEffect(() => {
    let active = true;
    setState({ value: fallback, loading: Boolean(payload), error: false });
    if (!payload) return () => { active = false; };
    requestToolPayload(payload).then(
      (value) => { if (active) setState({ value, loading: false, error: false }); },
      () => { if (active) setState({ value: fallback, loading: false, error: true }); },
    );
    return () => { active = false; };
  }, [fallback, payload]);
  return state;
}

const DeferredToolResultView: React.FC<{
  content: unknown;
  payload?: LazyToolPayloadRef;
  showRaw: boolean;
}> = ({ content, payload, showRaw }) => {
  const { t } = useI18n();
  const fallback = typeof content === 'string' ? content : '[Invalid tool content]';
  const loaded = useLazyToolPayload(payload, fallback);
  if (loaded.loading) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CircularProgress size={14} thickness={6} /> {t('chat.messages.loadingPayload')}
      </Typography>
    );
  }
  return (
    <Box>
      {loaded.error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mb: 0.5 }}>
          {t('chat.messages.payloadLoadFailed')}
        </Typography>
      )}
      <ToolResultView content={loaded.value} showRaw={showRaw} />
    </Box>
  );
};

const ToolCallDetails: React.FC<{
  pair: ToolCallPair<ChatMessage>;
  showRaw: boolean;
  onRawChange: (showRaw: boolean) => void;
  /** Issue #357: cancel THIS still-running tool call (confirmed first). */
  onCancelToolCall?: (toolCallId: string) => void;
}> = ({ pair, showRaw, onRawChange, onCancelToolCall }) => {
  const { t } = useI18n();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const args = useLazyToolPayload(pair.argumentPayload, pair.toolCall.function.arguments);
  const pairUi = pair.result?.ui;
  const launchInfo = pairUi?.uri && pairUi.serverName ? {
    serverName: pairUi.serverName,
    uri: pairUi.uri,
    toolName: pairUi.toolName ?? pair.toolCall.function.name,
    toolArgs: pairUi.toolArgs ?? args.value,
  } : null;
  const toolTesterDestination = launchInfo?.toolName
    ? { serverName: launchInfo.serverName, toolName: launchInfo.toolName }
    : pair.mcpDestination;
  const openInToolTester = toolTesterDestination && !args.loading
    ? () => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(launchInfo?.toolArgs ?? args.value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parsedArgs = parsed;
        } catch { /* malformed arguments safely prefill as an empty object */ }
        const query = new URLSearchParams({
          server: toolTesterDestination.serverName,
          tool: toolTesterDestination.toolName,
          args: JSON.stringify(parsedArgs),
        });
        window.location.assign(withWorkspaceUrl(`/mcp?${query.toString()}`));
      }
    : undefined;
  // This preview is intentionally display-only; execution and approval continue
  // to use the authoritative raw argument string.
  const formattedArgs = useMemo(() => formatPartialJson(args.value), [args.value]);

  return (
    <Box sx={{ mt: 1, p: 1, borderRadius: 1, bgcolor: 'rgba(0, 0, 0, 0.03)' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <HandymanIcon fontSize="small" sx={{ mr: 0.5, color: 'primary.main' }} />
        <Typography variant="caption" sx={{ fontWeight: 'bold' }}>{t('chat.messages.parameters')}</Typography>
        <Chip
          label={`ID: ${pair.toolCall.id ? pair.toolCall.id.substring(0, 8) : 'N/A'}...`}
          size="small" color="default" variant="outlined"
          sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
        />
        {!formattedArgs.complete && (
          <Chip label="streaming…" size="small" color="primary" sx={{ ml: 1, height: 20, fontSize: '0.7rem' }} />
        )}
      </Box>
      {args.loading ? (
        <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 1 }}>
          <CircularProgress size={14} thickness={6} /> {t('chat.messages.loadingPayload')}
        </Typography>
      ) : (
        <>
          {args.error && (
            <Typography variant="caption" color="error">{t('chat.messages.payloadLoadFailed')}</Typography>
          )}
          <Box component="pre" sx={{
            bgcolor: 'action.hover', p: 1, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace',
            fontSize: '0.75rem', my: 0.5, maxHeight: '150px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {formattedArgs.text}
          </Box>
          <Typography variant="caption" color="text.secondary">
            {args.value.length.toLocaleString()} characters
          </Typography>
        </>
      )}
      {openInToolTester && (
        <Button size="small" variant="outlined" startIcon={<PlayArrowIcon />} onClick={openInToolTester} sx={{ mt: 0.5 }}>
          {t('chat.messages.toolTester')}
        </Button>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', mt: 1, mb: 0.5 }}>
        <TerminalIcon fontSize="small" sx={{ mr: 0.5, color: 'text.secondary' }} />
        <Typography variant="caption" sx={{ fontWeight: 'bold' }}>{t('chat.messages.result')}</Typography>
        {pair.result && (
          <FormControlLabel
            control={<Switch size="small" checked={showRaw} onChange={(event) => onRawChange(event.target.checked)} />}
            label={t('chat.messages.raw')}
            sx={{ ml: 'auto', mr: 0, '& .MuiTypography-root': { fontSize: '0.75rem' } }}
          />
        )}
      </Box>
      {pair.result ? (
        <DeferredToolResultView
          content={pair.result.content}
          payload={pair.resultPayload}
          showRaw={showRaw}
        />
      ) : (
        <Typography variant="body2" fontStyle="italic" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={14} thickness={6} /> {t('chat.messages.waitingTool')}
          {/* Issue #357: a stalling tool call can be aborted on its own, without
              stopping the whole run. Confirmation first, as the issue asks. */}
          {onCancelToolCall && pair.toolCall.id && (
            <Button
              size="small"
              variant="outlined"
              color="warning"
              startIcon={<BlockIcon />}
              disabled={cancelRequested}
              onClick={() => setConfirmCancel(true)}
              sx={{ ml: 1 }}
            >
              {t('chat.messages.cancelTool')}
            </Button>
          )}
        </Typography>
      )}
      <Dialog open={confirmCancel} onClose={() => setConfirmCancel(false)}>
        <DialogTitle>{t('chat.messages.cancelTool')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('chat.messages.cancelToolConfirm')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCancel(false)}>{t('chat.page.cancel')}</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => {
              setConfirmCancel(false);
              setCancelRequested(true);
              onCancelToolCall?.(pair.toolCall.id);
            }}
          >
            {t('chat.messages.cancelToolConfirmAction')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

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
export const ToolCallTimeline: React.FC<{
  pairs: ToolCallPair<ChatMessage>[];
  messageId: string;
  conversationId?: string;
  onAppMessage?: (text: string) => boolean | Promise<boolean>;
  onUpdateModelContext?: (
    appKey: string,
    context: McpAppModelContext,
  ) => boolean | Promise<boolean>;
  onRegisterAppTeardown?: ChatMessagesProps['onRegisterAppTeardown'];
  onOpenInCanvas?: (info: CanvasLaunchInfo) => void;
  autoOpenMcpApps?: boolean;
  autoOpenMcpAppResultIds?: ReadonlySet<string>;
  dismissedMcpAppKeys?: ReadonlySet<string>;
  autoOpenSuppressed?: boolean;
  onMcpAppManualOpen?: (appKey: string) => void;
  /** Conversation-level ownership: only these latest results may host a live View. */
  mcpAppHostResultIds?: ReadonlySet<string>;
  /** Issue #357: cancel a single in-flight tool call. */
  onCancelToolCall?: (toolCallId: string) => void;
}> = ({
  pairs,
  messageId,
  conversationId,
  onCancelToolCall,
  onAppMessage,
  onUpdateModelContext,
  onRegisterAppTeardown,
  onOpenInCanvas,
  autoOpenMcpApps = true,
  autoOpenMcpAppResultIds,
  dismissedMcpAppKeys,
  autoOpenSuppressed,
  onMcpAppManualOpen,
  mcpAppHostResultIds,
}) => {
  const { t, tp } = useI18n();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [rawByKey, setRawByKey] = useState<Record<string, boolean>>({});
  const keyFor = (pair: ToolCallPair<ChatMessage>, index: number) =>
    pair.toolCall.id || `tc-${messageId}-${index}`;
  const appGroups = useMemo(() => groupMcpAppOccurrences(pairs), [pairs]);
  const expandedPairIndex = pairs.findIndex((pair, index) => keyFor(pair, index) === expandedKey);
  const expandedPair = expandedPairIndex >= 0 ? pairs[expandedPairIndex] : undefined;

  return (
    <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', color: 'primary.main', mb: 1 }}>
        <HandymanIcon fontSize="small" sx={{ mr: 1 }} />
        <Typography variant="body2">
          {tp('chat.messages.toolUsed', pairs.length)}
        </Typography>
      </Box>

      {/* Apps are first-class output, not an easter egg inside the tool-detail
          collapse. Per-server MCP Apps permission is already enforced before a
          ui link reaches the transcript; the optional Settings restriction only
          decides whether the live View opens immediately or waits for one click. */}
      {appGroups.filter((group) => (
        !mcpAppHostResultIds
        || Boolean(group.latest.resultMessageId && mcpAppHostResultIds.has(group.latest.resultMessageId))
      )).map((group) => {
        const latest = group.latest;
        const shouldAutoOpen = Boolean(
          autoOpenMcpApps
          && latest.resultMessageId
          && autoOpenMcpAppResultIds?.has(latest.resultMessageId)
          && !dismissedMcpAppKeys?.has(group.key)
          // #375: collapsing the dock is a sticky "stop auto-opening" intent —
          // do not even mount an auto-docking frame while it is in effect.
          && !autoOpenSuppressed,
        );
        const launchInfo: CanvasLaunchInfo = {
          serverName: latest.serverName,
          uri: latest.uri,
          toolName: latest.toolName,
          toolArgs: latest.toolArgs,
          resultContent: latest.resultContent,
          cancelledReason: latest.cancelledReason,
          isError: latest.isError,
          updateId: latest.updateId,
          automatic: shouldAutoOpen,
        };
        return (
          <McpAppFrame
            key={`app-${group.key}`}
            defaultExpanded={shouldAutoOpen}
            autoDock={shouldAutoOpen}
            conversationId={conversationId}
            serverName={launchInfo.serverName}
            uri={launchInfo.uri}
            toolName={launchInfo.toolName}
            toolArgs={launchInfo.toolArgs}
            toolResultContent={launchInfo.resultContent}
            toolCancelledReason={launchInfo.cancelledReason}
            toolIsError={launchInfo.isError}
            toolUpdateId={launchInfo.updateId}
            linkedToolCallCount={group.occurrences.length}
            onAppMessage={onAppMessage}
            onUpdateModelContext={onUpdateModelContext}
            onRegisterTeardown={onRegisterAppTeardown}
            teardownRegistrationKey={`${group.key}::${messageId}`}
            onUserOpen={() => onMcpAppManualOpen?.(group.key)}
            onRequestDock={onOpenInCanvas ? () => onOpenInCanvas(launchInfo) : undefined}
          />
        );
      })}

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
              <Tooltip title={isOpen ? t('chat.messages.hideTool') : t('chat.messages.showTool')}>
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

      {/* Only the open node mounts/parses/fetches its payload. */}
      <Collapse in={Boolean(expandedPair)} unmountOnExit>
        {expandedPair && (
          <ToolCallDetails
            key={expandedKey}
            pair={expandedPair}
            onCancelToolCall={onCancelToolCall}
            showRaw={Boolean(expandedKey && rawByKey[expandedKey])}
            onRawChange={(showRaw) => {
              if (expandedKey) setRawByKey((prev) => ({ ...prev, [expandedKey]: showRaw }));
            }}
          />
        )}
      </Collapse>
    </Box>
  );
};

interface MessageBubbleProps {
  message: ChatMessage;
  conversationId?: string;
  /** Resolved node label for the attribution pill (id shown in the tooltip). */
  nodeLabel?: string;
  /** Stable reference (memoized by the parent) — resolves the attribution pill. */
  availableNodes: { id: string; label: string }[];
  /** Raw/rendered toggle for the LEGACY standalone (orphan) tool-result bubble. */
  showRaw: boolean;
  /**
   * #95: for an assistant message, its ordered non-handoff tool-call/result
   * pairs (computed once by the container). Undefined for other roles or an
   * assistant turn with no non-handoff tool calls.
   */
  toolCallPairs?: ToolCallPair<ChatMessage>[];
  /** #97: stable MCP App -> conversation return channel (see ChatMessagesProps). */
  onAppMessage?: (text: string) => boolean | Promise<boolean>;
  /** Stable MCP App -> future-turn model-context channel. */
  onUpdateModelContext?: (
    appKey: string,
    context: McpAppModelContext,
  ) => boolean | Promise<boolean>;
  onRegisterAppTeardown?: ChatMessagesProps['onRegisterAppTeardown'];
  /** #216: route a tool app to the docked canvas (see ChatMessagesProps). */
  onOpenInCanvas?: (info: CanvasLaunchInfo) => void;
  autoOpenMcpApps?: boolean;
  autoOpenMcpAppResultIds?: ReadonlySet<string>;
  dismissedMcpAppKeys?: ReadonlySet<string>;
  autoOpenSuppressed?: boolean;
  onMcpAppManualOpen?: (appKey: string) => void;
  mcpAppHostResultIds?: ReadonlySet<string>;
  /** Issue #357: cancel a single in-flight tool call. */
  onCancelToolCall?: (toolCallId: string) => void;
  /**
   * #95 (follow-up): handoff tool calls hoisted from suppressed tool-call-only
   * messages in the same assistant run, rendered as slim markers on this anchor
   * bubble (in addition to any handoffs the message owns itself).
   */
  hoistedHandoffs?: OpenAI.ChatCompletionMessageFunctionToolCall[];
  /** True while THIS message is being edited in the ChatInput (dims the bubble). */
  isBeingEdited?: boolean;
  /** #374: true for the message targeted by a `?message=<id>` magic link — briefly highlighted. */
  isAnchor?: boolean;
  onMenuOpen: (event: React.MouseEvent<HTMLElement>, messageId: string) => void;
  onToggleRaw: (messageId: string, checked: boolean) => void;
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
  conversationId,
  nodeLabel,
  availableNodes,
  showRaw,
  toolCallPairs,
  onAppMessage,
  onUpdateModelContext,
  onRegisterAppTeardown,
  onOpenInCanvas,
  autoOpenMcpApps,
  autoOpenMcpAppResultIds,
  dismissedMcpAppKeys,
  autoOpenSuppressed,
  onMcpAppManualOpen,
  mcpAppHostResultIds,
  onCancelToolCall,
  hoistedHandoffs,
  isBeingEdited,
  isAnchor,
  onMenuOpen,
  onToggleRaw,
}) {
  const { t, formatDate: formatLocalizedDate, formatNumber } = useI18n();
  const [orphanToolExpanded, setOrphanToolExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyableText = useMemo(() => messageContentText(message.content), [message.content]);
  const handleCopyMessage = useCallback(async () => {
    const copied = await copyText(copyableText);
    setCopyStatus(copied ? 'copied' : 'failed');
  }, [copyableText]);

  useEffect(() => {
    if (copyStatus === 'idle') return;
    const timeout = window.setTimeout(() => setCopyStatus('idle'), 1500);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  const copyLabel = copyStatus === 'copied'
    ? t('chat.actions.copied')
    : copyStatus === 'failed'
      ? t('chat.actions.copyFailed')
      : t('chat.actions.copy');
  // Subflow steps (depth > 0) render nested: indented per level, marked with a
  // guide line + chip. They are display-only (never sent back as history).
  const depth = message.depth ?? 0;
  return (
    <Box
      data-ask-flujo-message-id={message.id}
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
        // #374: brief highlight for the target of a `?message=<id>` magic link.
        ...(isAnchor && {
          outline: '2px solid',
          outlineColor: 'primary.main',
          borderRadius: 1,
          transition: 'outline-color 2s ease-out',
        }),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
          {message.role === 'user'
            ? t('chat.messages.you')
            : message.role === 'assistant'
              ? t('chat.messages.agent')
              : message.role === 'tool'
                ? t('chat.messages.tool')
                : t('chat.messages.system')} • {typeof message.timestamp === 'number' && !Number.isNaN(message.timestamp)
                  ? formatLocalizedDate(message.timestamp, { hour: '2-digit', minute: '2-digit' })
                  : t('chat.messages.invalidDate')}
        </Typography>

        {message.processNodeId && (
          <Tooltip title={`${nodeLabel ? `${nodeLabel} — ` : ''}${t('chat.messages.processId', { id: message.processNodeId })}`}>
            <Chip
              label={t('chat.messages.node', { node: nodeLabel || `${message.processNodeId.substring(0, 6)}...` })}
              size="small"
              color="primary"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
            />
          </Tooltip>
        )}

        {message.subflowResult && (
          <SubflowLaneChip result={message.subflowResult} />
        )}

        {depth > 0 && (
          <Tooltip title={t('chat.messages.nested', { depth })}>
            <Chip
              label={t('chat.messages.subflowStep')}
              size="small"
              color="secondary"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
            />
          </Tooltip>
        )}

        {message.disabled && (
          <Chip
            label={t('chat.messages.disabled')}
            size="small"
            color="default"
            variant="outlined"
            sx={{ height: 20, fontSize: '0.7rem' }}
          />
        )}

        {message.usage && (() => {
          const meter = summarizeTokenMeter(message.usage);
          return (
            <Tooltip title={t('chat.messages.tokenUsage', {
              prompt: formatNumber(meter.freshPromptTokens),
              completion: formatNumber(meter.completionTokens),
              cached: formatNumber(meter.cacheReadTokens),
              written: formatNumber(meter.cacheWriteTokens),
            })}>
              <Chip
                label={`${formatTokenCount(meter.meterTotalTokens)} tok`}
                size="small"
                color="default"
                variant="outlined"
                sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
              />
            </Tooltip>
          );
        })()}

        {copyableText && (
          <Tooltip title={copyLabel} disableInteractive>
            <IconButton
              size="small"
              onClick={() => void handleCopyMessage()}
              aria-label={copyLabel}
              sx={{ ml: 1 }}
            >
              {copyStatus === 'copied'
                ? <CheckRoundedIcon fontSize="small" color="success" />
                : <ContentCopyRoundedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}

        <IconButton
          size="small"
          onClick={(e) => onMenuOpen(e, message.id)}
          aria-label={t('chat.actions.more')}
          sx={{ ml: copyableText ? 0.25 : 1 }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Box>

      <Paper
        elevation={1}
        sx={(theme) => ({
          p: 2,
          maxWidth: '75vw', // Set max width to 75% of viewport width
          borderRadius: 2,
          // Markdown links read the `--flujo-link-color` var. Accent-filled
          // bubbles (user / system) can't carry a brand tint - a violet link on
          // the violet user bubble was ~1.05:1 contrast in the light modern
          // theme - so there links inherit the bubble's contrast text color and
          // stay recognizable via the underline. Neutral paper bubbles keep a
          // brand-tinted link that actually contrasts with the surface.
          ...markdownLinkVars(theme, message.role !== 'assistant' && message.role !== 'tool'),
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
          // Dim + outline the bubble whose content is being edited in the input.
          opacity: isBeingEdited ? 0.55 : 1,
          outline: isBeingEdited ? '2px dashed' : 'none',
          outlineColor: 'warning.main',
          overflowWrap: 'break-word', // Ensure long words break
          wordBreak: 'break-word', // Ensure words break correctly
          // The default white-on-violet selection is effectively invisible on
          // the modern light user bubble. Reverse those colors locally so the
          // selected range has a clear light block and dark-violet text.
          ...(message.role === 'user' && {
            ':root.modern-theme:not(.dark-theme) & ::selection': {
              color: theme.palette.primary.dark,
              backgroundColor: theme.palette.common.white,
            },
          }),
          // NOTE: do NOT set white-space: pre-wrap here. react-markdown emits
          // literal "\n" text nodes *between* block elements; a pre-wrap
          // container renders those as visible blank lines on top of the
          // paragraph block margins, which doubled the spacing for every
          // newline. Whitespace is instead preserved per-block (see the `p`
          // and `li` renderers above, which use `pre-line`).
          overflow: 'hidden', // Prevent content from visually overflowing the paper
        })}
      >
        {(
          <>
            {/* Render message content only if it's a string and not a tool message */}
            {message.role !== 'tool' && typeof message.content === 'string' && (
              <ChatMarkdownContent>{message.content}</ChatMarkdownContent>
            )}
            {/* Multipart content (text + images): user attachments and generated
                assistant images are normalized to an OpenAI-style content-part
                array. Render text as markdown and image_url parts inline. */}
            {message.role !== 'tool' && Array.isArray(message.content) && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {(message.content as any[]).map((part, partIndex) => {
                  if (part?.type === 'text') {
                    return (
                      // Same renderer map as the string-content path above: it
                      // routes anchors through MarkdownLink, so multipart text
                      // links consume the bubble's `--flujo-link-color` instead
                      // of the UA default (invisible violet-on-violet in the
                      // light modern theme).
                      <ChatMarkdownContent key={partIndex}>{part.text}</ChatMarkdownContent>
                    );
                  }
                  if (part?.type === 'image_url' && part.image_url?.url) {
                    return (
                      // Provider image URLs may be data URLs and cannot be statically optimized.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={partIndex}
                        src={part.image_url.url}
                        alt={t('chat.messages.generatedImage', { number: partIndex + 1 })}
                        style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }}
                      />
                    );
                  }
                  return null;
                })}
              </Box>
            )}
            {message.role !== 'tool' && message.media && message.media.length > 0 && (
              <MessageMediaView
                media={message.media.filter(part =>
                  part.type !== 'image' ||
                  !Array.isArray(message.content) ||
                  !(message.content as any[]).some(
                    contentPart =>
                      contentPart?.type === 'image_url' &&
                      contentPart.image_url?.url === mediaDataUrl(part)
                  )
                )}
              />
            )}
            {/* Fallback for non-string, non-array content (e.g., assistant message with only tool calls) */}
            {message.role !== 'tool' && typeof message.content !== 'string' && !Array.isArray(message.content) && !hasToolCalls(message) && !message.media?.length && (
               <Typography variant="body2" fontStyle="italic" color="text.secondary">
                  {t('chat.messages.noText')}
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
            ? (message.tool_calls as FlujoFunctionToolCall[]).filter((tc) => isHandoffToolName(tc.function.name))
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
                  label={t('chat.messages.handoff', { target: handoffTargetLabel(toolCall.function.name, availableNodes) })}
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
          <ToolCallTimeline
            pairs={toolCallPairs}
            messageId={message.id}
            conversationId={conversationId}
            onAppMessage={onAppMessage}
            onUpdateModelContext={onUpdateModelContext}
            onRegisterAppTeardown={onRegisterAppTeardown}
            onOpenInCanvas={onOpenInCanvas}
            autoOpenMcpApps={autoOpenMcpApps}
            autoOpenMcpAppResultIds={autoOpenMcpAppResultIds}
            dismissedMcpAppKeys={dismissedMcpAppKeys}
            autoOpenSuppressed={autoOpenSuppressed}
            onMcpAppManualOpen={onMcpAppManualOpen}
            mcpAppHostResultIds={mcpAppHostResultIds}
            onCancelToolCall={onCancelToolCall}
          />
        )}

        {/* Display tool call result for tool messages. Handoff results are the
            meaningless `{handoff:true}` blob — suppressed; the marker above says it all. */}
        {message.role === 'tool' && message.tool_call_id && !isHandoffResult(message) && (
          <Box>
            <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary', mb: 1 }}>
              <TerminalIcon fontSize="small" sx={{ mr: 1 }} />
               {t('chat.messages.toolResponded')}
            </Typography>

            <Accordion
              expanded={orphanToolExpanded}
              onChange={(_event, expanded) => setOrphanToolExpanded(expanded)}
              sx={{ mb: 0.5, '&:before': { display: 'none' }, boxShadow: 'none', bgcolor: 'rgba(0, 0, 0, 0.02)' }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <TerminalIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
                   <Typography variant="subtitle2">{t('chat.messages.toolResult')}</Typography>
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
                    label={t('chat.messages.raw')}
                    sx={{ mr: 1, ml: 'auto', '& .MuiTypography-root': { fontSize: '0.75rem' } }}
                    onClick={(e) => e.stopPropagation()} // Prevent accordion toggle on label click
                  />
                </Box>
              </AccordionSummary>
              {orphanToolExpanded && (
                <AccordionDetails sx={{ pt: 0, pb: 1, overflow: 'hidden' }}>
                  <DeferredToolResultView
                    content={message.content}
                    payload={message.toolPayloads?.[message.tool_call_id]?.result}
                    showRaw={showRaw}
                  />
                </AccordionDetails>
              )}
            </Accordion>
          </Box>
        )}

        {/* Display attachments if any */}
        {message.attachments && message.attachments.length > 0 && (
          <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              {t('chat.messages.attachments')}
            </Typography>

            {message.attachments.map((attachment) => (
              attachment.type === 'image' ? (
                <Box key={attachment.id} sx={{ mb: 0.5 }}>
                  {/* Attachments use local data URLs, which the Next image optimizer does not support. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={attachment.content}
                    alt={attachment.originalName || t('chat.messages.imageAttachment')}
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
                    {attachment.originalName || t('chat.input.attachment', { type: attachment.type })}
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

// ---------------------------------------------------------------------------
// ElicitationFormCard — renders a server-supplied elicitation form
// ---------------------------------------------------------------------------

type FieldSchema = {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
};

interface ElicitationFormCardProps {
  elicitation: PendingElicitation;
  onSubmit?: (elicitationId: string, content: Record<string, string | number | boolean | string[]>) => void;
  onCancel?: (elicitationId: string) => void;
}

const ElicitationFormCard: React.FC<ElicitationFormCardProps> = ({ elicitation, onSubmit, onCancel }) => {
  const { t } = useI18n();
  const { elicitationId, message, requestedSchema } = elicitation;
  const schemaProps = (requestedSchema?.properties ?? {}) as Record<string, FieldSchema>;
  const fieldNames = Object.keys(schemaProps);

  const initValues = () => {
    const vals: Record<string, string | number | boolean | string[]> = {};
    for (const key of fieldNames) {
      const f = schemaProps[key];
      if (f.default !== undefined) vals[key] = f.default as string | number | boolean | string[];
      else if (f.type === 'boolean') vals[key] = false;
      else if (f.type === 'number' || f.type === 'integer') vals[key] = 0;
      else vals[key] = '';
    }
    return vals;
  };

  const [values, setValues] = useState<Record<string, string | number | boolean | string[]>>(initValues);

  const patch = (key: string, val: string | number | boolean | string[]) => {
    setValues(prev => ({ ...prev, [key]: val }));
  };

  const handleSubmit = () => {
    if (onSubmit) onSubmit(elicitationId, values);
  };

  const handleCancel = () => {
    if (onCancel) onCancel(elicitationId);
  };

  return (
    <Paper
      elevation={2}
      sx={{ p: 2, mt: 2, bgcolor: 'info.light', border: '1px solid', borderColor: 'info.main', borderRadius: 2 }}
    >
      <Typography variant="h6" sx={{ mb: 1 }}>{t('chat.elicitation.title')}</Typography>
      <Typography variant="body2" sx={{ mb: 2 }}>{message}</Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {fieldNames.map((key) => {
          const f = schemaProps[key];
          const label = f.title || key;
          const val = values[key];

          if (f.type === 'boolean') {
            return (
              <FormControlLabel
                key={key}
                control={
                  <Checkbox
                    checked={!!val}
                    onChange={(e) => patch(key, e.target.checked)}
                    size="small"
                  />
                }
                label={label}
              />
            );
          }

          if (f.enum && f.enum.length > 0) {
            return (
              <FormControl key={key} size="small" sx={{ minWidth: 200 }}>
                <InputLabel>{label}</InputLabel>
                <Select
                  label={label}
                  value={String(val ?? '')}
                  onChange={(e) => patch(key, e.target.value)}
                >
                  {f.enum.map((opt, i) => (
                    <MenuItem key={opt} value={opt}>
                      {f.enumNames?.[i] || opt}
                    </MenuItem>
                  ))}
                </Select>
                {f.description && <FormHelperText>{f.description}</FormHelperText>}
              </FormControl>
            );
          }

          // string / number / integer
          const isNumeric = f.type === 'number' || f.type === 'integer';
          return (
            <TextField
              key={key}
              size="small"
              label={label}
              type={isNumeric ? 'number' : 'text'}
              value={String(val ?? '')}
              helperText={f.description}
              inputProps={{
                minLength: f.minLength,
                maxLength: f.maxLength,
                min: f.minimum,
                max: f.maximum,
              }}
              onChange={(e) => {
                if (isNumeric) {
                  const n = parseFloat(e.target.value);
                  patch(key, isNaN(n) ? 0 : n);
                } else {
                  patch(key, e.target.value);
                }
              }}
            />
          );
        })}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
        <Button variant="outlined" color="inherit" size="small" onClick={handleCancel} disabled={!onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="contained" color="primary" size="small" onClick={handleSubmit} disabled={!onSubmit}>
          {t('chat.elicitation.submit')}
        </Button>
      </Box>
    </Paper>
  );
};

// ---------------------------------------------------------------------------
// QuestionCard — renders a model-initiated multiple-choice question (issue #258)
// ---------------------------------------------------------------------------

interface QuestionCardProps {
  question: PendingQuestion;
  onAnswer?: (questionId: string, answers: string[][]) => void;
  onDecline?: (questionId: string) => void;
}

const CUSTOM_OPTION_LABEL = 'Type your own answer';

const QuestionCard: React.FC<QuestionCardProps> = ({ question, onAnswer, onDecline }) => {
  const { t } = useI18n();
  const { questionId, questions } = question;
  // Per-question selected option labels + free-text value for the custom option.
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [customText, setCustomText] = useState<string[]>(() => questions.map(() => ''));

  const isCustom = (opt: string) => opt === CUSTOM_OPTION_LABEL;

  const toggleMulti = (qi: number, opt: string) => {
    setSelected((prev) => {
      const next = prev.map((a) => [...a]);
      const arr = next[qi];
      const idx = arr.indexOf(opt);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(opt);
      return next;
    });
  };

  const setSingle = (qi: number, opt: string) => {
    setSelected((prev) => {
      const next = prev.map((a) => [...a]);
      next[qi] = [opt];
      return next;
    });
  };

  // Resolve each question's selection into final labels: the custom option's
  // label is replaced by the typed free text (when provided).
  const resolveAnswers = (): string[][] =>
    questions.map((q, qi) => {
      const picks = selected[qi] ?? [];
      return picks
        .map((opt) => (isCustom(opt) ? customText[qi].trim() : opt))
        .filter((v) => v.length > 0);
    });

  const canSubmit = questions.every((_, qi) => (resolveAnswers()[qi] ?? []).length > 0);

  const handleSubmit = () => {
    if (onAnswer) onAnswer(questionId, resolveAnswers());
  };
  const handleDecline = () => {
    if (onDecline) onDecline(questionId);
  };

  return (
    <Paper
      elevation={2}
      sx={{ p: 2, mt: 2, bgcolor: 'info.light', border: '1px solid', borderColor: 'info.main', borderRadius: 2 }}
    >
      <Typography variant="h6" sx={{ mb: 1 }}>{t('chat.question.title')}</Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {questions.map((q, qi) => (
          <FormControl key={qi} component="fieldset" sx={{ display: 'flex' }}>
            <FormLabel sx={{ mb: 0.5 }}>{q.prompt}</FormLabel>
            {q.multiple ? (
              <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                {q.options.map((opt) => (
                  <FormControlLabel
                    key={opt}
                    control={
                      <Checkbox
                        size="small"
                        checked={(selected[qi] ?? []).includes(opt)}
                        onChange={() => toggleMulti(qi, opt)}
                      />
                    }
                    label={isCustom(opt) ? t('chat.question.custom') : opt}
                  />
                ))}
              </Box>
            ) : (
              <RadioGroup
                value={(selected[qi] ?? [])[0] ?? ''}
                onChange={(e) => setSingle(qi, e.target.value)}
              >
                {q.options.map((opt) => (
                  <FormControlLabel key={opt} value={opt} control={<Radio size="small" />} label={isCustom(opt) ? t('chat.question.custom') : opt} />
                ))}
              </RadioGroup>
            )}
            {(selected[qi] ?? []).includes(CUSTOM_OPTION_LABEL) && (
              <TextField
                size="small"
                sx={{ mt: 1 }}
                placeholder={t('chat.question.placeholder')}
                value={customText[qi]}
                onChange={(e) =>
                  setCustomText((prev) => {
                    const next = [...prev];
                    next[qi] = e.target.value;
                    return next;
                  })
                }
              />
            )}
          </FormControl>
        ))}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
        <Button variant="outlined" color="inherit" size="small" onClick={handleDecline} disabled={!onDecline}>
          {t('chat.question.decline')}
        </Button>
        <Button variant="contained" color="primary" size="small" onClick={handleSubmit} disabled={!onAnswer || !canSubmit}>
          {t('chat.question.answer')}
        </Button>
      </Box>
    </Paper>
  );
};

// ---------------------------------------------------------------------------

const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  pendingToolCalls, // Destructure new prop
  pendingElicitation,
  availableNodes = [], // Destructure with default empty array
  conversationId,
  editingMessageId,
  onToggleDisabled,
  onSplitConversation,
  onSplitConversationFromHere,
  onRevertToHere,
  onBeginEditMessage,
  onApproveToolCall, // Destructure new prop
  onRejectToolCall, // Destructure new prop
  onCancelToolCall, // Issue #357
  onSubmitElicitation,
  onCancelElicitation,
  pendingQuestion,
  onAnswerQuestion,
  onDeclineQuestion,
  onAppMessage, // #97: MCP App -> conversation return channel (stable)
  onUpdateModelContext,
  onRegisterAppTeardown,
  onOpenInCanvas, // #216: route a tool app to the docked canvas
  autoOpenMcpApps = true,
  autoOpenMcpAppResultIds,
  dismissedMcpAppKeys,
  autoOpenSuppressed,
  onMcpAppManualOpen,
  queuedMessages = [], // #221: inline pending bubbles
  queueHoldReason = null,
  anchorMessageId,
}) => {
  const { t, tp } = useI18n();
  // Issue #247: per-tool-call rejection feedback text (keyed by tool-call id),
  // so the user can tell the model *why* a call was rejected / what to do instead.
  const [rejectFeedback, setRejectFeedback] = useState<Record<string, string>>({});

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

  // #374: `?message=<id>` magic link target. Expand the render window (if
  // needed) so the anchor is actually mounted, then scroll it into view once
  // it is; the highlight itself is driven by `isAnchor` on MessageBubble.
  useEffect(() => {
    if (!anchorMessageId || !Array.isArray(messages)) return;
    const idx = messages.findIndex((m) => m.id === anchorMessageId);
    if (idx === -1) return;
    const neededVisible = totalCount - idx;
    if (neededVisible > visibleCount) {
      setVisibleCount(neededVisible);
      return; // re-run after the window has expanded to include it
    }
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const raf = window.requestAnimationFrame(() => {
      document
        .querySelector(`[data-ask-flujo-message-id="${anchorMessageId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [anchorMessageId, messages, totalCount, visibleCount]);

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
    const renderHandoffsById = new Map<string, OpenAI.ChatCompletionMessageFunctionToolCall[]>();
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
  const [revertMessageId, setRevertMessageId] = React.useState<string | null>(null);
  // State to manage raw view toggle for each tool message
  const [showRawToolResult, setShowRawToolResult] = React.useState<Record<string, boolean>>({});
  const mcpAppHostResultIds = useMemo<ReadonlySet<string>>(() => {
    const candidates = messages
      .filter((message) => (
        message.role === 'tool'
        && message.ui?.uri
        && message.ui.serverName
        && Boolean(message.id)
      ))
      .map((message) => message.id);
    return new Set(latestMcpAppResultIdsByResource(messages, candidates));
  }, [messages]);

  // Stable callbacks handed to every (memoized) bubble.
  const handleMenuOpen = useCallback((event: React.MouseEvent<HTMLElement>, messageId: string) => {
    log.debug(`handleMenuOpen called with messageId: ${messageId}`);
    setMenuAnchorEl(event.currentTarget);
    setActiveMessageId(messageId);
  }, []);

  const handleToggleRaw = useCallback((messageId: string, checked: boolean) => {
    setShowRawToolResult(prev => ({ ...prev, [messageId]: checked }));
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

  const handleSplitConversationFromHere = () => {
    if (activeMessageId && onSplitConversationFromHere) {
      onSplitConversationFromHere(activeMessageId);
      handleMenuClose();
    }
  };

  const handleRevertToHere = () => {
    if (activeMessageId) {
      setRevertMessageId(activeMessageId);
      handleMenuClose();
    }
  };

  // Editing happens in the ChatInput now — this just hands the message id up.
  const handleStartEditing = () => {
    if (activeMessageId) {
      onBeginEditMessage?.(activeMessageId);
      handleMenuClose();
    }
  };

  // #374: shareable `/chat?conversation=<id>&message=<id>` magic link — ids only.
  const handleCopyMessageLink = () => {
    if (activeMessageId) {
      const url = magicLinkUrl({
        kind: 'message',
        id: activeMessageId,
        extra: conversationId ? { conversation: conversationId } : undefined,
      });
      void copyText(url);
    }
    handleMenuClose();
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
            {t('chat.messages.earlier', { count: hiddenCount })}
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
        return (
          <MessageBubble
            key={message.id || `msg-${hiddenCount + index}`} // Use message.id as key, fallback to global index
            message={message}
            conversationId={conversationId}
            nodeLabel={message.processNodeId ? nodeLabelById.get(message.processNodeId) : undefined}
            availableNodes={availableNodes}
            showRaw={!!showRawToolResult[message.id]}
            toolCallPairs={renderPairsById.get(message.id)}
            onAppMessage={onAppMessage}
            onUpdateModelContext={onUpdateModelContext}
            onRegisterAppTeardown={onRegisterAppTeardown}
            onOpenInCanvas={onOpenInCanvas}
            autoOpenMcpApps={autoOpenMcpApps}
            autoOpenMcpAppResultIds={autoOpenMcpAppResultIds}
            dismissedMcpAppKeys={dismissedMcpAppKeys}
            autoOpenSuppressed={autoOpenSuppressed}
            onMcpAppManualOpen={onMcpAppManualOpen}
            mcpAppHostResultIds={mcpAppHostResultIds}
            onCancelToolCall={onCancelToolCall}
            hoistedHandoffs={renderHandoffsById.get(message.id)}
            isBeingEdited={!!editingMessageId && message.id === editingMessageId}
            isAnchor={!!anchorMessageId && message.id === anchorMessageId}
            onMenuOpen={handleMenuOpen}
            onToggleRaw={handleToggleRaw}
          />
        );
      })}

      {/* #221: Inline pending bubbles for queued (not-yet-sent) messages.
          These are client-only synthetic rows — never persisted. They render
          right-aligned and dimmed so the user can see them immediately in the
          thread instead of only as tiny chips above the input. */}
      {queuedMessages.map((q) => (
        <Box
          key={q.id}
          data-testid="queued-bubble"
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            opacity: 0.6,
          }}
        >
          <Box
            sx={{
              maxWidth: '70%',
              bgcolor: 'primary.light',
              color: 'primary.contrastText',
              borderRadius: 2,
              px: 2,
              py: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 0.5,
            }}
          >
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {q.content || (q.attachments.length > 0 ? tp('chat.messages.attachment', q.attachments.length) : '')}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, justifyContent: 'flex-end' }}>
              {!queueHoldReason && <CircularProgress size={10} color="inherit" />}
              <Typography variant="caption" sx={{ opacity: 0.85 }}>
                {queueHoldReason ?? t('chat.messages.queued')}
              </Typography>
            </Box>
          </Box>
        </Box>
      ))}

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
            // Only user messages with string content can be edited in the input.
            const shouldShowEdit =
              activeMsgForMenu.role === 'user' &&
              typeof activeMsgForMenu.content === 'string' &&
              !!onBeginEditMessage;

            if (shouldShowEdit) {
              return (
                <MenuItem onClick={handleStartEditing}>
                  <ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>
                   <ListItemText>{t('chat.actions.edit')}</ListItemText>
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
            {activeMsgForMenu?.disabled ? t('chat.actions.enable') : t('chat.actions.disable')}
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={handleSplitConversation}>
          <ListItemIcon><CallSplitIcon fontSize="small" /></ListItemIcon>
          <ListItemText>{t('chat.actions.split')}</ListItemText>
        </MenuItem>
        {/* Same action mirrored: keep this message through the end instead.
            The icon is the split glyph flipped, so the two directions read as
            a pair at a glance. */}
        {onSplitConversationFromHere && (
          <MenuItem onClick={handleSplitConversationFromHere}>
            <ListItemIcon>
              <CallSplitIcon fontSize="small" sx={{ transform: 'rotate(180deg)' }} />
            </ListItemIcon>
            <ListItemText>{t('chat.actions.splitFromHere')}</ListItemText>
          </MenuItem>
        )}
        {FEATURES.ENABLE_REVERT_TO_HERE && activeMsgForMenu?.changedFiles?.length ? (
          <MenuItem onClick={handleRevertToHere}>
            <ListItemIcon><RestoreIcon fontSize="small" /></ListItemIcon>
            <ListItemText>{t('chat.actions.revert')}</ListItemText>
          </MenuItem>
        ) : null}
        <MenuItem onClick={handleCopyMessageLink}>
          <ListItemIcon><LinkRoundedIcon fontSize="small" /></ListItemIcon>
          <ListItemText>{t('magicLink.copy')}</ListItemText>
        </MenuItem>
      </Menu>

      {FEATURES.ENABLE_REVERT_TO_HERE && conversationId && (
        <RevertPreviewDialog
          open={!!revertMessageId}
          conversationId={conversationId}
          messageId={revertMessageId}
          onClose={() => setRevertMessageId(null)}
          onReverted={onRevertToHere}
        />
      )}

      {/* Display Pending Elicitation Form */}
      {pendingElicitation && (
        <ElicitationFormCard
          elicitation={pendingElicitation}
          onSubmit={onSubmitElicitation}
          onCancel={onCancelElicitation}
        />
      )}

      {/* Display Pending Question (issue #258) */}
      {pendingQuestion && (
        <QuestionCard
          question={pendingQuestion}
          onAnswer={onAnswerQuestion}
          onDecline={onDeclineQuestion}
        />
      )}

      {/* Display Pending Tool Calls for Approval */}
      {/* Add null check for pendingToolCalls before accessing length */}
      {pendingToolCalls && pendingToolCalls.length > 0 && (
        <Paper
          elevation={2}
          sx={{ p: 2, mt: 2, bgcolor: 'warning.light', border: '1px solid', borderColor: 'warning.main', borderRadius: 2 }}
        >
          <Typography variant="h6" sx={{ mb: 1, display: 'flex', alignItems: 'center' }}>
            <HandymanIcon sx={{ mr: 1 }} /> {t('chat.approval.title')}
          </Typography>
          <Typography variant="body2" sx={{ mb: 2 }}>
            {t('chat.approval.help')}
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
                  {/* Issue #247: optional reason carried back to the model on reject. */}
                  <TextField
                    label={t('chat.approval.reason')}
                    placeholder={t('chat.approval.reasonPlaceholder')}
                    value={rejectFeedback[toolCall.id] ?? ''}
                    onChange={(e) => setRejectFeedback(prev => ({ ...prev, [toolCall.id]: e.target.value }))}
                    multiline minRows={1} maxRows={4} fullWidth size="small"
                    sx={{ mt: 1, mb: 1 }}
                  />
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                    <Button
                      variant="outlined" color="error" size="small" startIcon={<ThumbDownIcon />}
                      onClick={() => onRejectToolCall && onRejectToolCall(toolCall.id, false, rejectFeedback[toolCall.id]?.trim() || undefined)}
                      disabled={!onRejectToolCall}
                    >
                      {t('chat.approval.reject')}
                    </Button>
                    <Button
                      variant="outlined" color="error" size="small"
                      onClick={() => onRejectToolCall && onRejectToolCall(toolCall.id, true)}
                      disabled={!onRejectToolCall}
                      title={t('chat.approval.denyHelp')}
                    >
                      {t('chat.approval.alwaysDeny')}
                    </Button>
                    <Button
                      variant="outlined" color="success" size="small" startIcon={<ThumbUpIcon />}
                      onClick={() => onApproveToolCall && onApproveToolCall(toolCall.id, true)}
                      disabled={!onApproveToolCall}
                      title={t('chat.approval.allowHelp')}
                    >
                      {t('chat.approval.alwaysAllow')}
                    </Button>
                    <Button
                      variant="contained" color="success" size="small" startIcon={<ThumbUpIcon />}
                      onClick={() => onApproveToolCall && onApproveToolCall(toolCall.id)}
                      disabled={!onApproveToolCall}
                    >
                      {t('chat.approval.approve')}
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
