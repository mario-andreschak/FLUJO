"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'; // Added useCallback
import { useRouter } from 'next/navigation';
import { Box, Paper, Typography, Divider, CircularProgress, Alert, Button, Chip, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Drawer, IconButton, Tooltip, TextField, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ScrollNavCluster from '@/frontend/components/shared/ScrollNavCluster';
import { useChatScrollNav } from '@/frontend/components/Chat/hooks/useChatScrollNav';
import BoltIcon from '@mui/icons-material/Bolt';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import EditIcon from '@mui/icons-material/Edit';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ScheduleIcon from '@mui/icons-material/Schedule';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import { useLocalStorage, StorageKey } from '@/utils/storage';
import { workspaceLocalStorageKey } from '@/frontend/utils/workspaceSelection';
import ChatHistory from './ChatHistory';
import ChatMessages from './ChatMessages';
import type { CanvasLaunchInfo, PendingElicitation, PendingQuestion } from './ChatMessages';
import { buildSplitMessages, type SplitHalf } from './conversationSplit';
import ChatInput from './ChatInput';
import DevCanvasDock, { type CanvasDockLayout } from './DevCanvasDock'; // #216: docked MCP Apps canvas
import {
  DEFAULT_CANVAS_TAB_CAP,
  emptyCanvasState,
  enforceCap,
  openCanvasApp,
  updateCanvasApp,
  setActiveCanvasTab,
  closeCanvasApp,
  canvasEntries,
  canvasKey,
  shouldOpenCanvasApp,
  type CanvasState,
  type CanvasAppInput,
} from './canvasState';
import {
  jsonUtf8ByteLength,
  MAX_MCP_APP_CONTEXT_BYTES,
} from './McpAppFrame';
import {
  QueueMap,
  QueuedMessage,
  enqueue as enqueueMsg,
  dequeue as dequeueMsg,
  clearQueue as clearMsgQueue,
  removeQueued as removeQueuedMsg,
  requeueFront as requeueFrontMsg,
  getQueue as getMsgQueue,
  peekQueue as peekMsgQueue,
  canDrain as canDrainQueue,
  drainHoldReason,
} from './chatQueue';
import LiveRunIndicator, { LiveRunStats } from './LiveRunIndicator';
import TodoDock from './TodoDock';
import ConversationStats from './ConversationStats';
import FlowSelector from './FlowSelector';
import QuickChatDialog, { QuickChatStartSelection } from './QuickChatDialog';
import DebuggerCanvas from './DebuggerCanvas';
import DebuggerPendingPanel from './DebuggerPendingPanel';
import ExecutedFlowPanel from './ExecutedFlowPanel';
import { isQuickChatFlowId } from '@/utils/shared/quickChat';
import type { RecoveryRecord } from '@/shared/types/execution/events';
import type { NormalizedChatError } from '@/shared/types/execution/errors';
import ChatErrorDetails from './ChatErrorDetails';
import { getStartNode } from '@/utils/shared/getStartNode';
import Spinner from '@/frontend/components/shared/Spinner';
import { v4 as uuidv4 } from 'uuid';
import OpenAI, { OpenAIError, APIError } from 'openai'; // Import APIError
import { flowService } from '@/frontend/services/flow';
import {
  chatService,
  ChatApiError,
  type SubflowRecoveryOptions,
  type SubflowRecoveryScope,
} from '@/frontend/services/chat';
import { createLogger } from '@/utils/logger';
// Correctly import SharedState here
import {
  ChatCompletionMetadata,
  FlujoChatMessage,
  type McpAppModelContext,
  type McpAppModelContextMap,
} from '@/shared/types/chat'; // Import the shared types
import type { SharedState } from '@/backend/execution/flow/types'; // Import SharedState type from backend
import type { ExecutionEvent, TodoEventItem } from '@/shared/types/execution/events'; // Live execution events (SSE)
import {
  LiveActivity,
  EMPTY_LIVE_ACTIVITY,
  pruneLiveActivity,
  resourceActivityKey,
} from '@/utils/shared/liveActivity';
import { LiveLanes, EMPTY_LIVE_LANES, applyLaneEvent } from '@/utils/shared/liveLanes';
import { deriveExecutedNodeIds } from '@/utils/shared/executedNodes';
import { Flow, FlowNode } from '@/shared/types/flow'; // Import Flow and FlowNode types
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useAskFlujoPage } from '@/frontend/contexts/AskFlujoContext';
import type { AskFlujoUiAction } from '@/frontend/types/askFlujo';
import { highlightAskFlujoElement } from '@/frontend/utils/askFlujoActions';
import { useEntityDeepLink } from '@/frontend/hooks/useEntityDeepLink';
import { magicLinkPath } from '@/frontend/utils/magicLink';
import {
  NEW_CHAT_PARAM,
  consumeQuickActionToken,
  isQuickActionTokenPending,
  subscribeNewChatRequests,
} from '@/frontend/utils/quickActions';
import {
  latestMcpAppResultIdsByResource,
  observeNewMcpAppResultIds,
} from './mcpAppProjection';
import {
  readDismissedMcpAppKeys,
  writeMcpAppDismissed,
  writeMcpAppsDismissed,
  readAutoOpenSuppressed,
  writeAutoOpenSuppressed,
} from './mcpAppPreferences';

const log = createLogger('frontend/components/Chat/index');

/**
 * Stable function identity with fresh behavior. This is useful at memoized
 * component boundaries: streamed chat state can re-render the parent without
 * invalidating event-handler props on the otherwise unchanged sidebar.
 */
function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

// Define types for our chat data
export interface Attachment {
  id: string;
  type: 'document' | 'audio' | 'image' | 'video';
  // For document/audio this is text (the contents / transcription). For an
  // image it is a `data:` URL (e.g. `data:image/png;base64,...`) — the form a
  // pasted screenshot is read into.
  content: string;
  originalName?: string;
  mimeType?: string;
  /** Optional text transcript retained alongside a raw audio attachment. */
  transcript?: string;
}

// Use the shared FlujoChatMessage type and extend it with UI-specific fields
export type ChatMessage = FlujoChatMessage & {
  attachments?: Attachment[];
};

// Build the OpenAI-wire `content` for a message about to be sent to the API.
// Text-only messages (and document/audio attachments, which are inlined as
// text as before) collapse to a plain string; image attachments produce a
// multipart array carrying `image_url` parts so vision-capable models actually
// receive the image. Content that is already multipart (a prior turn replayed
// from the backend) is passed through untouched.
function buildApiContent(msg: ChatMessage): OpenAI.ChatCompletionUserMessageParam['content'] {
  if (Array.isArray(msg.content)) {
    return msg.content as OpenAI.ChatCompletionUserMessageParam['content'];
  }
  let text = typeof msg.content === 'string' ? msg.content : '';
  const attachments = msg.attachments ?? [];
  const textAttachments = attachments.filter(
    attachment =>
      attachment.type === 'document' &&
      !attachment.content.startsWith('data:'),
  );
  const images = attachments.filter(a => a.type === 'image');
  const binary = attachments.filter(
    attachment => attachment.type !== 'image' && !textAttachments.includes(attachment),
  );
  if (textAttachments.length > 0) {
    text += '\n\n' + textAttachments
      .map(a => `[DOCUMENT]: ${a.content}`)
      .join('\n\n');
  }
  if (images.length === 0 && binary.length === 0) {
    return text;
  }
  const parts: Array<Record<string, unknown>> = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.content } });
  }
  for (const attachment of binary) {
    if (attachment.type === 'audio') {
      const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(attachment.content);
      const mimeType = attachment.mimeType ?? match?.[1];
      if (match && (mimeType === 'audio/wav' || mimeType === 'audio/mpeg')) {
        parts.push({
          type: 'input_audio',
          input_audio: {
            data: match[2],
            format: mimeType === 'audio/mpeg' ? 'mp3' : 'wav',
          },
        });
      } else {
        parts.push({
          type: 'audio_url',
          audio_url: { url: attachment.content, mime_type: mimeType },
        });
      }
      if (attachment.transcript) {
        parts.push({ type: 'text', text: `[Audio transcript]: ${attachment.transcript}` });
      }
    } else if (attachment.type === 'video') {
      parts.push({
        type: 'video_url',
        video_url: { url: attachment.content, mime_type: attachment.mimeType },
      });
    } else {
      parts.push({
        type: 'file',
        file: {
          file_data: attachment.content,
          filename: attachment.originalName,
          mime_type: attachment.mimeType,
        },
      });
    }
  }
  return parts as unknown as OpenAI.ChatCompletionUserMessageParam['content'];
}

// Represents the full conversation details including messages
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  flowId: string | null;
  requireApproval?: boolean;
  createdAt: number;
  updatedAt: number;
  status?: 'running' | 'awaiting_tool_approval' | 'paused_debug' | 'completed' | 'error' | 'capped';
  /** Additive durable cancellation/interruption/failure metadata (issue #355). */
  recovery?: RecoveryRecord;
  parentConversationId?: string | null;
  rootConversationId?: string | null;
  /** Node where execution currently sits (server truth). May reference a node
   *  of a previously selected flow after a flow switch — validate before use. */
  currentNodeId?: string;
  /** Aggregated token totals for the conversation (accumulated by the backend). */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd?: number;
    /** Cache RE-READ tokens (subset of promptTokens) — shown as "cached", not fresh (#87). */
    cacheReadTokens?: number;
    /** Cache-write tokens (subset of promptTokens) — fresh, but called out separately. */
    cacheWriteTokens?: number;
    byNode?: Record<string, {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      costUsd?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }>;
  };
  /** Context snapshot of the latest model call (provider-reported prompt size
   *  + the bound model's configured context window, when available). */
  contextInfo?: {
    promptTokens: number;
    completionTokens?: number;
    nodeId?: string;
    modelDisplayName?: string;
    contextWindow?: number;
  };
  /** Latest persisted future-turn context from each MCP App View. */
  mcpAppContexts?: McpAppModelContextMap;
  /** Issue #383: normalized terminal error, present when status === 'error'.
   *  Served by GET /v1/chat/conversations/[id] so the message + code survive
   *  a reload. */
  lastError?: NormalizedChatError;
}

// Represents the summary item shown in the list
// Note: Backend GET /v1/chat/conversations returns this structure
export interface ConversationListItem {
  id: string;
  title: string;
  flowId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Timestamp of the most recent user-role message; used for sidebar sort.
   *  Optional/null for legacy conversations (falls back to updatedAt). */
  lastUserMessageAt?: number | null;
  status?: 'running' | 'awaiting_tool_approval' | 'paused_debug' | 'completed' | 'error' | 'capped'; // 'capped' = graceful landing at turn cap (#253)
  recovery?: RecoveryRecord;
  /** Durable invocation origin recorded by runFlow. New UI-created
   *  conversations are seeded as `chat`; optional for legacy records. */
  source?: SharedState['source'] | null;
  /** Id of the scheduler planned-execution that originated this conversation
   *  (issue #181). Persisted on SharedState (#113); exposed read-only so the
   *  sidebar can group conversations by their Wave. null/undefined for ad-hoc
   *  chat/API conversations. */
  plannedExecutionId?: string | null;
  /** Conversation that spawned this one (subflow child conversations) -- issue
   *  #182. Absent/null => this conversation is a chain root. Used by the
   *  sidebar's "by chain" grouping to nest children under their parent. */
  parentConversationId?: string | null;
  /** Top-level conversation of this chain (computed at creation) -- issue #182.
   *  Lets the sidebar bucket a whole chain by its root in O(1). */
  rootConversationId?: string | null;
  /** Issue #383: COMPACT error projection (message/code/class only, no
   *  redacted provider details/stack) so the sidebar's bulk listing stays
   *  small. Present when status === 'error'. */
  lastError?: { message: string; code?: string; errorClass?: NormalizedChatError['errorClass'] };
}

/**
 * One-shot request to REVEAL a conversation in the sidebar (issue #397).
 *
 * Deliberately separate from `currentConversationId`: ordinary clicks and
 * streamed list updates must never scroll the sidebar, only a URL-originated
 * deep link may. `requestKey` is monotonic so navigating away and back to the
 * SAME conversation still issues a fresh reveal, while unrelated rerenders
 * (same object identity) cannot.
 */
export interface ChatRevealRequest {
  id: string;
  requestKey: number;
}

/** Field-wise list equality, so the periodic silent refresh can keep the
 *  previous array identity (= no sidebar re-render) when nothing changed. */
const sameConversationLists = (a: ConversationListItem[], b: ConversationListItem[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return (
      x.id === y.id &&
      x.title === y.title &&
      x.flowId === y.flowId &&
      x.status === y.status &&
      x.recovery?.classification === y.recovery?.classification &&
      x.recovery?.updatedAt === y.recovery?.updatedAt &&
      x.plannedExecutionId === y.plannedExecutionId &&
      x.source === y.source &&
      x.parentConversationId === y.parentConversationId &&
      x.rootConversationId === y.rootConversationId &&
      x.createdAt === y.createdAt &&
      x.updatedAt === y.updatedAt &&
      x.lastUserMessageAt === y.lastUserMessageAt
    );
  });


/** The backend reports a user Stop as a model error coded 'cancelled' with the
 *  message "Execution cancelled by user." (mapped to a 500 by the OpenAI-shaped
 *  route). Recognise it from any error shape the SDK/REST layers throw so a
 *  deliberate Stop is never surfaced as a provider failure. */
const SIDEBAR_PAGE_SIZE = 50;

const CANCELLED_MESSAGE_RE = /cancelled by user|execution cancelled/i;
const isCancellationError = (err: unknown): boolean => {
  const anyErr = err as { code?: unknown; error?: { code?: unknown }; message?: unknown; body?: { error?: unknown } };
  if (anyErr?.code === 'cancelled' || anyErr?.error?.code === 'cancelled') return true;
  const texts = [anyErr?.message, typeof anyErr?.body?.error === 'string' ? anyErr.body.error : undefined];
  return texts.some(t => typeof t === 'string' && CANCELLED_MESSAGE_RE.test(t));
};

const Chat: React.FC = () => {
  const router = useRouter();
  const theme = useTheme();
  const { t, tp } = useI18n();
  const { settings } = useStorage();
  const autoOpenMcpApps = settings?.experimental?.requireMcpAppLaunchClick !== true;
  const isCompactLayout = useMediaQuery(theme.breakpoints.down('lg'), { noSsr: true });
  const isPhoneLayout = useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
  // --- State Management ---
  // List of conversation summaries for the sidebar, fetched from backend
  const [conversationList, setConversationList] = useState<ConversationListItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(true);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [conversationPagination, setConversationPagination] = useState<{
    total: number;
    hasMore: boolean;
    nextCursor?: string;
  }>({ total: 0, hasMore: false });
  const conversationPaginationRef = useRef(conversationPagination);
  const loadedServerConversationCountRef = useRef(0);
  const updateConversationPagination = useCallback((next: typeof conversationPagination) => {
    conversationPaginationRef.current = next;
    setConversationPagination(next);
  }, []);

  // Full details of the currently selected conversation, fetched when selected
  const [detailedConversation, setDetailedConversation] = useState<Conversation | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState<boolean>(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  // Currently selected conversation ID (persisted)
  const [currentConversationId, setCurrentConversationIdStored] = useLocalStorage<string | null>(
    workspaceLocalStorageKey(StorageKey.CURRENT_CONVERSATION_ID),
    null
  );
  const currentConversationIdRef = useRef<string | null>(currentConversationId);
  const observedMcpAppResultIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const [autoOpenMcpAppResultIds, setAutoOpenMcpAppResultIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [mcpAppDismissalVersion, setMcpAppDismissalVersion] = useState(0);
  const dismissedMcpAppKeys = useMemo<ReadonlySet<string>>(() => (
    currentConversationId
      ? new Set(readDismissedMcpAppKeys(currentConversationId))
      : new Set<string>()
  ), [currentConversationId, mcpAppDismissalVersion]);
  const setMcpAppDismissed = useCallback((
    conversationId: string,
    appKey: string,
    dismissed: boolean,
  ) => {
    writeMcpAppDismissed(conversationId, appKey, dismissed);
    setMcpAppDismissalVersion((version) => version + 1);
  }, []);
  const handleMcpAppManualOpen = useCallback((appKey: string) => {
    const owner = currentConversationIdRef.current;
    if (owner) setMcpAppDismissed(owner, appKey, false);
  }, [setMcpAppDismissed]);
  // #375: sticky "the user collapsed the whole canvas" intent. Read into React
  // state (not ad-hoc localStorage reads) so it re-renders `shouldAutoOpen`.
  const [mcpAppAutoOpenSuppressionVersion, setMcpAppAutoOpenSuppressionVersion] = useState(0);
  const autoOpenMcpAppsSuppressed = useMemo(() => (
    currentConversationId ? readAutoOpenSuppressed(currentConversationId) : false
  ), [currentConversationId, mcpAppAutoOpenSuppressionVersion]);
  const setAutoOpenMcpAppsSuppressed = useCallback((
    conversationId: string,
    suppressed: boolean,
  ) => {
    writeAutoOpenSuppressed(conversationId, suppressed);
    setMcpAppAutoOpenSuppressionVersion((version) => version + 1);
  }, []);
  const canvasTeardownsRef = useRef<Map<string, () => Promise<void>>>(new Map());
  const conversationTransitionGenerationRef = useRef(0);
  /**
   * Conversation selection is the parent-owned lifecycle boundary for canvas
   * Views. Start every teardown synchronously (which invalidates each bridge and
   * emits ui/resource-teardown), then key the next dock by owner id so callbacks
   * can never bleed across conversations. Explicit close/LRU paths additionally
   * keep the subtree mounted for the bounded acknowledgement window.
   */
  const setCurrentConversationId = useCallback((nextId: string | null) => {
    const transitionGeneration = conversationTransitionGenerationRef.current + 1;
    conversationTransitionGenerationRef.current = transitionGeneration;
    const previousId = currentConversationIdRef.current;
    if (previousId === nextId) {
      setCurrentConversationIdStored(nextId);
      return;
    }
    const prefix = previousId ? `${previousId}\u0000` : null;
    const teardowns = prefix
      ? [...canvasTeardownsRef.current.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, callback]) => callback)
      : [];
    if (teardowns.length === 0) {
      currentConversationIdRef.current = nextId;
      setCurrentConversationIdStored(nextId);
      return;
    }

    // Keep the old subtree mounted until every View acknowledges
    // ui/resource-teardown or reaches its bounded one-second deadline. Rapid
    // selection changes are latest-wins and share each View's teardown promise.
    void Promise.allSettled(teardowns.map((callback) => callback())).then(() => {
      if (conversationTransitionGenerationRef.current !== transitionGeneration) return;
      currentConversationIdRef.current = nextId;
      setCurrentConversationIdStored(nextId);
    });
  }, [setCurrentConversationIdStored]);

  // Last flow the user MANUALLY picked in the flow selector (issue #134, item 6).
  // Persisted so a brand-new conversation defaults to it instead of always
  // falling back to the favorite/first flow.
  const [lastPickedFlowId, setLastPickedFlowId] = useLocalStorage<string | null>(
    StorageKey.LAST_PICKED_FLOW_ID,
    null
  );

  // State for ongoing chat completion requests (send/poll)
  const [isLoading, setIsLoading] = useState(false);
  // Which conversations currently have a run in flight. This is the per-conversation
  // source of truth for gating the input, so a run in one conversation no longer
  // disables the input of every other conversation (enables parallel use). It is
  // intentionally isolated from the single live-stream machinery (isLoading /
  // loadingConversationId), which still scopes the live indicator to the one
  // conversation being viewed.
  const [runningConvs, setRunningConvs] = useState<Set<string>>(new Set());
  const markConvRunning = useCallback((conversationId: string, running: boolean) => {
    if (!conversationId) return;
    setRunningConvs(prev => {
      if (running === prev.has(conversationId)) return prev;
      const next = new Set(prev);
      if (running) next.add(conversationId); else next.delete(conversationId);
      return next;
    });
  }, []);
  // Per-conversation FIFO queue of messages the user submitted while a run was
  // in flight (issue #177). Keyed by conversation id; drained one-at-a-time by
  // the drain effect once the conversation is idle and unblocked.
  const [queuedMessages, setQueuedMessages] = useState<QueueMap>({});
  // Guards the drain effect against re-entrancy (one dequeue per idle window).
  const drainingRef = useRef<boolean>(false);
  const [error, setError] = useState<string | null>(null); // General error display
  // Issue #383: normalized error (message + code/status/class/redacted
  // details) kept alongside `error` rather than replacing it, so this stays a
  // small additive diff across a ~5100-line file. `error` (the plain string)
  // keeps driving any existing consumer; `errorInfo` feeds ChatErrorDetails.
  const [errorInfo, setErrorInfo] = useState<NormalizedChatError | null>(null);
  const [subflowRecoveryOptions, setSubflowRecoveryOptions] = useState<SubflowRecoveryOptions | null>(null);
  const [subflowRecoveryScope, setSubflowRecoveryScope] = useState<SubflowRecoveryScope | null>(null);

  // Other states
  const [flows, setFlows] = useState<Flow[]>([]); // Use the Flow type from shared types
  const [requireApproval, setRequireApproval] = useState<boolean>(false);
  // Inline conversation-title rename (issue #134, item 2).
  const [isEditingTitle, setIsEditingTitle] = useState<boolean>(false);
  const [titleDraft, setTitleDraft] = useState<string>('');
  const [executeInDebugger, setExecuteInDebugger] = useState<boolean>(false); // State for debugger checkbox
  const [pendingToolCalls, setPendingToolCalls] = useState<OpenAI.ChatCompletionMessageFunctionToolCall[] | null>(null);
  const [pendingElicitation, setPendingElicitation] = useState<PendingElicitation | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  // Flow the user asked to switch an already-executed conversation to; a
  // confirmation dialog is shown before the switch is applied (Cancel discards).
  const [pendingFlowSwitch, setPendingFlowSwitch] = useState<string | null>(null);
  // Manually picked node for the NEXT message (the chat input's node picker).
  // null = automatic (follow the conversation). Cleared once a message is sent
  // with it, and on conversation switch.
  const [nodeOverride, setNodeOverride] = useState<string | null>(null);
  // Editing an existing message happens in the ChatInput (not inline in the
  // bubble). null = not editing. Carries the message id, the in-progress text,
  // and the picked process node.
  const [editingMessage, setEditingMessage] = useState<{ messageId: string; content: string; nodeId: string | null } | null>(null);
  const [isDebugPaused, setIsDebugPaused] = useState<boolean>(false); // State to control UI split
  const [debugState, setDebugState] = useState<SharedState | null>(null); // State to hold debug data
  // Whether a debug session is active (panel should stay open). Decoupled from
  // isDebugPaused so the debugger panel does NOT vanish while a step is executing
  // (between pauses) — it stays open and shows live progress, then re-populates
  // when the next pause arrives. Cleared when the session ends or is closed.
  const [debugSessionActive, setDebugSessionActive] = useState<boolean>(false);
  // The single Debugger control (one button, replacing the old "run in
  // debugger" checkbox + "attach to debugger" floater) opens the panel
  // IMMEDIATELY, before there is any debugState to show. This flag keeps it
  // open in that pending state: armed for the next run, or attaching to the
  // run that is already in flight. Cleared when the debugger is closed.
  const [debuggerRequested, setDebuggerRequested] = useState<boolean>(false);
  // An attach is in flight (wildcard breakpoint armed, waiting for the loop to
  // reach its next node) — drives the panel's spinner caption.
  const [debugAttaching, setDebugAttaching] = useState<boolean>(false);

  // User-resizable debugger panel width in px (0 = default 50%). Persisted so
  // the preferred split survives reloads. Adjusted by dragging the divider
  // between the chat and the debugger.
  const [debuggerWidth, setDebuggerWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const saved = Number(window.localStorage.getItem('flujo-debugger-width'));
    return Number.isFinite(saved) && saved > 0 ? saved : 0;
  });
  // Whether the debugger is shown in the large full-screen modal layout instead
  // of the docked side panel (issue #162). Persisted so the preference survives
  // reloads, like the docked width.
  const [debuggerExpanded, setDebuggerExpanded] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('flujo-debugger-expanded') === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('flujo-debugger-expanded', debuggerExpanded ? '1' : '0');
    }
  }, [debuggerExpanded]);

  // Executed-steps panel (issue #213): a hideable, resizable side panel that
  // renders the current conversation's flow and highlights the executed path.
  // Both preferences are UI-level (not per-conversation), so visibility/width
  // naturally persist when switching between conversations and across reloads.
  const [workflowPanelVisible, setWorkflowPanelVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('flujo-workflow-panel-visible') === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('flujo-workflow-panel-visible', workflowPanelVisible ? '1' : '0');
    }
  }, [workflowPanelVisible]);
  const [workflowPanelWidth, setWorkflowPanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 320;
    const saved = Number(window.localStorage.getItem('flujo-workflow-panel-width'));
    return Number.isFinite(saved) && saved > 0 ? saved : 320;
  });
  // Delta-based resize so the width is correct regardless of the panel's
  // position in the flex row (it may sit left of the debugger dock).
  const startWorkflowResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    let startWidth = 0;
    setWorkflowPanelWidth(w => { startWidth = w; return w; });
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      // Dragging the divider left (clientX decreases) grows the panel.
      const width = Math.min(
        Math.max(startWidth + (startX - ev.clientX), 240),
        Math.round(window.innerWidth * 0.7)
      );
      setWorkflowPanelWidth(width);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setWorkflowPanelWidth(w => {
        if (w > 0) window.localStorage.setItem('flujo-workflow-panel-width', String(Math.round(w)));
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const startDebuggerResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none'; // no text selection while dragging
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      // The debugger panel is flush right, so its width is the distance from
      // the pointer to the right window edge (clamped to sane bounds).
      const width = Math.min(
        Math.max(window.innerWidth - ev.clientX, 360),
        Math.round(window.innerWidth * 0.85)
      );
      setDebuggerWidth(width);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setDebuggerWidth(w => {
        if (w > 0) window.localStorage.setItem('flujo-debugger-width', String(Math.round(w)));
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // User-resizable conversation-list sidebar width in px. Persisted so the
  // preferred width survives reloads. Adjusted by dragging the divider between
  // the sidebar and the main chat area (mirrors the debugger-resize pattern).
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 300; // SSR-safe default (= old hardcoded width)
    const saved = Number(window.localStorage.getItem('flujo-chat-sidebar-width'));
    return Number.isFinite(saved) && saved > 0 ? saved : 300;
  });
  // Whether the sidebar is collapsed (hidden). Persisted across reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('flujo-chat-sidebar-collapsed') === '1';
  });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const effectiveSidebarCollapsed = isCompactLayout ? !mobileSidebarOpen : sidebarCollapsed;
  const toggleSidebarCollapsed = useCallback(() => {
    if (isCompactLayout) {
      setMobileSidebarOpen(open => !open);
      return;
    }
    setSidebarCollapsed(prev => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('flujo-chat-sidebar-collapsed', next ? '1' : '0');
      }
      return next;
    });
  }, [isCompactLayout]);
  const selectSidebarConversation = useStableCallback((conversationId: string) => {
    setCurrentConversationId(conversationId);
    if (isCompactLayout) setMobileSidebarOpen(false);
  });
  const startSidebarResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none'; // no text selection while dragging
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      // The sidebar is flush left, so its width is the distance from the left
      // window edge to the pointer (clamped to sane bounds).
      const width = Math.min(Math.max(ev.clientX, 220), 560);
      setSidebarWidth(width);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setSidebarWidth(w => {
        if (w > 0) window.localStorage.setItem('flujo-chat-sidebar-width', String(Math.round(w)));
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // Live execution stats, driven by the SSE event stream while a run is active.
  const [liveStats, setLiveStats] = useState<LiveRunStats | null>(null);
  // Issue #400: the server hit a bounded provider session/rate limit and is
  // WAITING before it replays the same model call. Carries the owning
  // conversation so a background run can never paint a countdown onto whatever
  // conversation is on screen. The deadline is absolute (server clock); the UI
  // only counts down to it and NEVER re-sends anything itself.
  const [retryWait, setRetryWait] = useState<
    { conversationId: string; attempt: number; maxAttempts?: number; retryAt: number } | null
  >(null);
  // Live node/resource activity (Tier 3): which nodes/artifacts the run is
  // touching RIGHT NOW, for canvas highlighting in the debugger. Entries decay
  // by age (LIVE_HIGHLIGHT_TTL_MS); pruned on each event application.
  const [liveActivity, setLiveActivity] = useState<LiveActivity>(EMPTY_LIVE_ACTIVITY);
  // Ordered, bounded source events for the visual debugger's subflow frame
  // model. The existing SSE consumer remains the only network subscription.
  const [debuggerEvents, setDebuggerEvents] = useState<ExecutionEvent[]>([]);
  // Per-child progress rows for Subflow job queues (issue #157). Pure
  // reducer state rebuilt from the SSE replay (from seq 0) on re-attach.
  const [liveLanes, setLiveLanes] = useState<LiveLanes>(EMPTY_LIVE_LANES);
  // Run-scoped `todo` list (issue #259): the full current checklist from the
  // latest `todo:update` SSE event, rebuilt from the bus replay on re-attach.
  const [currentTodos, setCurrentTodos] = useState<TodoEventItem[]>([]);
  // Node ids seen in the `node:enter` SSE stream, accumulated for the whole
  // conversation (issue #243). The other executed-path sources only cover
  // Process nodes; this stream covers EVERY node type, so it is what makes
  // start/finish/mcp/signal nodes light up green in the Executed-Steps panel.
  // Deliberately NOT cleared on run:done (it is the persistent post-run record)
  // — only reset when the viewed conversation changes (see effect below).
  const [sseVisitedNodeIds, setSseVisitedNodeIds] = useState<Set<string>>(new Set());
  // Breakpoint node IDs for the visual debugger (mirrors server state).
  const [breakpoints, setBreakpoints] = useState<string[]>([]);
  // Which conversation currently has an active run (so the live indicator only
  // shows for the conversation being viewed, not for background runs).
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);

  // Refs
  const openaiRef = useRef<OpenAI | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // The debugger toggle is defined before handleDebugClose (it is handed to the
  // composer); this ref lets it call the latest close/detach implementation.
  const handleDebugCloseRef = useRef<(() => Promise<void>) | null>(null);
  // Highest event seq applied, for ordering + dedupe across SSE reconnects.
  const lastSeqRef = useRef<number>(-1);
  const mcpAppContextsByConversationRef = useRef<Map<string, McpAppModelContextMap>>(
    new Map(),
  );
  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);
  // Conversations that exist only in this client (a split that hasn't been sent
  // yet): the periodic list refresh must not wipe them, and detail fetches for
  // them would 404. Ids drop out as soon as the backend starts returning them.
  const localOnlyConversationIdsRef = useRef<Set<string>>(new Set());
  // Silent sidebar refreshes share one request. If an event arrives while that
  // request is in flight, coalesce all such events into one trailing refresh
  // rather than overlapping list scans or losing the latest state.
  const silentListRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const silentListRefreshQueuedRef = useRef(false);
  // Conversations whose DELETE is in flight: a list refresh racing the delete
  // must not re-add them to the sidebar.
  const pendingDeleteIdsRef = useRef<Set<string>>(new Set());
  // Conversations the user just Stopped. A cancelled run ends server-side as
  // status 'error' with the message "Execution cancelled by user.", and the
  // in-flight completion promise rejects into the generic catch — which would
  // otherwise flash a scary "API Error: 500 Model execution failed" banner for
  // what was a deliberate Stop. This marker lets the send/edit/respond catches
  // suppress that, and drives a neutral "stopped" banner instead. Cleared when a
  // fresh run starts on the conversation (run:start / a new send).
  const stoppedConversationIdsRef = useRef<Set<string>>(new Set());
  // Mirror in state so the render reacts (a ref mutation alone wouldn't).
  const [stoppedConversationIds, setStoppedConversationIds] = useState<Set<string>>(new Set());
  const markConversationStopped = useCallback((conversationId: string, stopped: boolean) => {
    if (!conversationId) return;
    if (stopped) stoppedConversationIdsRef.current.add(conversationId);
    else stoppedConversationIdsRef.current.delete(conversationId);
    setStoppedConversationIds(new Set(stoppedConversationIdsRef.current));
  }, []);

  // --- Stick-to-bottom (chat autoscroll) ---
  // The messages area (rendered below) is the single scroll container. We keep it
  // pinned to the bottom as content streams in — but only while the user is
  // already at the bottom. Once they scroll up to read, we stop yanking them down
  // and surface a "jump to latest" button instead. (This replaces the old
  // new-message-only scrollIntoView in ChatMessages, which had no position
  // awareness and did not follow in-place streaming updates.)
  // Scroll navigation (#376): the hook owns the container ref, the sticky
  // autoscroll flag, the mobile auto-hide timer and the three chat actions
  // (top of the loaded window / beginning of the last message / latest).
  const chatScrollNav = useChatScrollNav({
    conversationId: currentConversationId,
    messages: detailedConversation?.messages,
  });
  // Mirror of the conversation whose run we are currently tracking, so the
  // re-attach effect can tell "already tracking" from "needs re-attach" without
  // taking loadingConversationId as a dependency (which would re-fire the effect
  // as soon as it sets it). Declared before the re-attach effect so its sync
  // runs first within a commit.
  const loadingConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    loadingConversationIdRef.current = loadingConversationId;
  }, [loadingConversationId]);

  // --- Effects ---

  // Initialize OpenAI client
  useEffect(() => {
    const baseURL = window.location.origin + '/v1';
    openaiRef.current = new OpenAI({
      baseURL,
      apiKey: 'FLUJO', // Replace with actual key if needed, though likely handled by backend proxy
      dangerouslyAllowBrowser: true,
      maxRetries: 0, // Add this line to disable automatic retries
      // A flow run is one blocking request that can take a long time (long
      // agentic loops, slow external tools). Use the shared generous ceiling so
      // the browser doesn't abort a healthy run and discard the whole result.
      timeout: LLM_REQUEST_TIMEOUT_MS,
    });
  }, []);

  // Load available flows on mount
  useEffect(() => {
    const loadFlows = async () => {
      log.debug('Loading flows');
      try {
        const loadedFlows = await flowService.loadFlows();
        setFlows(loadedFlows);
      } catch (error) {
        log.error('Error loading flows:', error);
        // Optionally set an error state for flows
      }
    };
    loadFlows();
  }, []);

  // Fetch conversation list from backend on mount
  const fetchConversations = useCallback((
    selectIdAfterFetch?: string | null,
    options?: { silent?: boolean }
  ): Promise<void> => {
    // `silent` refreshes the list in place (e.g. after a background run finishes
    // to pick up the server-generated title) without flashing the loading
    // spinner or wiping the sidebar on a transient error.
    const silent = options?.silent ?? false;
    const run = async (): Promise<void> => {
      log.debug('Fetching conversation list from backend', { silent });
      if (!silent) {
        setIsLoadingHistory(true);
        setHistoryError(null);
      }
      let fetchedList: ConversationListItem[] = [];
      let fetchFailed = false;
      try {
        const targetCount = silent
          ? Math.max(SIDEBAR_PAGE_SIZE, loadedServerConversationCountRef.current)
          : SIDEBAR_PAGE_SIZE;
        let page = await chatService.listConversationPage({
          limit: Math.min(200, targetCount),
        });
        const serverItems = [...page.items];
        while (serverItems.length < targetCount && page.nextCursor) {
          page = await chatService.listConversationPage({
            limit: Math.min(200, targetCount - serverItems.length),
            cursor: page.nextCursor,
          });
          serverItems.push(...page.items);
        }
        fetchedList = serverItems
          // Never re-add a conversation whose DELETE is still in flight.
          .filter(c => !pendingDeleteIdsRef.current.has(c.id))
          .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt));
        loadedServerConversationCountRef.current = fetchedList.length;
        updateConversationPagination({
          total: page.total,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        });
        // Anything the backend returns is no longer client-only.
        for (const c of fetchedList) localOnlyConversationIdsRef.current.delete(c.id);
        setConversationList(prev => {
          // Preserve client-only conversations (an unsent split) — the server
          // list can't contain them yet.
          const localOnly = prev.filter(c => localOnlyConversationIdsRef.current.has(c.id));
          // A selected older row can be displaced from the refreshed prefix by
          // new conversations. Keep it reachable until the user changes pages;
          // a later page merge deduplicates it by id.
          const selected = prev.find(c =>
            c.id === currentConversationIdRef.current
            && !localOnlyConversationIdsRef.current.has(c.id)
            && !fetchedList.some(item => item.id === c.id)
          );
          const next = [...localOnly, ...fetchedList, ...(selected ? [selected] : [])]
            .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt));
          // Keep the previous array identity when nothing changed, so a silent
          // refresh doesn't re-render the sidebar for no reason.
          return sameConversationLists(prev, next) ? prev : next;
        });
        log.info(`Fetched ${fetchedList.length} conversations for the list`);
      } catch (err) {
        fetchFailed = true;
        log.error('Error fetching conversation list:', err);
        if (!silent) {
          setHistoryError(t('chat.page.historyLoadFailed'));
          setConversationList([]); // Clear list on error
          loadedServerConversationCountRef.current = 0;
          updateConversationPagination({ total: 0, hasMore: false });
        }
      } finally {
        if (!silent) setIsLoadingHistory(false);

        // A silent refresh must never change the current selection.
        if (silent || fetchFailed) {
          return;
        }

        // --- Auto-selection logic ---
        // Read the live selection from the ref to avoid acting on a stale value
        // captured when this callback was memoized.
        const idToSelect = selectIdAfterFetch !== undefined ? selectIdAfterFetch : currentConversationIdRef.current;

        const liveSelection = currentConversationIdRef.current;
        // Client-only conversations (unsent splits) count as existing too.
        const idExists = (id: string) =>
          fetchedList.some(c => c.id === id) || localOnlyConversationIdsRef.current.has(id);
        if (idToSelect && (idExists(idToSelect) || selectIdAfterFetch === undefined)) {
           // If the intended ID exists in the new list, ensure it's selected
           if (idToSelect !== liveSelection) {
              log.debug(`Setting currentConversationId to ${idToSelect} after fetch/operation.`);
              setCurrentConversationId(idToSelect);
           }
        } else if (fetchedList.length > 0) {
           // If intended ID is invalid or null, select the most recent
           const mostRecentId = fetchedList[0].id;
           if (mostRecentId !== liveSelection) {
              log.debug(`Selecting most recent conversation ${mostRecentId} after fetch/operation.`);
              setCurrentConversationId(mostRecentId);
           }
        } else {
           // No backend conversations left. Don't clear a selection pointing at a
           // client-only conversation (an unsent split).
           if (liveSelection !== null && !localOnlyConversationIdsRef.current.has(liveSelection)) {
              log.debug('No conversations available after fetch/operation, clearing selection.');
              setCurrentConversationId(null);
           }
        }
      }
    };

    if (!silent) return run();

    if (silentListRefreshInFlightRef.current) {
      silentListRefreshQueuedRef.current = true;
      return silentListRefreshInFlightRef.current;
    }

    const drainRefreshes = async () => {
      do {
        silentListRefreshQueuedRef.current = false;
        await run();
      } while (silentListRefreshQueuedRef.current);
    };
    const trackedRequest = drainRefreshes().finally(() => {
      if (silentListRefreshInFlightRef.current === trackedRequest) {
        silentListRefreshInFlightRef.current = null;
      }
    });
    silentListRefreshInFlightRef.current = trackedRequest;
    return trackedRequest;
  }, [setCurrentConversationId, t, updateConversationPagination]); // Include dependencies that affect auto-selection logic if needed

  const loadMoreConversations = useCallback(async (): Promise<void> => {
    const cursor = conversationPaginationRef.current.nextCursor;
    if (!cursor || isLoadingMoreHistory) return;
    setIsLoadingMoreHistory(true);
    try {
      const page = await chatService.listConversationPage({
        limit: SIDEBAR_PAGE_SIZE,
        cursor,
      });
      const incoming = page.items.filter(c => !pendingDeleteIdsRef.current.has(c.id));
      setConversationList(prev => {
        const byId = new Map(prev.map(item => [item.id, item]));
        for (const item of incoming) byId.set(item.id, item);
        const next = [...byId.values()]
          .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt));
        return sameConversationLists(prev, next) ? prev : next;
      });
      loadedServerConversationCountRef.current += incoming.filter(
        item => !localOnlyConversationIdsRef.current.has(item.id),
      ).length;
      updateConversationPagination({
        total: page.total,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      log.error('Could not load the next conversation page', error);
      setHistoryError(t('chat.page.historyLoadFailed'));
    } finally {
      setIsLoadingMoreHistory(false);
    }
  }, [isLoadingMoreHistory, t, updateConversationPagination]);

  const loadAllConversations = useCallback(async (): Promise<ConversationListItem[]> => {
    const fetched = (await chatService.listAllConversationPages())
      .filter(c => !pendingDeleteIdsRef.current.has(c.id))
      .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt));
    loadedServerConversationCountRef.current = fetched.length;
    updateConversationPagination({ total: fetched.length, hasMore: false });
    const localOnly = conversationList.filter(c => localOnlyConversationIdsRef.current.has(c.id));
    const merged = [...localOnly, ...fetched]
      .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt));
    setConversationList(prev => sameConversationLists(prev, merged) ? prev : merged);
    return merged;
  }, [conversationList, updateConversationPagination]);

  useEffect(() => {
    // Fetch initial list on mount
    fetchConversations();
  }, []); // Empty array ensures this runs only once on mount

  // Keep the sidebar live from the server's filtered global lifecycle stream.
  // A slow timeout remains as a safety net for non-execution changes (for
  // example, another tab creating or renaming an idle conversation). Unlike an
  // interval, it schedules only after the previous request settles, and all
  // refreshes pause while the tab is hidden.
  useEffect(() => {
    const FALLBACK_REFRESH_MS = 30_000;
    const EVENT_DEBOUNCE_MS = 200;
    const MIN_EVENT_REFRESH_MS = 5_000;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let eventTimer: ReturnType<typeof setTimeout> | null = null;
    let sidebarEvents: EventSource | null = null;
    let disposed = false;
    let lastRefreshStartedAt = 0;

    const clearTimers = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (eventTimer) clearTimeout(eventTimer);
      fallbackTimer = null;
      eventTimer = null;
    };
    const scheduleFallback = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (disposed || document.visibilityState !== 'visible') return;
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        lastRefreshStartedAt = Date.now();
        void fetchConversations(undefined, { silent: true }).finally(scheduleFallback);
      }, FALLBACK_REFRESH_MS);
    };
    const refreshFromEvent = () => {
      if (disposed || document.visibilityState !== 'visible') return;
      // One scheduled refresh represents every lifecycle event in its window.
      // This preserves the old five-second worst-case cadence under a large
      // subflow queue instead of turning each child start/done into a scan.
      if (eventTimer) return;
      const sinceLastRefresh = Date.now() - lastRefreshStartedAt;
      const delay = Math.max(EVENT_DEBOUNCE_MS, MIN_EVENT_REFRESH_MS - sinceLastRefresh);
      eventTimer = setTimeout(() => {
        eventTimer = null;
        lastRefreshStartedAt = Date.now();
        void fetchConversations(undefined, { silent: true }).finally(scheduleFallback);
      }, delay);
    };
    const connect = () => {
      if (sidebarEvents || disposed || document.visibilityState !== 'visible') return;
      sidebarEvents = chatService.subscribeToSidebarEvents({
        onEvent: refreshFromEvent,
      });
    };
    const disconnect = () => {
      sidebarEvents?.close();
      sidebarEvents = null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        clearTimers();
        disconnect();
        return;
      }
      connect();
      lastRefreshStartedAt = Date.now();
      void fetchConversations(undefined, { silent: true }).finally(scheduleFallback);
    };

    lastRefreshStartedAt = Date.now(); // the mount effect just started the initial list load
    connect();
    scheduleFallback();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      clearTimers();
      disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchConversations]);

  // Fetch detailed conversation when ID changes
  const fetchDetailedConversation = useCallback(async (id: string) => {
    // Client-only conversations (an unsent split) don't exist on the backend;
    // fetching would 404 and clobber the locally-set detailed view.
    if (localOnlyConversationIdsRef.current.has(id)) {
      log.debug('Skipping detail fetch for client-only conversation', { conversationId: id });
      return;
    }
    // Only the VIEWED conversation renders details. A caller reconciling a
    // background conversation (its run finished while another one is on
    // screen) must not blank the on-screen messages — the setters below run
    // before the stale-response guard could catch it. The sidebar summary is
    // all a background conversation needs, so refresh the list instead.
    if (currentConversationIdRef.current !== id) {
      log.debug('Detail fetch requested for non-viewed conversation; refreshing list instead', { conversationId: id });
      fetchConversations(undefined, { silent: true });
      return;
    }
    log.debug('Fetching detailed conversation', { conversationId: id });
    setIsLoadingDetails(true);
    setDetailsError(null);
    // Do NOT eagerly null out detailedConversation here (#221): clearing it
    // before the fetch resolves creates a gap where any optimistic user bubble
    // pushed by the drain effect is lost. We replace it atomically below once
    // the server response arrives.
    try {
      // Use the endpoint that returns the full state
      const conversation = await chatService.getConversation(id);

      // Guard against an out-of-order response: if the user switched to a
      // different conversation while this request was in flight, a late reply
      // must not clobber the newer selection's view.
      if (currentConversationIdRef.current !== id) {
        log.debug('Discarding stale detailed conversation response', {
          fetchedId: id,
          currentId: currentConversationIdRef.current,
        });
        return;
      }

      if (
        conversation.mcpAppContexts !== undefined
        && !mcpAppContextsByConversationRef.current.has(id)
      ) {
        mcpAppContextsByConversationRef.current.set(
          id,
          { ...conversation.mcpAppContexts },
        );
      }
      setDetailedConversation(conversation);
      // Issue #383 (gap 2): rehydrate the error message + code from the
      // server so it survives a reload or re-selecting an older errored
      // conversation from the sidebar — previously only a live SSE `error`
      // event ever populated this.
      if (conversation.status === 'error' && conversation.lastError) {
        setErrorInfo(conversation.lastError);
      } else if (conversation.status !== 'error') {
        setErrorInfo(null);
      }
      // Reconcile the sidebar summary with server truth. The backend derives a
      // title from the first user message during a run, but completion/SSE
      // responses don't echo it — without this the list keeps showing
      // "New Conversation" until a full reload.
      setConversationList(prevList =>
        prevList.map(c =>
          c.id === id
            ? {
                ...c,
                title: conversation.title,
                flowId: conversation.flowId,
                updatedAt: conversation.updatedAt,
                // Status too — without it the sidebar dot for the viewed
                // conversation stayed stale (e.g. 'running' after completion).
                status: conversation.status ?? c.status,
              }
            : c
        ).sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt))
      );
      log.info('Fetched detailed conversation successfully', { conversationId: id });
    } catch (err: any) { // Use any for error checking
       log.error('Error fetching detailed conversation:', { conversationId: id, err });
       // Ignore errors for a selection that is no longer current.
       if (currentConversationIdRef.current !== id) return;
       if (err instanceof ChatApiError && err.status === 404) {
          setDetailsError(t('chat.page.conversationNotFound', { id }));
          // Clear the invalid selection and refresh the list
          setCurrentConversationId(null);
          fetchConversations(); // Refresh list and auto-select valid one
       } else {
          setDetailsError(t('chat.page.detailsLoadFailed', { id }));
       }
      setDetailedConversation(null);
    } finally {
      // Only clear the loading flag if this fetch still owns the view; otherwise
      // a newer in-flight fetch manages its own loading state.
      if (currentConversationIdRef.current === id) {
        setIsLoadingDetails(false);
      }
    }
  }, [fetchConversations, setCurrentConversationId, t]); // currentConversationId read via ref

  useEffect(() => {
    // Switching conversations: drop any approval prompt belonging to the previous
    // one so it can't linger on the newly-viewed conversation. The correct prompt
    // re-appears from the (replayed) event stream if the now-viewed conversation
    // is itself awaiting approval.
    setPendingToolCalls(null);
    // A manual node pick belongs to the conversation it was made in.
    setNodeOverride(null);
    if (currentConversationId) {
      fetchDetailedConversation(currentConversationId);
    } else {
      // Clear details if no conversation is selected
      setDetailedConversation(null);
      setIsLoadingDetails(false);
      setDetailsError(null);
    }
  }, [currentConversationId, fetchDetailedConversation]); // Trigger fetch when selection changes

  // Treat the first message snapshot for a conversation as passive hydration.
  // Only result ids appended after that baseline are eligible for the default
  // auto-open policy, so revisiting/reloading history cannot resurrect Apps.
  useEffect(() => {
    const conversationId = detailedConversation?.id;
    if (!conversationId || conversationId !== currentConversationId) {
      setAutoOpenMcpAppResultIds((current) => current.size === 0 ? current : new Set());
      return;
    }

    const fresh = observeNewMcpAppResultIds(
      observedMcpAppResultIdsRef.current,
      conversationId,
      detailedConversation.messages,
    );
    if (fresh.length === 0) return;
    setAutoOpenMcpAppResultIds(new Set(latestMcpAppResultIdsByResource(
      detailedConversation.messages,
      fresh,
    )));
  }, [currentConversationId, detailedConversation?.id, detailedConversation?.messages]);

  // The child latches the positive auto-launch command. Retire transient ids so
  // a later render-window remount cannot replay the same historical launch.
  useEffect(() => {
    if (autoOpenMcpAppResultIds.size === 0) return undefined;
    const timer = window.setTimeout(() => setAutoOpenMcpAppResultIds(new Set()), 1_500);
    return () => window.clearTimeout(timer);
  }, [autoOpenMcpAppResultIds]);

  const recoveryParentSummary = detailedConversation?.parentConversationId
    ? conversationList.find((conversation) => conversation.id === detailedConversation.parentConversationId)
    : undefined;

  useEffect(() => {
    const conversationId = detailedConversation?.id;
    const shouldLoad = Boolean(
      conversationId &&
      detailedConversation?.status === 'error',
    );
    if (!shouldLoad || !conversationId) {
      setSubflowRecoveryOptions(null);
      return;
    }
    let disposed = false;
    void chatService.getSubflowRecoveryOptions(conversationId)
      .then((options) => {
        if (!disposed) setSubflowRecoveryOptions(options.hasRecoverableFamily ? options : null);
      })
      .catch((err) => {
        log.warn('Could not load subflow recovery options', { conversationId, err });
        if (!disposed) setSubflowRecoveryOptions(null);
      });
    return () => { disposed = true; };
  }, [
    detailedConversation?.id,
    detailedConversation?.parentConversationId,
    detailedConversation?.status,
    recoveryParentSummary?.status,
    recoveryParentSummary?.updatedAt,
    recoveryParentSummary?.recovery?.updatedAt,
  ]);

  // Reflect the viewed conversation's persisted "Require Tool Approval" setting in
  // the checkbox. Keyed on the conversation id so it only re-syncs on a switch, not
  // on every content refresh (which would clobber a just-toggled value mid-run).
  useEffect(() => {
    if (detailedConversation) {
      setRequireApproval(detailedConversation.requireApproval ?? false);
    }
  }, [detailedConversation?.id]);

  // Toggle handler: update the checkbox and immediately persist the setting on the
  // conversation. A brand-new, not-yet-persisted conversation may 404 — harmless,
  // since the value is also sent with the next run and persisted onto the state then.
  const handleRequireApprovalChange = useCallback(async (value: boolean) => {
    setRequireApproval(value);
    if (currentConversationId) {
      try {
        await chatService.updateConversationApproval(currentConversationId, value);
      } catch (err) {
        log.warn('Failed to persist requireApproval setting', { conversationId: currentConversationId, err });
      }
    }
  }, [currentConversationId]);

  // --- Conversation Management Functions ---

  // Get current conversation summary from the list for UI elements
  const currentConversationSummary = conversationList.find(
    (conv) => conv.id === currentConversationId
  ) || null;

  // flowId → flow name map for the sidebar, so each conversation can show which
  // flow it used (issue #147). Memoized off the loaded flows list; quick-chat
  // pseudo-flows are labelled from their id inside ChatHistory.
  const flowNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of flows) {
      if (f.id) map[f.id] = f.name;
    }
    return map;
  }, [flows]);

  // Nodes of the conversation's flow, for message attribution + the edit
  // dropdown. Memoized: a fresh array per render would defeat the memoized
  // message bubbles (prop identity would change on every SSE event).
  // The conversation's full flow definition — pre-rendered by the visual node
  // picker (FlowNodePicker) so the user picks a node from the graph, not a flat
  // list. Referentially stable while the flow doesn't change (safe to hand to
  // memoized children).
  const currentFlow = useMemo(
    () => flows.find(f => f.id === detailedConversation?.flowId) || null,
    [flows, detailedConversation?.flowId]
  );

  const handleAskFlujoAction = useCallback((action: AskFlujoUiAction) => {
    if (action.target.kind === 'chat-message' && action.target.id && action.type === 'highlight') {
      const target = [...document.querySelectorAll('[data-ask-flujo-message-id]')]
        .find(element => element.getAttribute('data-ask-flujo-message-id') === action.target.id) ?? null;
      const highlighted = highlightAskFlujoElement(target);
      return { success: highlighted, message: highlighted ? 'Highlighted the conversation message.' : 'That message is not currently visible.' };
    }
    if (action.target.kind === 'chat-field' && action.target.field === 'title') {
      if (action.type === 'highlight') {
        const highlighted = highlightAskFlujoElement(document.querySelector('[data-ask-flujo-chat-title]'));
        return { success: highlighted, message: highlighted ? 'Highlighted the conversation title.' : 'The title is not currently visible.' };
      }
      if (typeof action.value !== 'string' || !action.value.trim()) {
        return { success: false, message: 'The conversation title must be non-empty text.' };
      }
      setTitleDraft(action.value);
      setIsEditingTitle(true);
      return { success: true, message: 'Updated the title field. Confirm it with the normal save control.' };
    }
    return { success: false, message: 'That conversation UI target is not supported.' };
  }, []);

  useAskFlujoPage({
    scopeId: detailedConversation ? `chat:${detailedConversation.id}` : 'chat:none',
    pageType: 'chat',
    route: '/chat',
    title: detailedConversation?.title ?? t('nav.talk'),
    identifiers: {
      conversationId: detailedConversation?.id ?? currentConversationId,
      flowId: detailedConversation?.flowId ?? null,
    },
    data: {
      conversation: detailedConversation,
      selectedFlow: currentFlow,
      requireApproval,
      executeInDebugger,
    },
    capabilities: {
      highlightTargets: [
        ...(detailedConversation?.messages ?? []).map(message => ({
          kind: 'chat-message',
          id: message.id,
          role: message.role,
          processNodeId: message.processNodeId,
        })),
        { kind: 'chat-field', field: 'title' },
      ],
      editableTargets: [{ kind: 'chat-field', field: 'title' }],
      notes: ['The conversation id and flow id are always supplied explicitly.'],
    },
  }, handleAskFlujoAction, 100);

  const availableNodes = useMemo(
    () =>
      currentFlow?.nodes?.map(node => ({
        id: node.id,
        label: node.data.label || node.id,
      })) || [],
    [currentFlow]
  );

  // Node ids actually executed in this conversation, for the Executed-Steps
  // panel (issue #213). Union of three graceful-fallback sources so the path is
  // recoverable whether or not the run's SharedState is currently hydrated:
  //  1. per-message processNodeId (append-style log, always on old convos),
  //  2. the nodeExecutionTracker (populated in debug + normal runs),
  //  3. the executionTrace (debug mode only).
  // Only visited nodes are added, so an untaken branch (B xor C) stays dimmed.
  const executedNodeIds = useMemo(() => deriveExecutedNodeIds({
    messages: detailedConversation?.messages,
    nodeExecutionTracker: debugState?.trackingInfo?.nodeExecutionTracker,
    executionTrace: debugState?.executionTrace,
    sseVisitedIds: sseVisitedNodeIds,
  }), [detailedConversation?.messages, debugState, sseVisitedNodeIds]);

  // Reset the SSE-accumulated visited set when the viewed conversation changes
  // so a previous conversation's executed nodes never bleed into another
  // (issue #243). Same-conversation refetches keep the same id and don't clear.
  useEffect(() => {
    setSseVisitedNodeIds(new Set());
    setDebuggerEvents([]);
  }, [detailedConversation?.id]);

  // The node the NEXT message will be processed on, for the chat input's node
  // pill: a manual pick wins, then the server's currentNodeId, then the most
  // recent assistant message's node, then the flow's start node. Ids that don't
  // exist in the current flow (e.g. left over from a flow switch) are skipped.
  const currentNodeId = useMemo(() => {
    const isValid = (id?: string | null): id is string =>
      !!id && availableNodes.some(n => n.id === id);
    if (isValid(nodeOverride)) return nodeOverride;
    if (isValid(detailedConversation?.currentNodeId)) return detailedConversation!.currentNodeId!;
    const msgs = detailedConversation?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === 'assistant' && isValid(msg.processNodeId)) return msg.processNodeId!;
    }
    return availableNodes[0]?.id ?? null;
  }, [nodeOverride, detailedConversation, availableNodes]);

  // Create a new conversation (now persists to backend immediately)
  const createNewConversation = async (explicitFlowId?: string) => {
    log.debug('Attempting to create new conversation');
    setError(null); // Clear previous errors
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error

    // Determine the flowId - backend requires a non-null string.
    // An explicit flow (the "Start conversation" deep link from the Flow
    // Dashboard / FlowBuilder header, issue #148) wins when it points at a real
    // flow; otherwise prefer the last MANUALLY picked flow if it still exists
    // (issue #134, item 6), then the first favorited flow (#120), then the first
    // flow. `explicitFlowId` is guarded with typeof because this handler is also
    // wired directly to a button onClick, which would otherwise pass a MouseEvent.
    const explicitFlow =
      typeof explicitFlowId === 'string' && !isQuickChatFlowId(explicitFlowId)
        ? flows.find(f => f.id === explicitFlowId)
        : undefined;
    const rememberedFlow =
      lastPickedFlowId && !isQuickChatFlowId(lastPickedFlowId)
        ? flows.find(f => f.id === lastPickedFlowId)
        : undefined;
    const selectedFlowId = (explicitFlow ?? rememberedFlow ?? flows.find(f => f.favorite) ?? flows[0])?.id || null;
    if (!selectedFlowId) {
      log.error('Cannot create conversation: No flows available or first flow has no ID.');
      setError(t('chat.page.noAgents'));
      return;
    }

    const newId = uuidv4();
    const now = Date.now();
    const initialTitle = t('chat.page.newTitle');

    // Prepare payload for the backend POST request
    const payload = {
      id: newId,
      title: initialTitle,
      flowId: selectedFlowId, // Use the determined flowId
      createdAt: now,
      updatedAt: now,
    };

    try {
      log.info('Sending request to create conversation on backend', { payload: JSON.stringify(payload) });
      // Make the POST request to the backend endpoint
      const createdConversationSummary = await chatService.createConversation(payload);
      log.info('Successfully created conversation on backend', { conversationId: createdConversationSummary.id });

      // Update UI state *after* successful backend creation
      setConversationList(prevList =>
        [createdConversationSummary, ...prevList].sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt)) // Add and re-sort
      );
      setCurrentConversationId(createdConversationSummary.id); // Select the new one

      // Set basic detailed view based on the created summary
      setDetailedConversation({
        id: createdConversationSummary.id,
        title: createdConversationSummary.title,
        flowId: createdConversationSummary.flowId,
        createdAt: createdConversationSummary.createdAt,
        updatedAt: createdConversationSummary.updatedAt,
        messages: [], // Start with empty messages
      });
      setIsLoadingDetails(false); // Ensure loading is off for the new view
      setDetailsError(null); // Clear any previous errors

    } catch (err) {
      log.error('Error creating conversation on backend:', err);
      let errorMsg = t('chat.page.createFailed');
      if (err instanceof ChatApiError) {
        errorMsg += ` (${err.body?.error || err.message})`;
      } else if (err instanceof Error) {
        errorMsg += ` (${err.message})`;
      }
      setError(errorMsg);
      // Do not update UI state if backend creation failed
    }
  };

  // Deep link: ?flow=<id> starts a NEW conversation bound to that flow (issue
  // #148 — the "Start conversation" buttons on the Flow Dashboard and the
  // FlowBuilder header route here). Fires once flows have loaded so we only bind
  // to a flow that actually exists; an unknown or quick-chat id is ignored. The
  // param is cleared afterward so a refresh doesn't spawn another conversation.
  useEntityDeepLink({
    param: 'flow',
    ready: flows.length > 0,
    exists: (id) => flows.some(f => f.id === id) && !isQuickChatFlowId(id),
    onResolve: (id) => createNewConversation(id),
    consume: true,
    replacePath: '/chat',
  });

  // --- Quick actions "New Chat" (issue #396) --------------------------------
  // The bottom-left quick-actions menu lives in Navigation, but the standard
  // creation flow lives here, so the menu only expresses an INTENT and this
  // component performs it through the very same `createNewConversation`
  // (flow-selection priority, list/current/detail updates, error handling).
  // Two transports, one meaning:
  //   * `/chat?new=<token>` when the menu is used from another route (this page
  //     mounts and consumes the param, which is then stripped from the URL);
  //   * a window event when the menu is used while `/chat` is already on screen
  //     (pushing the same route would not re-run any deep link).
  // `consumeQuickActionToken` claims the token, so a request that somehow
  // arrives twice (Strict Mode, Back/Forward replay, both transports) still
  // creates exactly one conversation.
  const startQuickActionConversation = useStableCallback(() => {
    void createNewConversation();
  });

  useEntityDeepLink({
    param: NEW_CHAT_PARAM,
    ready: flows.length > 0,
    exists: (token) => isQuickActionTokenPending(token),
    onResolve: (token) => {
      if (consumeQuickActionToken(token)) startQuickActionConversation();
    },
    consume: true,
    replacePath: '/chat',
  });

  useEffect(() => subscribeNewChatRequests((token) => {
    if (consumeQuickActionToken(token)) startQuickActionConversation();
  }), [startQuickActionConversation]);

  // --- URL-originated sidebar reveal (issue #397) ---------------------------
  // A chat opened through a URL must not only be selected, it must be made
  // VISIBLE in the sidebar: materialized across pagination, un-collapsed and
  // scrolled into view. That intent is carried by a one-shot request object
  // rather than by `currentConversationId`, so ordinary clicks, list refreshes
  // and streamed updates keep their current (silent) behavior.
  const [sidebarRevealRequest, setSidebarRevealRequest] = useState<ChatRevealRequest | null>(null);
  const sidebarRevealKeyRef = useRef(0);
  const requestSidebarReveal = useCallback((id: string) => {
    sidebarRevealKeyRef.current += 1;
    setSidebarRevealRequest({ id, requestKey: sidebarRevealKeyRef.current });
  }, []);

  // Latest id the URL asked for, plus an in-flight guard, so a slow
  // "load every page" response can never select/reveal a stale conversation
  // after the user has navigated on.
  const deepLinkConversationIdRef = useRef<string | null>(null);
  const deepLinkMaterializingRef = useRef(false);
  const resolveConversationDeepLink = useCallback((id: string) => {
    deepLinkConversationIdRef.current = id;

    // Already on a loaded page → select + reveal immediately.
    if (conversationList.some((c) => c.id === id)) {
      setCurrentConversationId(id);
      requestSidebarReveal(id);
      return;
    }

    // Outside the loaded window: materialize every page through the existing
    // bulk loader (it filters pending deletes, merges local-only rows, sorts
    // and updates pagination) and only then decide.
    if (!conversationPaginationRef.current.hasMore || deepLinkMaterializingRef.current) {
      log.warn('Conversation deep link target does not exist, ignoring', { id });
      return;
    }
    deepLinkMaterializingRef.current = true;
    void loadAllConversations()
      .then((merged) => {
        if (deepLinkConversationIdRef.current !== id) return; // superseded by a newer URL
        if (!merged.some((c) => c.id === id)) {
          log.warn('Conversation deep link target does not exist, ignoring', { id });
          return;
        }
        setCurrentConversationId(id);
        requestSidebarReveal(id);
      })
      .catch((error) => {
        log.warn('Could not materialize conversation deep link target', { id, error });
      })
      .finally(() => {
        deepLinkMaterializingRef.current = false;
      });
  }, [conversationList, loadAllConversations, requestSidebarReveal, setCurrentConversationId]);

  // Deep link: `?conversation=<id>` selects an existing conversation (issue
  // #374 — `magicLink.ts` has built this link since Phase 1, but nothing
  // consumed it). Durable (not consumed): kept in the URL so refresh/Back
  // keep pointing at the same conversation, mirroring the `?flow=<id>&mode=edit`
  // pattern in `/flows`. Fires once the conversation list has loaded so an
  // unknown id is reliably rejected rather than raced.
  useEntityDeepLink({
    param: 'conversation',
    ready: !isLoadingHistory,
    // The sidebar is paginated, so "not on the loaded page" is NOT the same as
    // "does not exist" (#397). Accept the id when more pages exist and let
    // `resolveConversationDeepLink` materialize + verify it before selecting.
    exists: (id) =>
      conversationList.some((c) => c.id === id) || conversationPaginationRef.current.hasMore,
    onResolve: (id) => resolveConversationDeepLink(id),
  });

  // #374: `?message=<id>` (optionally alongside `?conversation=<id>`) scrolls
  // to and briefly highlights a specific message once the selected
  // conversation's messages have loaded. One-shot: cleared from the URL after
  // resolving so it doesn't keep re-triggering the scroll on every refresh.
  const [anchorMessageId, setAnchorMessageId] = useState<string | null>(null);
  useEntityDeepLink({
    param: 'message',
    ready: !isLoadingDetails && !!detailedConversation && detailedConversation.id === currentConversationId,
    exists: (id) => !!detailedConversation?.messages?.some((m) => m.id === id),
    onResolve: (id) => setAnchorMessageId(id),
    consume: true,
    // Drop only `?message=`; keep the conversation magic link in the URL (#398)
    // so the navbar link survives a message deep link.
    replacePath: currentConversationId
      ? magicLinkPath({ kind: 'conversation', id: currentConversationId })
      : '/chat',
  });

  /**
   * #398: keep the canonical conversation magic link in the address bar so the
   * navbar (and the browser itself) always exposes a shareable URL for whatever
   * chat is on screen. Every selection path — sidebar click, newly created
   * conversation, post-delete fallback, deep link — funnels through
   * `currentConversationId`, so synchronizing here covers all of them without
   * sprinkling router calls over individual controls.
   *
   * Ordering matters: this effect is declared *after* the `?conversation=`
   * deep-link hook, so on the render where the history finishes loading the
   * inbound link has already selected its target (which updates
   * `currentConversationIdRef` synchronously) and we never overwrite an inbound
   * link with the previously persisted conversation. While the list is still
   * loading — or a paginated deep-link target is still being materialized — the
   * query stays untouched and remains the source of truth.
   *
   * `replace` (not `push`) so a session of sidebar clicks does not bury the
   * previous page under one history entry per conversation.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isLoadingHistory || deepLinkMaterializingRef.current) return;

    const params = new URLSearchParams(window.location.search);

    // `?flow=`, `?message=` and `?new=` are one-shot links consumed by their
    // own hooks (which then rewrite the URL themselves, `?message=` back to the
    // canonical conversation link). Rewriting the query first would swallow
    // them — for `?new=` (#396) that would silently drop a New Chat request.
    if (params.get('flow') || params.get('message') || params.get(NEW_CHAT_PARAM)) return;

    const activeId = currentConversationIdRef.current;
    const paramId = params.get('conversation');

    if (activeId) {
      // Idempotent: re-resolving the id already in the query is a no-op, which
      // is what keeps this effect and the deep-link hook from ping-ponging.
      if (paramId !== activeId) {
        router.replace(magicLinkPath({ kind: 'conversation', id: activeId }));
      }
      return;
    }

    // No active conversation (cleared, deleted with nothing left, or an invalid
    // inbound id that was rejected): never leave a stale link behind.
    if (paramId) router.replace('/chat');
  }, [currentConversationId, conversationList, isLoadingHistory, router]);

  // Clear the highlight a couple of seconds after landing so it doesn't linger
  // forever, and reset it whenever the viewed conversation changes.
  useEffect(() => {
    if (!anchorMessageId) return;
    const timeout = window.setTimeout(() => setAnchorMessageId(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [anchorMessageId]);
  useEffect(() => {
    setAnchorMessageId(null);
  }, [currentConversationId]);

  // --- Quick Chat (issue #61): a model + optional MCP servers, no saved flow ---
  const [quickChatOpen, setQuickChatOpen] = useState<boolean>(false);

  // Synthesize the ephemeral flow, create a conversation seeded with it as a
  // snapshot, then select it. Every turn afterwards uses the normal streaming
  // send path (the engine resolves the flow from the snapshot on the state).
  const startQuickChat = async (selection: QuickChatStartSelection) => {
    setError(null);
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
    const conversationId = uuidv4();
    // Throws on failure → surfaced by the dialog's own error state.
    const { flow } = await chatService.synthesizeQuickChat({
      conversationId,
      modelId: selection.modelId,
      servers: selection.servers,
      systemPrompt: selection.systemPrompt,
    });

    const now = Date.now();
    const created = await chatService.createConversation({
      id: conversationId,
      title: t('chat.page.quickChat'),
      flowId: flow.id,
      flowSnapshot: flow,
      createdAt: now,
      updatedAt: now,
    });

    setConversationList(prev =>
      [created, ...prev].sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt))
    );
    setCurrentConversationId(created.id);
    setDetailedConversation({
      id: created.id,
      title: created.title,
      flowId: created.flowId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      messages: [],
    });
    setIsLoadingDetails(false);
    setDetailsError(null);
    setQuickChatOpen(false);
  };


  // Update conversation (primarily updates the detailed view now)
  // Used for local updates like adding user message, toggling disabled state
  const updateDetailedConversationState = useCallback((updatedDetailedConv: Conversation) => {
    log.debug('Updating detailed conversation state locally', { conversationId: updatedDetailedConv.id });
    const updatedWithTimestamp = {
      ...updatedDetailedConv,
      updatedAt: Date.now() // Ensure timestamp is updated
    };
    setDetailedConversation(updatedWithTimestamp);

    // Also update the summary in the list for immediate UI feedback (e.g., title change)
    setConversationList(prevList =>
      prevList.map(conv =>
        conv.id === updatedWithTimestamp.id
          ? { ...conv, title: updatedWithTimestamp.title, updatedAt: updatedWithTimestamp.updatedAt } // Update relevant summary fields
          : conv
      ).sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt)) // Keep sorted
    );
  }, []);

  // --- Live execution event stream (SSE) ---
  const closeEventStream = useCallback(() => {
    if (eventSourceRef.current) {
      log.debug('Closing execution event stream');
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // Patch one conversation's sidebar status in place. No re-sort: a status
  // change alone must not reshuffle the list; identity is kept when unchanged.
  const patchConversationStatus = useCallback(
    (conversationId: string, status: ConversationListItem['status']) => {
      setConversationList(prev => {
        const idx = prev.findIndex(c => c.id === conversationId);
        if (idx === -1 || prev[idx].status === status) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], status };
        return next;
      });
    },
    []
  );

  // Apply a single execution event from the SSE stream to local UI state.
  const applyExecutionEvent = useCallback((event: ExecutionEvent) => {
    // Ordered dedupe: ignore anything we've already applied (e.g. replayed on
    // reconnect). usage accumulation depends on this to avoid double counting.
    if (typeof event.seq === 'number') {
      if (event.seq <= lastSeqRef.current) return;
      lastSeqRef.current = event.seq;
    }

    // Keep only graph-routing/activity events: token deltas and messages would
    // rebuild the canvas frame model on every streamed chunk without adding any
    // graph information. A fresh top-level run starts a new debugger session.
    if (
      event.type === 'run:start'
      || event.type === 'run:done'
      || event.type === 'run:paused'
      || event.type === 'breakpoint:hit'
      || event.type === 'subflow:start'
      || event.type === 'subflow:done'
      || event.type === 'node:enter'
      || event.type === 'node:exit'
      || event.type === 'resource:read'
      || event.type === 'resource:write'
      || event.type === 'error'
    ) {
      setDebuggerEvents(prev => {
        if (event.type === 'run:start') return [event];
        const next = [...prev, event];
        return next.length > 2_000 ? next.slice(next.length - 2_000) : next;
      });
    }

    // Issue #400: a pending session-limit wait is superseded by ANY later event
    // from the same conversation — further progress, a terminal run:done/error,
    // or a cancellation. Clearing it here keeps the countdown self-healing
    // without a second source of truth for "is the run still waiting?".
    if (event.type !== 'recovery:retry') {
      setRetryWait(prev =>
        prev && (!event.conversationId || prev.conversationId === event.conversationId) ? null : prev
      );
    }

    const touch = (patch: Partial<{ totalTokens: number; activeNode: string | null }>) =>
      setLiveStats(prev => ({
        totalTokens: patch.totalTokens ?? prev?.totalTokens ?? 0,
        activeNode: patch.activeNode !== undefined ? patch.activeNode : (prev?.activeNode ?? null),
        startedAt: prev?.startedAt ?? Date.now(),
        lastEventAt: Date.now(),
      }));

    // Live node-activity map for canvas highlighting (Tier 3). Kept separate
    // from liveStats: liveStats is a text summary, this is per-node state.
    const touchActivity = (mutate: (draft: LiveActivity) => void) =>
      setLiveActivity(prev => {
        const now = Date.now();
        const draft: LiveActivity = {
          byNode: { ...prev.byNode },
          byResource: { ...prev.byResource },
          byResourceName: { ...prev.byResourceName },
          resourceVersion: prev.resourceVersion,
        };
        mutate(draft);
        return pruneLiveActivity(draft, now);
      });

    // Subflow job events (issue #157): fold into the per-child progress rows
    // instead of the single activeNode string — concurrent lanes overwriting
    // activeNode is what made the header flicker between lanes. The lane
    // reducer owns node/tool/subflow activity for these events; everything
    // else (message, usage, resource highlighting, error) still falls through
    // to the switch below. run:start/run:done never carry laneIndex (child run
    // boundaries are translated to subflow:* by the emit wrapper).
    if (event.laneIndex != null) {
      setLiveLanes(prev => applyLaneEvent(prev, event));
      switch (event.type) {
        case 'node:enter':
          // Keep the canvas highlight (per-node, lane-agnostic) — only the
          // activeNode label is lane-scoped now.
          if (event.node?.nodeId) {
            const nodeId = event.node.nodeId;
            touchActivity(draft => { draft.byNode[nodeId] = { kind: 'active', ts: Date.now() }; });
            setSseVisitedNodeIds(prev => prev.has(nodeId) ? prev : new Set(prev).add(nodeId));
          }
          touch({});
          return;
        case 'tool:call':
        case 'tool:progress':
        case 'subflow:start':
        case 'handoff':
          touch({}); // refresh lastEventAt without overwriting activeNode
          return;
        default:
          break; // message/usage/resource/error/subflow:done → main switch
      }
    }

    switch (event.type) {
      case 'run:start':
        setLiveStats({ totalTokens: 0, activeNode: null, startedAt: Date.now(), lastEventAt: Date.now() });
        setLiveActivity(EMPTY_LIVE_ACTIVITY);
        setLiveLanes(EMPTY_LIVE_LANES);
        setCurrentTodos([]);
        if (event.conversationId) {
          patchConversationStatus(event.conversationId, 'running');
          markConversationStopped(event.conversationId, false); // a new run clears the prior Stop notice
        }
        break;
      case 'model:delta': {
        touch({});
        setDetailedConversation(prev => {
          if (!prev || prev.id !== event.conversationId) return prev;

          const existingIndex = prev.messages.findIndex(message => message.id === event.messageId);
          const existing = existingIndex >= 0
            ? prev.messages[existingIndex]
            : ({
                id: event.messageId,
                role: 'assistant',
                content: '',
                timestamp: event.timestamp,
                processNodeId: event.node?.nodeId,
              } as ChatMessage);

          if (existing.role !== 'assistant') return prev;

          const toolCalls = [...(existing.tool_calls ?? [])];
          const toolDelta = event.toolCallDelta;
          if (toolDelta) {
            const prior = toolCalls[toolDelta.index];
            toolCalls[toolDelta.index] = {
              id: toolDelta.id ?? prior?.id ?? `pending_${event.messageId}_${toolDelta.index}`,
              type: 'function',
              function: {
                name: `${prior?.function.name ?? ''}${toolDelta.nameDelta ?? ''}`,
                arguments: `${prior?.function.arguments ?? ''}${toolDelta.argumentsDelta ?? ''}`,
              },
            };
          }

          const draft = {
            ...existing,
            content: `${typeof existing.content === 'string' ? existing.content : ''}${event.delta ?? ''}`,
            ...(event.mediaPart
              ? {
                  media: [
                    ...(existing.media ?? []),
                    ...(existing.media ?? []).some(part =>
                      part.type === event.mediaPart?.type &&
                      part.url === event.mediaPart?.url &&
                      part.resourceUri === event.mediaPart?.resourceUri
                    )
                      ? []
                      : [event.mediaPart],
                  ],
                }
              : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          } as ChatMessage;

          const messages = [...prev.messages];
          if (existingIndex >= 0) messages[existingIndex] = draft;
          else messages.push(draft);
          return { ...prev, messages };
        });
        break;
      }
      case 'model:end':
        touch({});
        if (event.discard && event.messageId) {
          setDetailedConversation(prev => {
            if (!prev || prev.id !== event.conversationId) return prev;
            const messages = prev.messages.filter(message => message.id !== event.messageId);
            return messages.length === prev.messages.length ? prev : { ...prev, messages };
          });
        }
        break;
      case 'message': {
        const incoming = event.message as ChatMessage;
        touch({});
        setDetailedConversation(prev => {
          if (!prev || prev.id !== event.conversationId) return prev;
          const idx = prev.messages.findIndex(m => m.id === incoming.id);
          let messages: ChatMessage[];
          if (idx >= 0) {
            messages = [...prev.messages];
            // Spread across role-union members widens the type; the merged
            // object is a valid ChatMessage, so assert it.
            messages[idx] = { ...messages[idx], ...incoming } as ChatMessage;
          } else {
            messages = [...prev.messages, incoming];
          }
          return { ...prev, messages };
        });
        break;
      }
      case 'node:changed-files': {
        touch({});
        const nodeId = event.node?.nodeId;
        if (!nodeId || event.changedFiles.length === 0) break;
        setDetailedConversation(prev => {
          if (!prev || prev.id !== event.conversationId) return prev;
          const index = prev.messages.findLastIndex(message => message.processNodeId === nodeId);
          if (index < 0) return prev;
          const messages = [...prev.messages];
          messages[index] = {
            ...messages[index],
            changedFiles: event.changedFiles.map(({ path, status }) => ({ path, status })),
          };
          return { ...prev, messages };
        });
        break;
      }
      case 'usage':
        setLiveStats(prev => ({
          // Match the durable header meter: cached input is provider throughput,
          // not fresh work. Cache writes remain counted as fresh input.
          totalTokens: (prev?.totalTokens ?? 0) + Math.max(
            0,
            (event.totalTokens || 0) - (event.cacheReadTokens || 0),
          ),
          activeNode: prev?.activeNode ?? null,
          startedAt: prev?.startedAt ?? Date.now(),
          lastEventAt: Date.now(),
        }));
        break;
      case 'node:enter':
        touch({ activeNode: event.node?.nodeName || event.node?.nodeId || null });
        if (event.node?.nodeId) {
          const nodeId = event.node.nodeId;
          touchActivity(draft => { draft.byNode[nodeId] = { kind: 'active', ts: Date.now() }; });
          setSseVisitedNodeIds(prev => prev.has(nodeId) ? prev : new Set(prev).add(nodeId));
        }
        break;
      case 'resource:read':
      case 'resource:write': {
        // Light up both the acting node (if attributed) and the resource
        // artifact itself (matched by server+uri or run-artifact name in the
        // canvas). resource:write also bumps resourceVersion so the run-data
        // panel refetches.
        const kind = event.type === 'resource:read' ? 'read' as const : 'write' as const;
        if (
          event.type === 'resource:write'
          && event.source === 'snapshot'
          && event.snapshot
          && event.node?.nodeId
          && event.conversationId === currentConversationIdRef.current
        ) {
          const nodeId = event.node.nodeId;
          const root = event.snapshot.root;
          setCanvasStateOwnerId(event.conversationId);
          setCanvasState((prev) => openCanvasApp(prev, {
            serverName: 'filesystem',
            uri: 'ui://devcanvas/diff',
            instanceKey: `snapshot::${nodeId}::${root}`,
            toolName: 'snapshot_diff',
            resultContent: JSON.stringify({
              snapshotDiff: {
                nodeId,
                nodeName: event.node?.nodeName,
                root,
                startSnapshot: event.snapshot?.startSnapshot,
                endSnapshot: event.snapshot?.endSnapshot,
                changedFiles: event.snapshot?.changedFiles,
                resourceUri: event.uri,
              },
            }),
            updateId: event.seq,
          }, Date.now(), Number.MAX_SAFE_INTEGER).state);
        }
        touchActivity(draft => {
          const now = Date.now();
          if (event.node?.nodeId) {
            draft.byNode[event.node.nodeId] = {
              kind: kind === 'read' ? 'resource-read' : 'resource-write',
              ts: now,
            };
          }
          if (event.server && event.uri) {
            draft.byResource[resourceActivityKey(event.server, event.uri)] = { kind, ts: now };
          }
          if (event.name) {
            draft.byResourceName[event.name] = { kind, ts: now };
          }
          if (kind === 'write') draft.resourceVersion = draft.resourceVersion + 1;
        });
        touch({});
        break;
      }
      case 'todo:update':
        // Full current list (not a delta) — replace wholesale so a late-joining
        // client rebuilds the checklist from the ring buffer (issue #259).
        setCurrentTodos(event.todos ?? []);
        touch({});
        break;
      case 'tool:call':
        touch({ activeNode: event.name });
        break;
      case 'tool:progress':
        // Server-side progress for a long-running tool: refreshes lastEventAt (so
        // the stall warning stays away) and shows the server's message if any.
        touch({ activeNode: event.message ? `${event.name} — ${event.message}` : event.name });
        break;
      case 'subflow:start':
        touch({ activeNode: `↳ ${event.subflowName || event.subflowId}` });
        break;
      case 'handoff':
        touch({ activeNode: `→ ${event.toNodeId}` });
        break;
      case 'run:awaiting_approval':
        // Only surface the approval prompt for the conversation actually being
        // viewed. A background run (or a stale stream) emitting this event must
        // not bleed its pending tool calls into whatever conversation is on
        // screen — that previously showed the wrong conversation's prompt and
        // made Reject target the wrong conversation.
        if (event.conversationId && event.conversationId === currentConversationIdRef.current) {
          setPendingToolCalls(event.pendingToolCalls || []);
        }
        if (event.conversationId) patchConversationStatus(event.conversationId, 'awaiting_tool_approval');
        break;
      case 'run:awaiting_elicitation':
        // Same bleed-prevention rule as awaiting_approval: only surface for the
        // viewed conversation.
        if (event.conversationId && event.conversationId === currentConversationIdRef.current) {
          setPendingElicitation({
            elicitationId: event.elicitationId,
            message: event.message,
            requestedSchema: event.requestedSchema,
          });
        }
        break;
      case 'run:awaiting_question':
        // Same bleed-prevention rule as awaiting_approval/elicitation: only
        // surface for the conversation currently being viewed (issue #258).
        if (event.conversationId && event.conversationId === currentConversationIdRef.current) {
          setPendingQuestion({
            questionId: event.questionId,
            questions: event.questions,
          });
        }
        break;
      case 'breakpoint:hit':
      case 'run:paused':
        // Flip the UI to paused; the awaited POST response carries the full
        // debugState (trace + current node) and populates the debugger panel.
        setIsLoading(false);
        if (event.conversationId) {
          markConvRunning(event.conversationId, false);
          patchConversationStatus(event.conversationId, 'paused_debug');
        }
        setIsDebugPaused(true);
        break;
      case 'run:done':
        if (event.conversationId) {
          markConvRunning(event.conversationId, false);
          patchConversationStatus(event.conversationId, event.status);
        }
        // Issue #383: a client that missed the mid-stream `error` event (e.g.
        // reconnected mid-run) still learns why, straight from `run:done`.
        if (event.status === 'error' && event.error && event.conversationId === currentConversationIdRef.current) {
          setErrorInfo(event.error);
        }
        // Clear any pending elicitation/question when the run completes.
        if (event.conversationId === currentConversationIdRef.current) {
          setPendingElicitation(null);
          setPendingQuestion(null);
        }
        // The live-view teardown (indicator, stream, input gate) belongs to
        // the run this client is tracking. Events normally only arrive from
        // that run's stream, but a straggler for another conversation (e.g. a
        // late event applied after the user started a run elsewhere) must not
        // dismantle the newer run's live view.
        if (
          event.conversationId &&
          loadingConversationIdRef.current &&
          event.conversationId !== loadingConversationIdRef.current
        ) {
          break;
        }
        setLiveStats(null);
        setLiveActivity(EMPTY_LIVE_ACTIVITY);
        setLiveLanes(EMPTY_LIVE_LANES);
        setIsLoading(false);
        setLoadingConversationId(null);
        closeEventStream();
        // Only refresh the view if this run is the one being viewed (a
        // background run must not hijack the displayed conversation).
        if (event.conversationId && event.conversationId === currentConversationIdRef.current) {
          fetchDetailedConversation(event.conversationId); // also reconciles the list summary/title
        } else {
          // A background run finished: silently refresh the list so its
          // server-generated title and sort order show up, without disturbing
          // the current selection or view.
          fetchConversations(undefined, { silent: true });
        }
        break;
      case 'recovery:retry':
        // NOT terminal: the server is waiting out a bounded provider session /
        // rate limit before replaying the same call. Keep the conversation
        // running (so the input stays gated and Stop stays live) and show a
        // countdown instead of the terminal error banner. The frontend never
        // re-issues the request when the countdown hits zero — the server owns
        // the timer and the replay.
        if (event.conversationId) {
          setRetryWait({
            conversationId: event.conversationId,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            retryAt: event.retryAt,
          });
          patchConversationStatus(event.conversationId, 'running');
        }
        touch({}); // a deliberate wait is activity, not a stall
        break;
      case 'error':
        setError(event.message || t('chat.page.executionError'));
        // Issue #383: carry the normalized code/status/class alongside the
        // plain message, when the backend sent one (older events without
        // `error` still work — errorInfo just stays null and the transient
        // alert falls back to the plain message).
        setErrorInfo(event.error ?? { message: event.message || t('chat.page.executionError') });
        break;
      default:
        touch({});
        break;
    }
  }, [closeEventStream, fetchDetailedConversation, fetchConversations, markConvRunning, patchConversationStatus, markConversationStopped, t]);

  // Open the SSE stream for a conversation and resolve once it is connected
  // (or after a short timeout). Callers await this BEFORE issuing the run's POST
  // so the subscription exists before the server emits any events — otherwise a
  // fast run can finish before the stream attaches and the live view sees
  // nothing. The browser auto-reconnects using Last-Event-ID to replay misses.
  const openEventStream = useCallback((conversationId: string, fromSeq?: number): Promise<void> => {
    closeEventStream();
    // Accept events at/after the replay position (fromSeq) or everything (-1).
    lastSeqRef.current = fromSeq !== undefined ? fromSeq - 1 : -1;
    // Lane rows are rebuilt from the replay; without this, rows from a
    // previously-viewed conversation would merge with the replayed ones.
    setLiveLanes(EMPTY_LIVE_LANES);
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      try {
        eventSourceRef.current = chatService.subscribeToEvents(
          conversationId,
          { onEvent: applyExecutionEvent, onOpen: settle },
          fromSeq
        );
        // Safety: never block the run for more than ~1.5s waiting to connect.
        setTimeout(settle, 1500);
      } catch (err) {
        log.error('Failed to open execution event stream', { conversationId, err });
        settle();
      }
    });
  }, [applyExecutionEvent, closeEventStream]);

  // Re-attach to a run that is still in progress on the backend — e.g. after
  // navigating to another page (which unmounts Chat and tears down the stream)
  // and back, or selecting a conversation that is running in the background.
  // Without this the live indicator and streaming updates stay missing until a
  // full reload. Limited to 'running': restoring the 'awaiting_tool_approval'
  // and 'paused_debug' UIs needs pendingToolCalls/debugState, which the list
  // summary doesn't carry (would require the GET conversation route to return
  // them — tracked as a follow-up).
  useEffect(() => {
    if (!currentConversationId) return;
    if (currentConversationSummary?.status !== 'running') return;
    if (loadingConversationIdRef.current === currentConversationId) return; // already tracking
    // The user just Stopped this conversation: the server may briefly still
    // report 'running' while the live loop winds down. Re-attaching now would
    // resurrect the Stop banner the user just dismissed (and its replay would
    // clear the stop notice) — flickering until the run finalizes. The list
    // poll picks up the terminal status; a genuinely new run clears the flag
    // via run:start / the next send.
    if (stoppedConversationIdsRef.current.has(currentConversationId)) {
      log.debug('Skipping re-attach to a conversation the user just stopped', { conversationId: currentConversationId });
      return;
    }
    log.info('Re-attaching to in-progress run', { conversationId: currentConversationId });
    loadingConversationIdRef.current = currentConversationId; // guard re-entry before state commits
    setIsLoading(true);
    setLoadingConversationId(currentConversationId);
    markConvRunning(currentConversationId, true);
    setLiveStats(prev => prev ?? { totalTokens: 0, activeNode: null, startedAt: Date.now(), lastEventAt: Date.now() });
    openEventStream(currentConversationId, 0); // replay buffered events from the start
  }, [currentConversationId, currentConversationSummary?.status, openEventStream]);

  // Delete conversation
  const deleteConversation = async (conversationId: string) => {
    log.debug('Attempting to delete conversation', { conversationId });
    setError(null); // Clear previous general errors
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error

    // Store current selection and list in case we need to revert
    const previousSelectionId = currentConversationId;
    const previousList = conversationList;

    // Shield the optimistic removal from a list refresh racing the DELETE.
    // The id stays in the set after a successful delete on purpose: a LIST
    // response that was already in flight when the delete started can resolve
    // AFTER the DELETE and would otherwise re-add the row for one poll cycle.
    pendingDeleteIdsRef.current.add(conversationId);
    const wasLocalOnly = localOnlyConversationIdsRef.current.delete(conversationId);

    // Drop this client's live tracking of the conversation (stream, indicator,
    // input gating). The backend cancels any in-flight run as part of DELETE.
    if (loadingConversationIdRef.current === conversationId) {
      closeEventStream();
      setIsLoading(false);
      setLoadingConversationId(null);
      setLiveStats(null);
      setLiveLanes(EMPTY_LIVE_LANES);
      setRetryWait(null); // #400: no countdown for a conversation being deleted
    }
    markConvRunning(conversationId, false);
    // Drop any queued (not-yet-sent) messages for the deleted conversation (#177).
    setQueuedMessages(prev => clearMsgQueue(prev, conversationId));

    // Optimistic UI update for the list
    const updatedList = previousList.filter((conv) => conv.id !== conversationId);
    setConversationList(updatedList);

    // If deleting the current one, clear the detailed view optimistically and handle selection locally
    let nextSelectionId: string | null = previousSelectionId;
    if (previousSelectionId === conversationId) {
      if (updatedList.length > 0) {
        // Select the new top item (most recent)
        nextSelectionId = updatedList[0].id;
        log.debug('Deleted current conversation, selecting next most recent', { nextSelectionId });
      } else {
        // No conversations left
        nextSelectionId = null;
        log.debug('Deleted last conversation, clearing selection');
      }
      setCurrentConversationId(nextSelectionId); // This will trigger useEffect to clear/update detailed view
    }
    // If deleting a non-selected conversation, nextSelectionId remains previousSelectionId

    try {
      await chatService.deleteConversation(conversationId);
      log.info('Successfully deleted conversation on backend', { conversationId });
      if (!wasLocalOnly) {
        loadedServerConversationCountRef.current = Math.max(
          0,
          loadedServerConversationCountRef.current - 1,
        );
        updateConversationPagination({
          ...conversationPaginationRef.current,
          total: Math.max(0, conversationPaginationRef.current.total - 1),
        });
      }
      // No need to refetch here, optimistic update is sufficient
      // Selection is handled above

    } catch (err) {
      log.error('Error deleting conversation:', { conversationId, err });
      setError(t('chat.page.deleteFailed', { id: conversationId }));
      // Revert optimistic UI update — including the shields, so the restored
      // conversation is fetchable/pollable again.
      pendingDeleteIdsRef.current.delete(conversationId);
      if (wasLocalOnly) localOnlyConversationIdsRef.current.add(conversationId);
      setConversationList(previousList);
      setCurrentConversationId(previousSelectionId);
      // Optionally call fetchConversations() again to ensure sync despite error?
      // await fetchConversations(previousSelectionId);
    }
  };

  // Bulk-delete a set of conversations (Delete All / Delete Visible from the
  // sidebar). Optimistically drops the rows locally; the polling loop reconciles
  // with the server. Mirrors deleteConversation's shielding so an in-flight LIST
  // response can't re-add rows for one poll cycle.
  const bulkDeleteConversations = async (ids: string[]) => {
    if (!ids.length) return;
    setError(null);
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
    const idSet = new Set(ids);
    const previousList = conversationList;
    const previousSelectionId = currentConversationId;
    const localOnlyIds = new Set(
      ids.filter((id) => localOnlyConversationIdsRef.current.has(id)),
    );
    const loadedPersistedDeleted = previousList.filter(
      (conversation) => idSet.has(conversation.id) && !localOnlyIds.has(conversation.id),
    ).length;

    ids.forEach((id) => pendingDeleteIdsRef.current.add(id));
    ids.forEach((id) => localOnlyConversationIdsRef.current.delete(id));

    // If the currently viewed conversation is among the deleted set, drop this
    // client's live tracking of it (stream, loading indicator).
    const viewed = currentConversationIdRef.current;
    if (viewed && idSet.has(viewed) && loadingConversationIdRef.current === viewed) {
      closeEventStream();
      setIsLoading(false);
      setLoadingConversationId(null);
      setLiveStats(null);
      setLiveLanes(EMPTY_LIVE_LANES);
      setRetryWait(null); // #400: no countdown for a conversation being deleted
    }
    ids.forEach((id) => {
      markConvRunning(id, false);
      setQueuedMessages((prev) => clearMsgQueue(prev, id));
    });

    // Optimistic list update + deselect if the current conversation was deleted.
    setConversationList((prev) => prev.filter((c) => !idSet.has(c.id)));
    if (viewed && idSet.has(viewed)) {
      setCurrentConversationId(null);
    }

    try {
      const result = await chatService.deleteConversations(ids);
      log.info('Bulk delete succeeded', { requested: ids.length, ...result });
      loadedServerConversationCountRef.current = Math.max(
        0,
        loadedServerConversationCountRef.current - loadedPersistedDeleted,
      );
      const persistedRequested = ids.length - localOnlyIds.size;
      updateConversationPagination({
        ...conversationPaginationRef.current,
        total: Math.max(
          0,
          conversationPaginationRef.current.total - Math.min(result.deleted, persistedRequested),
        ),
      });
    } catch (err) {
      log.error('Bulk delete failed', { err });
      setError(t('chat.page.bulkDeleteFailed'));
      // Revert the optimistic update and shields, then re-sync from the server.
      ids.forEach((id) => pendingDeleteIdsRef.current.delete(id));
      localOnlyIds.forEach((id) => localOnlyConversationIdsRef.current.add(id));
      setConversationList(previousList);
      setCurrentConversationId(previousSelectionId);
    }
  };

  // Handle flow selection from the selector. If the conversation has already
  // been executed, switching flows means execution will restart on the new
  // flow's Start node — ask for confirmation first (Cancel keeps the current
  // flow). Fresh conversations switch immediately.
  const handleFlowSelect = (flowId: string) => {
    if (!currentConversationId) {
      log.warn('Cannot update flow: No conversation selected.');
      setError(t('chat.page.selectFirst'));
      return;
    }
    // Remember the user's manual pick so the NEXT new conversation defaults to
    // it (issue #134, item 6). Quick-chat snapshot ids are not real flows.
    if (!isQuickChatFlowId(flowId)) {
      setLastPickedFlowId(flowId);
    }
    const currentFlowId = detailedConversation?.flowId ?? currentConversationSummary?.flowId ?? null;
    const hasMessages = (detailedConversation?.messages?.length ?? 0) > 0;
    if (hasMessages && currentFlowId && flowId !== currentFlowId) {
      log.debug('Flow switch on executed conversation — asking for confirmation', { flowId, currentFlowId });
      setPendingFlowSwitch(flowId);
      return;
    }
    applyFlowSelect(flowId);
  };

  // Apply a flow change (Persists via PATCH and updates local state)
  const applyFlowSelect = async (flowId: string) => {
    log.debug('Flow selected, attempting to update', { flowId, currentConversationId });
    setError(null); // Clear previous errors
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error

    if (!currentConversationId) {
      log.warn('Cannot update flow: No conversation selected.');
      setError(t('chat.page.selectFirst'));
      return;
    }

    // Store previous state for potential rollback on error
    const previousDetailedConversation = detailedConversation;
    const previousConversationList = conversationList;

    // --- Optimistic UI Update ---
    // Update detailed view optimistically if it matches the current ID
    if (detailedConversation && detailedConversation.id === currentConversationId) {
      const optimisticallyUpdatedDetailed: Conversation = {
        ...detailedConversation,
        flowId,
        updatedAt: Date.now(), // Update timestamp locally too
      };
      setDetailedConversation(optimisticallyUpdatedDetailed);
    }
    // Update summary list optimistically
    setConversationList(prevList =>
      prevList.map(conv =>
        conv.id === currentConversationId
          ? { ...conv, flowId: flowId, updatedAt: Date.now() } // Update flowId and timestamp
          : conv
      ).sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt)) // Keep sorted
    );
    // --- End Optimistic UI Update ---

    try {
      // Call the backend PATCH endpoint
      const updatedSummaryFromServer = await chatService.updateConversationFlow(currentConversationId, flowId);
      log.info('Successfully updated flowId on backend', { conversationId: currentConversationId, flowId });

      // --- Confirm UI Update with Server Data ---
      // Use functional update to ensure we're acting on the latest state
      setDetailedConversation(prevDetailed => {
        // Only update if the state we are setting belongs to the conversation ID that was just PATCHed
        if (prevDetailed && prevDetailed.id === currentConversationId) {
          log.debug('Confirming detailedConversation update from server response', { conversationId: currentConversationId, flowId: updatedSummaryFromServer.flowId });
          return {
            ...prevDetailed,
            flowId: updatedSummaryFromServer.flowId, // Use server's flowId
            updatedAt: updatedSummaryFromServer.updatedAt, // Use server's timestamp
          };
        }
        // Otherwise, return the previous state unchanged
        log.debug('Skipping detailedConversation update, ID mismatch or null state', { currentDetailedId: prevDetailed?.id, targetId: currentConversationId });
        return prevDetailed;
      });

      // Ensure summary list is consistent with server response
      setConversationList(prevList =>
        prevList.map(conv =>
          conv.id === currentConversationId
            ? updatedSummaryFromServer // Replace with the full summary from server
            : conv
        ).sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt)) // Re-sort based on server timestamp
      );
      // --- End Confirm UI Update ---

    } catch (err) {
      log.error('Error updating flowId on backend:', { conversationId: currentConversationId, flowId, err });
      let errorMsg = t('chat.page.updateAgentFailed');
      if (err instanceof ChatApiError) {
        errorMsg += ` (${err.body?.error || err.message})`;
      } else if (err instanceof Error) {
        errorMsg += ` (${err.message})`;
      }
      setError(errorMsg);

      // --- Rollback Optimistic UI Update ---
      setDetailedConversation(previousDetailedConversation);
      setConversationList(previousConversationList);
      // --- End Rollback ---
    }
  };

  // --- Conversation rename (issue #134, item 2) ---
  // Enter edit mode, seeding the draft with the current title.
  const beginEditTitle = () => {
    const current = detailedConversation?.title ?? currentConversationSummary?.title ?? '';
    setTitleDraft(current);
    setIsEditingTitle(true);
  };

  // Persist a rename (on Enter/blur). Optimistic update of both the detailed view
  // and the sidebar summary; the backend keeps updatedAt unchanged so a rename
  // does NOT re-sort the conversation to the top. Empty/unchanged titles are
  // no-ops; a failed PATCH rolls the title back.
  const commitEditTitle = async () => {
    const id = currentConversationId;
    setIsEditingTitle(false);
    if (!id) return;
    const previousTitle = detailedConversation?.title ?? currentConversationSummary?.title ?? '';
    const newTitle = titleDraft.trim().slice(0, 200);
    if (!newTitle || newTitle === previousTitle) return;

    setDetailedConversation(prev => (prev && prev.id === id ? { ...prev, title: newTitle } : prev));
    setConversationList(prevList => prevList.map(c => (c.id === id ? { ...c, title: newTitle } : c)));
    try {
      const updated = await chatService.updateConversationTitle(id, newTitle);
      setDetailedConversation(prev => (prev && prev.id === id ? { ...prev, title: updated.title } : prev));
      setConversationList(prevList => prevList.map(c => (c.id === id ? { ...c, title: updated.title } : c)));
    } catch (err) {
      log.warn('Failed to rename conversation', { conversationId: id, err });
      setDetailedConversation(prev => (prev && prev.id === id ? { ...prev, title: previousTitle } : prev));
      setConversationList(prevList => prevList.map(c => (c.id === id ? { ...c, title: previousTitle } : c)));
      setError(t('chat.page.renameFailed'));
    }
  };


  // Handle sending a message
  const handleSendMessage = async (
    content: string,
    attachments: Attachment[] = [],
    opts?: { fromQueue?: boolean; nodeOverride?: string | null; queuedId?: string },
  ) => {
    if (!content.trim() && attachments.length === 0) return;
    if (!detailedConversation) {
       log.error("Cannot send message, detailed conversation not loaded.");
       setError(t('chat.page.detailsMissing'));
       return;
    }

    // A run is already in flight for this conversation. Two ways to handle the
    // message, in order of preference:
    //
    //  1. MID-RUN STEERING — hand it straight to the live run (POST /inject) so
    //     the model sees it on its next turn. This is the point of typing while
    //     the agent works: it is usually a correction, and a correction that
    //     arrives after the run has finished going the wrong way is worthless.
    //  2. QUEUE (issue #177) — park it and auto-send once the conversation is
    //     idle. Still the right behaviour when the message can't be steering:
    //     it carries attachments (the inject endpoint takes text only) or the
    //     user picked a specific node for it (that's a new turn, not a nudge),
    //     or the run turned out to have already ended.
    //
    // Messages arriving from the drain (fromQueue) skip this gate entirely so
    // they actually send. The approval / debug-pause gates keep the input
    // disabled, so we never reach here while blocked.
    if (!opts?.fromQueue && runningConvs.has(detailedConversation.id)) {
      const convId = detailedConversation.id;
      const canSteer = attachments.length === 0 && !nodeOverride;
      if (canSteer) {
        const messageId = uuidv4();
        const { delivered } = await chatService.injectMessage(convId, content, messageId);
        if (delivered) {
          // Optimistic bubble under the SAME id the backend will use, so the
          // canonical copy merges into it when the run folds the message in
          // (dedupe in the live view is by message id) instead of duplicating.
          const steeringMessage: ChatMessage = {
            id: messageId,
            role: 'user',
            content,
            timestamp: Date.now(),
          };
          updateDetailedConversationState({
            ...detailedConversation,
            messages: [...detailedConversation.messages, steeringMessage],
          });
          log.debug('Run in progress — injected steering message into the live run', {
            conversationId: convId,
            messageId,
          });
          return;
        }
        // The run ended between the last render and this POST. Fall through and
        // send it as a normal turn rather than queueing it behind nothing.
        log.debug('Steering rejected (run no longer live) — sending as a normal turn', { conversationId: convId });
      } else {
        const queued: QueuedMessage = {
          id: uuidv4(),
          content,
          attachments,
          // Capture the one-shot node pick now so it applies only to THIS message.
          nodeOverride: nodeOverride ?? null,
          timestamp: Date.now(),
        };
        setQueuedMessages(prev => enqueueMsg(prev, convId, queued));
        setNodeOverride(null);
        log.debug('Run in progress — queued message (not steerable)', {
          conversationId: convId,
          queuedId: queued.id,
          reason: attachments.length > 0 ? 'attachments' : 'node-override',
        });
        return;
      }
    }

    log.debug('Sending message', { conversationId: detailedConversation.id, contentLength: content.length, attachmentsCount: attachments.length });

    // Determine the appropriate processNodeId for the user message
    let nodeIdToAssign: string | undefined = undefined;
    const existingMessages = detailedConversation.messages;
    const isFirstUserMessage = !existingMessages.some(msg => msg.role === 'user');
    const currentFlowId = detailedConversation.flowId;

    // A queued message carries the node pick captured at enqueue time; a live
    // send reads the current one-shot nodeOverride state (and clears it).
    const manualNode = opts?.fromQueue ? (opts.nodeOverride ?? null) : nodeOverride;
    if (manualNode) {
      // The user manually picked a node in the chat input's node picker: the
      // message resumes execution there. One-shot — consumed by this send.
      nodeIdToAssign = manualNode;
      if (!opts?.fromQueue) setNodeOverride(null);
      log.debug(`Assigning manually picked node ID to user message: ${nodeIdToAssign}`);
    } else if (isFirstUserMessage) {
      // For the first user message, use the start node ID from the current flow
      const currentFlow = flows.find(f => f.id === currentFlowId);
      const startNode = getStartNode(currentFlow);
      if (startNode) {
        nodeIdToAssign = startNode.id;
        log.debug(`Assigning start node ID to first user message: ${nodeIdToAssign}`);
      } else {
        log.warn(`Could not find start node for flow ${currentFlowId}. User message will not have a processNodeId.`);
      }
    } else if (currentConversationSummary?.status === 'error') {
      // Post-error new message (issue #151): do NOT inherit the most recent
      // *successful* assistant's node. After an error the errored node wrote no
      // message, so the last assistant message belongs to an EARLIER node/turn —
      // a stale target that makes the backend resume at the wrong place. Re-drive
      // the turn from the flow start node instead; the backend then replays the
      // turn from its full-history entry node (see runFlow issue #151 block).
      const currentFlow = flows.find(f => f.id === currentFlowId);
      const startNode = getStartNode(currentFlow);
      if (startNode) {
        nodeIdToAssign = startNode.id;
        log.debug(`Post-error message: re-driving turn from start node ID: ${nodeIdToAssign}`);
      } else {
        log.warn(`Could not find start node for post-error message in flow ${currentFlowId}. User message will not have a processNodeId.`);
      }
    } else {
      // For subsequent messages, use the processNodeId from the most recent assistant message
      for (let i = existingMessages.length - 1; i >= 0; i--) {
        const msg = existingMessages[i];
        if (msg.role === 'assistant' && msg.processNodeId) {
          nodeIdToAssign = msg.processNodeId;
          log.debug(`Assigning last assistant node ID to user message: ${nodeIdToAssign}`);
          break;
        }
      }

      // Fallback: If no prior assistant message had a processNodeId, try to use the start node
      if (!nodeIdToAssign) {
        const currentFlow = flows.find(f => f.id === currentFlowId);
        const startNode = getStartNode(currentFlow);
        if (startNode) {
          nodeIdToAssign = startNode.id;
          log.debug(`No prior assistant node ID found, falling back to start node ID: ${nodeIdToAssign}`);
        } else {
          log.warn(`Could not find start node for fallback in flow ${currentFlowId}. User message will not have a processNodeId.`);
        }
      }
    }

    // Create user message with the determined processNodeId
    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
      processNodeId: nodeIdToAssign // Assign the determined processNodeId
    };

    // Optimistically update detailed conversation state
    const updatedDetailedConv = {
      ...detailedConversation,
      messages: [...detailedConversation.messages, userMessage]
    };
    updateDetailedConversationState(updatedDetailedConv); // Use the callback

    // Send to API if the conversation has a flow selected
    if (updatedDetailedConv.flowId) {
      const success = await sendToChatCompletions(updatedDetailedConv); // Pass the updated state
      // Refresh conversation list after successful send? Only if title/timestamp changed significantly.
      // The backend updates the timestamp, so the list will re-sort on next fetch.
      // Let's skip explicit refetch here unless needed.
      // if (success) {
      //   await fetchConversations(currentConversationId); // Refetch list, keeping current selection
      // }
    } else {
      setError(t('chat.page.chooseAgent'));
      // Revert optimistic update?
       setDetailedConversation(detailedConversation); // Revert to previous detailed state
    }
  };

  // Handle a conversation run response (from the OpenAI completion call, or the
  // respond/debug REST endpoints), including debug-paused state. `data` is the
  // parsed response body.
  const handleApiResponse = useCallback((data: any, conversationId: string) => {
    log.verbose('Handling API response data', JSON.stringify(data));

    // Keep the per-conversation running set in sync from the response status, for
    // every funnel (send/edit/respond/debug). Only 'running' keeps the input
    // disabled here; awaiting-approval / paused-debug are handled by the
    // viewed-conversation gates (pendingToolCalls / isDebugPaused).
    markConvRunning(conversationId, data.status === 'running');

    // This funnel also resolves for conversations the user has since navigated
    // away from (the blocking POST of a run that finished in the background).
    // Global, view-owning state — the live indicator/stream (tracked) and the
    // approval prompt/debug panel (viewed) — must only be touched when this
    // response's conversation still owns it; otherwise conversation A's ending
    // dismantles conversation B's live view.
    const isTracked = loadingConversationIdRef.current === conversationId;
    const isViewed = currentConversationIdRef.current === conversationId;

    // --- Check for Debug Paused State ---
    if (data.status === 'paused_debug' && data.debugState) {
      log.info('API Response: Paused for debugging', { conversationId });
      if (!isViewed) {
        // A background conversation pausing must not hijack the viewed one's
        // debugger panel. Record its status in the sidebar, release the live
        // tracking if this run held it (the pause parks the run), and stop.
        patchConversationStatus(conversationId, 'paused_debug');
        if (isTracked) {
          setIsLoading(false);
          setLoadingConversationId(null);
          closeEventStream();
          stopPolling();
        }
        return true;
      }
      setDebugState(data.debugState as SharedState);
      setIsDebugPaused(true);
      setDebugSessionActive(true);
      setIsLoading(false); // Stop general loading indicator
      setLoadingConversationId(null);
      closeEventStream();
      stopPolling(); // Stop any active polling
      // Update detailed conversation from debug state if needed (e.g., messages)
      setDetailedConversation(prev => {
        if (prev?.id === conversationId && data.debugState.messages) {
          // Avoid unnecessary updates if messages haven't changed
          if (JSON.stringify(prev.messages) !== JSON.stringify(data.debugState.messages)) {
             log.debug("Updating detailed conversation messages from debug state");
             return { ...prev, messages: data.debugState.messages, updatedAt: data.debugState.updatedAt };
          }
        }
        return prev;
      });
      // Update conversation list status, title, and flowId from debug state
      setConversationList(prevList => prevList.map(c =>
        c.id === conversationId
          ? {
              ...c,
              title: data.debugState.title ?? c.title, // Use debug state title if available
              flowId: data.debugState.flowId ?? c.flowId, // Use debug state flowId if available
              status: 'paused_debug' as ConversationListItem['status'], // Set status specifically
              updatedAt: data.debugState.updatedAt // Use debug state timestamp
            }
          : c
      ).sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt))); // Re-sort
      return true; // Indicate debug state was handled
    } else if ((data.status === 'completed' || data.status === 'error') && isViewed) {
      // Only hide the debugger panel if the execution is definitively finished
      // or errored — and only when the finished conversation is the one on
      // screen (a background run ending must not close the viewed debugger).
      log.info(`API Response: Execution completed or errored (Status: ${data.status}). Hiding debugger panel.`, { conversationId });
      setDebuggerRequested(false);
      setDebugAttaching(false);
      setExecuteInDebugger(false);
      setIsDebugPaused(false);
      setDebugState(null);
      setDebugSessionActive(false);
      setBreakpoints([]);
    } else {
       // For other statuses ('running', 'awaiting_tool_approval'), keep the debugger panel state as is.
       log.debug(`API Response: Status is '${data.status}'. Debugger panel visibility unchanged (currently ${isDebugPaused ? 'visible' : 'hidden'}).`, { conversationId });
    }

    // --- Handle Standard Completion/Polling Response ---
    // Assuming 'data' might be a full Conversation object from polling or a completion response
    if (data.messages && data.conversation_id === conversationId) {
       // --- Timestamp Validation ---
       const validatedMessages = data.messages.map((msg: any, index: number) => {
         if (typeof msg.timestamp !== 'number' || isNaN(msg.timestamp)) {
           log.warn(`Invalid timestamp found in message index ${index} from API response. Defaulting to Date.now().`, { conversationId, messageId: msg.id, invalidTimestamp: msg.timestamp });
           return { ...msg, timestamp: Date.now() };
         }
         return msg;
       });
       // --- End Timestamp Validation ---

       // Update detailed conversation state from standard response/polling
       setDetailedConversation(prevDetailed => {
         let newState = prevDetailed; // Start with the previous state
         if (prevDetailed?.id === conversationId) {
           // Compare validated messages
           const messagesChanged = JSON.stringify(prevDetailed.messages) !== JSON.stringify(validatedMessages);
           if (messagesChanged) {
             log.info('API Response/Polling: Updating detailed conversation messages', { conversationId, newMessageCount: validatedMessages.length });
             // Use updatedAt from response if available, otherwise keep existing
             newState = { ...prevDetailed, messages: validatedMessages, updatedAt: data.updatedAt || prevDetailed.updatedAt }; // Use validated messages
           }
         }
         // Log *after* determining the newState, whether it changed or not
         log.debug('Polling: setDetailedConversation callback executed.', {
           conversationId,
           messagesChanged: newState !== prevDetailed, // Log if the state object reference changed
           newMessageCount: newState?.messages?.length ?? 'N/A' // Log the message count of the state being set
         });
         return newState; // Return the determined state (either old or new)
       });
    }

    // Update pending tool calls based on standard response/polling data
    if (data.status === 'awaiting_tool_approval') {
      log.info('API Response/Polling: Pausing for tool approval', { conversationId });
      // The approval prompt belongs to the viewed conversation only — same
      // bleed rule as the SSE run:awaiting_approval handler.
      if (isViewed) setPendingToolCalls(data.pendingToolCalls || []);
      if (isTracked) {
        setIsLoading(false); // Stop loading indicator
        setLoadingConversationId(null);
        closeEventStream();
        stopPolling();
      }
    } else if (data.status === 'completed' || data.status === 'error') {
      log.info('API Response/Polling: Stopping due to final status', { conversationId, status: data.status });
      if (isTracked) {
        stopPolling();
        setIsLoading(false);
        setLoadingConversationId(null);
        closeEventStream();
      }
      if (data.status === 'error') {
         // Handle OpenAI compatible error structure
         const errorMessage = data.error?.message || data.lastResponse?.error || t('chat.page.unknownExecutionError');
         // A user Stop ends the run as a cancellation error: present it neutrally
         // (the "stopped" banner) rather than flashing a red failure.
         if (CANCELLED_MESSAGE_RE.test(errorMessage) || stoppedConversationIdsRef.current.has(conversationId)) {
           markConversationStopped(conversationId, true);
           // Don't wipe an error banner that may belong to another conversation.
           if (isTracked || isViewed) setError(null);
           setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
           log.info('API Response/Polling: Execution cancelled by user', { conversationId });
         } else {
           setError(errorMessage);
           log.error('API Response/Polling: Execution resulted in error', { conversationId, error: data.error || data.lastResponse });
         }
      }
      // Fetch final state one last time for completed/error. (For a background
      // conversation this resolves to a silent list refresh — the detail fetch
      // itself refuses to clobber the viewed conversation.)
      fetchDetailedConversation(conversationId);
    } else if (data.status === 'running' && !isDebugPaused) {
       // If status is running and we are NOT paused for debug, clear pending calls and continue polling/loading
       if (isViewed) setPendingToolCalls(null);
       if (isTracked && !pollingIntervalRef.current) { // Restart polling if it stopped
          setIsLoading(true); // Ensure loading indicator is on
       }
    } else {
       // Other statuses or conditions
       if (isViewed) setPendingToolCalls(null); // Clear pending calls for safety
    }

    // Update conversation list status, title, and flowId from standard response/polling with type assertion
    if (data.conversation_id === conversationId) { // Update if the ID matches, regardless of status presence
       setConversationList(prevList => prevList.map(c =>
         c.id === conversationId
           ? {
               ...c,
               // Update fields from the response data if they exist
               title: data.title ?? c.title, // Use new title if available, else keep old
               flowId: data.flowId ?? c.flowId, // Use new flowId if available, else keep old
               status: data.status as ConversationListItem['status'] ?? c.status, // Use new status if available, else keep old
               updatedAt: data.updatedAt || c.updatedAt // Always update timestamp
             }
           : c
       ).sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt))); // Re-sort based on potentially new timestamp
    }


    return false; // Indicate standard response was handled
  }, [setDetailedConversation, setPendingToolCalls, setIsLoading, setError, setIsDebugPaused, setDebugState, setConversationList, fetchDetailedConversation, closeEventStream, markConvRunning, patchConversationStatus, markConversationStopped, t]);


  // Function to stop polling (legacy interval; live updates now use SSE)
  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      log.debug('Stopping polling interval');
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  };

  // The live event stream is opened imperatively at run start (see
  // sendToChatCompletions / debug handlers) so it is connected before events
  // are emitted. Here we only ensure it is torn down when the component unmounts.
  useEffect(() => {
    return () => {
      closeEventStream();
    };
  }, [closeEventStream]);

  // (The 1s elapsed/"stuck" tick lives inside LiveRunIndicator — keeping it
  // here re-rendered every message bubble once per second during a run.)

  // Send conversation to chat completions API
  // Returns true on success, false on error
  const sendToChatCompletions = async (conversation: Conversation): Promise<boolean> => {
    // Ensure we use the detailed conversation's ID and flowId
    if (!conversation?.id || !conversation.flowId || !openaiRef.current) {
       log.error("Cannot send to completions: Missing conversation ID or flow ID.", { id: conversation?.id, flowId: conversation?.flowId });
       setError(t('chat.page.agentMissing'));
       return false;
    }

    // Reset pending calls and error before sending
    setPendingToolCalls(null);
    setError(null);
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
    setIsLoading(true); // Set loading true for the API call itself
    setLoadingConversationId(conversation.id); // Scope the live indicator to this conversation
    markConvRunning(conversation.id, true);
    patchConversationStatus(conversation.id, 'running');
    // A fresh run supersedes a prior Stop on this conversation (run:start does
    // this too, but clear it before any event arrives so the re-attach guard
    // and the cancel-classifying catches don't act on the stale flag).
    markConversationStopped(conversation.id, false);
    // Sending is what creates a client-only conversation (an unsent split) on
    // the backend — runFlow persists its initial state at run start — so from
    // here on it is real: detail fetches and list refreshes may treat it
    // normally. Restored in the catch below: if the send fails before the
    // backend persisted anything, the split must stay client-only or the next
    // list poll would silently wipe it.
    const wasLocalOnly = localOnlyConversationIdsRef.current.delete(conversation.id);
    // Seed live stats immediately so the indicator shows 0 tokens / 0s right away.
    setLiveStats({ totalTokens: 0, activeNode: null, startedAt: Date.now(), lastEventAt: Date.now() });
    // Subscribe to live events BEFORE issuing the (blocking) POST so no early
    // events are missed on a fast run.
    await openEventStream(conversation.id);

    let success = false; // Track if API call itself succeeded

    try {
      // Resolve the model string sent to /v1/chat/completions.
      // Quick-Chats (issue #61) carry an in-memory flow SNAPSHOT on the
      // conversation state and their flowId (quickchat-<id>) is NOT in the flows
      // store, so there is nothing to look up: the backend ignores the model for
      // an existing conversation and resolves the flow from the snapshot. A
      // stable, non-"model-" label keeps it on the flow path.
      let modelName: string;
      if (isQuickChatFlowId(conversation.flowId)) {
        modelName = 'flow-Quick Chat';
        log.debug('Sending quick chat to completions', { flowId: conversation.flowId, conversationId: conversation.id });
      } else {
        // Look up the flow by ID to get its name
        const flow = await flowService.getFlow(conversation.flowId);
        if (!flow) {
          throw new Error(`Flow with ID ${conversation.flowId} not found`);
        }
        modelName = `flow-${flow.name}`;
        log.debug('Sending to chat completions', { flowId: conversation.flowId, flowName: flow.name, conversationId: conversation.id });
      }

      // Prepare messages for the API from the detailed conversation.
      // depth>0 messages are nested subflow steps served by the backend's
      // projection for display only — they are never part of the parent
      // transcript and must not be sent back as history.
      const messages = conversation.messages
        .filter(msg => !msg.disabled && !((msg.depth ?? 0) > 0))
        .map(msg => {
          // Collapse text/doc/audio to a string or, for image attachments, a
          // multipart array (so vision models receive the image).
          const content = buildApiContent(msg);

          // Include processNodeId in the message object if it exists
          const processNodeId = msg.processNodeId;
          // Carry the client message id/timestamp: the backend preserves them,
          // so the canonical copy keeps the SAME id as the optimistic bubble
          // and the live view merges instead of duplicating (dedupe is by id).
          const identity = { id: msg.id, timestamp: msg.timestamp };

          // Create properly typed message based on role
          if (msg.role === 'user') {
            // For user messages, include processNodeId as a custom property
            return {
              role: 'user',
              content,
              ...identity,
              processNodeId // Include processNodeId if it exists
            } as OpenAI.ChatCompletionUserMessageParam & { id?: string; timestamp?: number; processNodeId?: string };
          }
          if (msg.role === 'assistant') {
            return {
              role: 'assistant',
              content,
              tool_calls: msg.tool_calls,
              toolPayloads: msg.toolPayloads,
              ...identity,
              processNodeId // Include processNodeId if it exists
            } as OpenAI.ChatCompletionAssistantMessageParam & { id?: string; timestamp?: number; processNodeId?: string };
          }
          if (msg.role === 'system') {
            return {
              role: 'system',
              content,
              ...identity,
              processNodeId // Include processNodeId if it exists
            } as OpenAI.ChatCompletionSystemMessageParam & { id?: string; timestamp?: number; processNodeId?: string };
          }
          if (msg.role === 'tool') {
            if (!msg.tool_call_id) {
              return {
                role: 'user',
                content: typeof content === 'string' ? `Tool result: ${content}` : content,
                ...identity,
                processNodeId // Include processNodeId if it exists
              } as OpenAI.ChatCompletionUserMessageParam & { id?: string; timestamp?: number; processNodeId?: string };
            }
            return {
              role: 'tool',
              content,
              tool_call_id: msg.tool_call_id,
              toolPayloads: msg.toolPayloads,
              ...identity,
              processNodeId // Include processNodeId if it exists
            } as OpenAI.ChatCompletionToolMessageParam & { id?: string; timestamp?: number; processNodeId?: string };
          }
          // Fallback
          return {
            role: 'user',
            content,
            ...identity,
            processNodeId // Include processNodeId if it exists
          } as OpenAI.ChatCompletionUserMessageParam & { id?: string; timestamp?: number; processNodeId?: string };
        });

      // Call the API
      const completion = await openaiRef.current.chat.completions.create({
        model: modelName,
        messages,
        stream: false,
        metadata: (() => {
            const appContexts = mcpAppContextsByConversationRef.current.get(conversation.id);
            const meta: ChatCompletionMetadata = {
                flujo: "true",
                requireApproval: requireApproval ? "true" : undefined,
                flujodebug: executeInDebugger ? "true" : undefined, // Add flujodebug flag
                conversationId: conversation.id, // Pass the correct ID
                compactToolPayloads: "true",
                // Undefined means "retain backend state"; only a hydrated or
                // explicitly updated map is sent. This prevents navigation from
                // accidentally clearing a conversation with `{}`.
                mcpAppContexts: appContexts === undefined
                  ? undefined
                  : JSON.stringify(appContexts),
            };
            // Ensure only defined string values are included
            const filteredMeta: { [key: string]: string } = {};
            if (meta.flujo) filteredMeta.flujo = meta.flujo;
            if (meta.requireApproval) filteredMeta.requireApproval = meta.requireApproval;
            if (meta.flujodebug) filteredMeta.flujodebug = meta.flujodebug; // Include flujodebug
            if (meta.conversationId) filteredMeta.conversationId = meta.conversationId;
            if (meta.compactToolPayloads) filteredMeta.compactToolPayloads = meta.compactToolPayloads;
            if (meta.mcpAppContexts !== undefined) {
              filteredMeta.mcpAppContexts = meta.mcpAppContexts;
            }
            return filteredMeta;
        })()
      });

      log.debug('Chat completion initial response received', { completionId: completion.id });
      success = true; // API call itself succeeded

      // --- Normalize completion data for the shared response handler ---
      const responseData = {
          ...(completion as any), // Spread the completion data (use 'any' carefully)
          // Ensure essential fields for handleApiResponse are present
          status: (completion as any).status || 'completed', // Infer status if needed
          conversation_id: conversation.id,
          messages: (completion as any).messages || conversation.messages, // Use messages from completion if available
          pendingToolCalls: (completion as any).pendingToolCalls,
          debugState: (completion as any).debugState,
          error: (completion as any).error,
          lastResponse: (completion as any).lastResponse,
          updatedAt: (completion as any).updatedAt || Date.now() // Add timestamp if missing
      };

      const handledDebug = handleApiResponse(responseData, conversation.id);

      // If debug state was handled, polling is stopped by the handler
      // If not handled (standard response), start polling if needed (isLoading is true)
      if (!handledDebug && !pollingIntervalRef.current) {
         log.debug("Starting polling after initial non-debug response.");
         // Polling will be started by the useEffect based on isLoading=true
      } else if (handledDebug) {
         log.debug("Debug state handled, polling remains stopped.");
      }

    } catch (err: unknown) {
      // A user Stop cancels the in-flight completion, which rejects here. That is
      // not a failure to surface — the run already ended cleanly as cancelled,
      // and a neutral "stopped" banner covers it. Suppress the scary error path.
      if (isCancellationError(err) || stoppedConversationIdsRef.current.has(conversation.id)) {
        log.info('Chat completion cancelled by user', { conversationId: conversation.id });
        success = false;
        markConvRunning(conversation.id, false);
        markConversationStopped(conversation.id, true);
        // Only tear down the live view if it still belongs to this run — the
        // user may have started a run in another conversation since, and its
        // stream/indicator must survive this one's ending.
        if (loadingConversationIdRef.current === conversation.id) {
          stopPolling();
          setIsLoading(false);
          setLoadingConversationId(null);
          closeEventStream();
          setError(null);
          setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
        }
        return success;
      }
      log.error('Error calling chat completions API:', err);
      success = false; // API call failed

      // ... (keep existing detailed error handling) ...
      let errorMessage = 'An error occurred while sending the message.';
      if (err instanceof APIError) {
        errorMessage = `API Error: ${err.message} (Status: ${err.status})`;
        if (err.code) errorMessage += ` (Code: ${err.code})`;
        if (err.type) errorMessage += ` [Type: ${err.type}]`;
        log.verbose('APIError details', JSON.stringify(err));
      } else if (err instanceof OpenAIError) {
        errorMessage = `OpenAI Error: ${err.message}`;
        const nestedError = (err as any).error;
        if (nestedError && typeof nestedError === 'object') {
          if (nestedError.code) errorMessage += ` (Code: ${nestedError.code})`;
          if (nestedError.type) errorMessage += ` [Type: ${nestedError.type}]`;
        }
        log.verbose('OpenAIError details', JSON.stringify(err));
      } else if (err instanceof ChatApiError) {
        // A backend REST error surfaced through chatService.
        errorMessage = `Error: ${err.body?.error || err.message}`;
        if (err.status) errorMessage += ` (Status: ${err.status})`;
        log.verbose('ChatApiError details', JSON.stringify(err.body));
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }
      setError(errorMessage);
      markConvRunning(conversation.id, false);
      // Same scoping as the cancel branch: this conversation's failure must
      // not dismantle a live view that now belongs to another conversation.
      if (loadingConversationIdRef.current === conversation.id) {
        stopPolling();
        setIsLoading(false); // Stop loading on error
        setLoadingConversationId(null);
        closeEventStream();
      }
      // The send failed — if the conversation was client-only (unsent split),
      // re-shield it so the list poll doesn't wipe it before a retry.
      if (wasLocalOnly) localOnlyConversationIdsRef.current.add(conversation.id);

    } finally {
      // Don't set isLoading false here if polling might still be needed
      // isLoading is managed by handleApiResponse or the polling useEffect
    }
    return success; // Return if the API call itself was successful
  };

  // Toggle message disabled state (operates on detailedConversation)
  const toggleMessageDisabled = (messageId: string) => {
    if (!detailedConversation) return;
    log.debug('Toggling message disabled state', { messageId });
    const updatedMessages = detailedConversation.messages.map(msg =>
      msg.id === messageId ? { ...msg, disabled: !msg.disabled } : msg
    );
    updateDetailedConversationState({
      ...detailedConversation,
      messages: updatedMessages
    });
  };

  // #97: stable MCP App -> conversation return channels. ui/message starts a
  // follow-up user turn. ui/update-model-context is deliberately separate: it
  // only replaces that app's wire context for a future turn.
  const handleSendMessageRef = useRef(handleSendMessage);
  handleSendMessageRef.current = handleSendMessage;
  const appCallbackConversationId = currentConversationId;
  const handleAppMessage = useCallback((text: string): boolean => {
    if (
      !appCallbackConversationId
      || currentConversationIdRef.current !== appCallbackConversationId
    ) return false;
    void handleSendMessageRef.current(text);
    return true;
  }, [appCallbackConversationId]);
  const handleAppModelContext = useCallback((
    appKey: string,
    context: McpAppModelContext,
  ): boolean => {
    const capturedConversationId = appCallbackConversationId;
    if (
      !capturedConversationId
      || currentConversationIdRef.current !== capturedConversationId
    ) return false;
    const next = {
      ...(mcpAppContextsByConversationRef.current.get(capturedConversationId) ?? {}),
    };
    // An empty update clears this View's prior context.
    if (context.content === undefined && context.structuredContent === undefined) {
      delete next[appKey];
    } else {
      next[appKey] = context;
    }
    if (jsonUtf8ByteLength(next) > MAX_MCP_APP_CONTEXT_BYTES) {
      log.warn('Rejected oversized aggregate MCP App model context', {
        conversationId: capturedConversationId,
        appKey,
      });
      return false;
    }
    mcpAppContextsByConversationRef.current.set(capturedConversationId, next);
    return true;
  }, [appCallbackConversationId]);

  // --- #216: conversation-level docked MCP Apps canvas ---------------------
  const [canvasState, setCanvasState] = useState<CanvasState>(emptyCanvasState);
  const [canvasStateOwnerId, setCanvasStateOwnerId] = useState<string | null>(
    currentConversationId,
  );
  const [canvasDockLayout, setCanvasDockLayout] = useState<CanvasDockLayout>({
    placement: 'bottom',
    reservedWidth: 0,
    reservedHeight: 0,
  });
  const handleCanvasLayoutChange = useCallback((next: CanvasDockLayout) => {
    setCanvasDockLayout((current) => (
      current.placement === next.placement
      && current.reservedWidth === next.reservedWidth
      && current.reservedHeight === next.reservedHeight
        ? current
        : next
    ));
  }, []);
  const pendingCanvasEvictionsRef = useRef<Set<string>>(new Set());
  const handleRegisterCanvasTeardown = useCallback((
    conversationId: string,
    appKey: string,
    callback: (() => Promise<void>) | null,
  ) => {
    const scopedKey = `${conversationId}\u0000${appKey}`;
    if (callback) canvasTeardownsRef.current.set(scopedKey, callback);
    else canvasTeardownsRef.current.delete(scopedKey);
  }, []);
  const handleRegisterInlineTeardown = useCallback((
    registrationKey: string,
    callback: (() => Promise<void>) | null,
  ) => {
    if (!appCallbackConversationId) return;
    handleRegisterCanvasTeardown(
      appCallbackConversationId,
      registrationKey,
      callback,
    );
  }, [appCallbackConversationId, handleRegisterCanvasTeardown]);

  // A View can enter the canvas only after its inline handshake declared pip
  // and either the View or user requested the transition.
  const handleOpenInCanvas = useCallback((info: CanvasLaunchInfo) => {
    const owner = currentConversationIdRef.current;
    if (!owner) return;
    const key = canvasKey(info.serverName, info.uri);
    // #375: an automatic open is gated by BOTH the per-app dismissal AND the
    // sticky "dock is collapsed" suppression flag; a defensive `healthy`
    // guard also blocks a frame that already failed its handshake/validation
    // from ever reaching the canvas. A manual (user-clicked) open always wins.
    if (!shouldOpenCanvasApp({
      automatic: Boolean(info.automatic),
      dismissed: readDismissedMcpAppKeys(owner).includes(key),
      suppressed: readAutoOpenSuppressed(owner),
      healthy: info.healthy,
    })) return;
    if (!info.automatic) {
      setMcpAppDismissed(owner, key, false);
      setAutoOpenMcpAppsSuppressed(owner, false);
    }
    setCanvasStateOwnerId(owner);
    setCanvasState((prev) => {
      // Temporarily permit one extra mounted host; the cap effect below awaits
      // the LRU victim's graceful teardown before removing it.
      const { state } = openCanvasApp(prev, info, Date.now(), Number.MAX_SAFE_INTEGER);
      return state;
    });
  }, [setAutoOpenMcpAppsSuppressed, setMcpAppDismissed]);
  /**
   * #375: collapsing the dock is an explicit "stop auto-opening" intent, not a
   * pure UI toggle — dismiss every currently-docked app AND suppress future
   * automatic opens. Expanding again only lifts the suppression; individual
   * apps stay dismissed until the user manually reopens them (manual open
   * already clears their own dismissal above).
   */
  const handleCanvasCollapseChange = useCallback((collapsedNow: boolean) => {
    const owner = currentConversationIdRef.current;
    if (!owner) return;
    if (collapsedNow) {
      writeMcpAppsDismissed(owner, canvasEntries(canvasState).map((e) => e.key), true);
      setAutoOpenMcpAppsSuppressed(owner, true);
    } else {
      setAutoOpenMcpAppsSuppressed(owner, false);
    }
  }, [canvasState, setAutoOpenMcpAppsSuppressed]);
  /**
   * #375: single "close all sandboxes" action — tears down every docked app
   * (real React unmount + `teardown()`, never a bare CSS hide), dismisses
   * them all, suppresses further automatic opens, and resets collapse so a
   * stale collapsed flag does not linger once the dock is empty.
   */
  const handleCloseAllCanvas = useCallback(() => {
    const owner = currentConversationIdRef.current;
    if (!owner) return;
    const keys = canvasEntries(canvasState).map((e) => e.key);
    if (keys.length === 0) return;
    writeMcpAppsDismissed(owner, keys, true);
    setAutoOpenMcpAppsSuppressed(owner, true);
    const pending = keys.map((key) => {
      const registered = canvasTeardownsRef.current.get(`${owner} ${key}`);
      return registered ? registered() : Promise.resolve();
    });
    void Promise.allSettled(pending).finally(() => {
      if (currentConversationIdRef.current !== owner) return;
      setCanvasState((prev) => {
        let next = prev;
        for (const key of keys) next = closeCanvasApp(next, key);
        return next;
      });
    });
  }, [canvasState, setAutoOpenMcpAppsSuppressed]);
  const handleSelectCanvasTab = useCallback((key: string) => {
    setCanvasState((prev) => setActiveCanvasTab(prev, key));
  }, []);
  const handleCloseCanvasTab = useCallback((key: string) => {
    const owner = appCallbackConversationId;
    if (!owner) return;
    setMcpAppDismissed(owner, key, true);
    const registered = canvasTeardownsRef.current.get(`${owner}\u0000${key}`);
    const close = () => {
      if (currentConversationIdRef.current !== owner) return;
      setCanvasState((prev) => closeCanvasApp(prev, key));
    };
    if (registered) void registered().finally(close);
    else close();
  }, [appCallbackConversationId, setMcpAppDismissed]);

  // Reset the canvas when switching conversations (per-conversation surface).
  useEffect(() => {
    setCanvasStateOwnerId(currentConversationId);
    setCanvasState(emptyCanvasState);
    setCanvasDockLayout({ placement: 'bottom', reservedWidth: 0, reservedHeight: 0 });
  }, [currentConversationId]);

  // Later results replace an already-open canvas View. New apps remain inline
  // until a pip-capable View/user explicitly requests the canvas transition.
  const canvasOrderKey = canvasState.order.join('|');
  useEffect(() => {
    const msgs = detailedConversation?.messages;
    if (
      !msgs ||
      !detailedConversation ||
      detailedConversation.id !== currentConversationId ||
      canvasStateOwnerId !== currentConversationId
    ) return;

    const toolCalls = new Map<string, OpenAI.ChatCompletionMessageFunctionToolCall>();
    for (const m of msgs) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const call of m.tool_calls) {
        if (call.type === 'function' && call.id) toolCalls.set(call.id, call);
      }
    }

    const latest = new Map<string, CanvasAppInput>();
    for (const m of msgs) {
      const ui = (m as FlujoChatMessage).ui;
      if (m.role === 'tool' && ui?.uri && ui?.serverName && typeof m.content === 'string') {
        const call = typeof m.tool_call_id === 'string' ? toolCalls.get(m.tool_call_id) : undefined;
        const input: CanvasAppInput = {
          serverName: ui.serverName,
          uri: ui.uri,
          toolName: ui.toolName ?? (call?.type === 'function' ? call.function.name : undefined),
          toolArgs: ui.toolArgs ?? (call?.type === 'function' ? call.function.arguments : undefined),
          resultContent: m.content,
          cancelledReason: ui.cancelledReason,
          isError: ui.isError,
          updateId: m.id,
        };
        latest.set(`${ui.serverName}::${ui.uri}`, input);
      }
    }

    setCanvasState((prev) => {
      let next = prev;
      for (const key of next.order) {
        const entry = next.entries[key];
        const input = latest.get(key);
        if (
          entry
          && input
          && (
            input.updateId !== entry.latestToolUpdateId
            || input.toolArgs !== entry.latestToolArgs
            || (
              input.cancelledReason === undefined
              && input.resultContent !== entry.latestResultContent
            )
            || input.cancelledReason !== entry.latestToolCancelledReason
            || input.isError !== entry.latestToolIsError
          )
        ) {
          next = updateCanvasApp(next, input);
        }
      }
      return next;
    });
  }, [
    canvasOrderKey,
    canvasStateOwnerId,
    currentConversationId,
    detailedConversation?.id,
    detailedConversation?.messages,
  ]);

  // Enforce the live-host cap only after each LRU victim has acknowledged
  // ui/resource-teardown (or its one-second deadline elapsed).
  useEffect(() => {
    const owner = currentConversationId;
    if (
      !owner
      || canvasStateOwnerId !== owner
      || canvasState.order.length <= DEFAULT_CANVAS_TAB_CAP
    ) return;
    const { evicted } = enforceCap(
      canvasState,
      DEFAULT_CANVAS_TAB_CAP,
      canvasState.activeKey ?? undefined,
    );
    for (const key of evicted) {
      const scopedKey = `${owner}\u0000${key}`;
      if (pendingCanvasEvictionsRef.current.has(scopedKey)) continue;
      pendingCanvasEvictionsRef.current.add(scopedKey);
      log.info(`Canvas tab cap reached — gracefully evicting (LRU): ${key}`);
      const registered = canvasTeardownsRef.current.get(scopedKey);
      const pending = registered ? registered() : Promise.resolve();
      void pending.finally(() => {
        pendingCanvasEvictionsRef.current.delete(scopedKey);
        if (currentConversationIdRef.current !== owner) return;
        setCanvasState((previous) => closeCanvasApp(previous, key));
      });
    }
  }, [canvasState, canvasStateOwnerId, currentConversationId]);

  // Edit a message and re-send the conversation (operates on detailedConversation)
  const handleEditMessage = async (messageId: string, newContent: string, processNodeId?: string | null) => {
    if (!detailedConversation) return;
    log.debug('Editing message', { messageId, contentLength: newContent.length, processNodeId });

    const messageIndex = detailedConversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    const messageToEdit = detailedConversation.messages[messageIndex];
    const updatedMessage: ChatMessage = {
      ...messageToEdit,
      content: newContent,
      timestamp: Date.now(),
      processNodeId: processNodeId || undefined // Add processNodeId to the message
    };

    const messagesUpToEdit = [
      ...detailedConversation.messages.slice(0, messageIndex),
      updatedMessage
    ];

    const updatedDetailedConv = {
      ...detailedConversation,
      messages: messagesUpToEdit
    };
    updateDetailedConversationState(updatedDetailedConv); // Optimistic update

    if (updatedDetailedConv.flowId) {
      // Create metadata with processNodeId for the API call
      const editedConversationAppContexts =
        mcpAppContextsByConversationRef.current.get(updatedDetailedConv.id);
      const metadata: ChatCompletionMetadata = {
        flujo: "true",
        requireApproval: requireApproval ? "true" : undefined,
        flujodebug: executeInDebugger ? "true" : undefined,
        conversationId: updatedDetailedConv.id,
        processNodeId: processNodeId || undefined, // Add processNodeId to metadata
        mcpAppContexts: editedConversationAppContexts === undefined
          ? undefined
          : JSON.stringify(editedConversationAppContexts),
      };

      // Call the API with the updated metadata
      if (!openaiRef.current) return;
      setError(null);
      setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
      setIsLoading(true);
      setLoadingConversationId(updatedDetailedConv.id);
      markConvRunning(updatedDetailedConv.id, true);
      markConversationStopped(updatedDetailedConv.id, false); // a fresh run supersedes a prior Stop
      setLiveStats({ totalTokens: 0, activeNode: null, startedAt: Date.now(), lastEventAt: Date.now() });
      await openEventStream(updatedDetailedConv.id);
      try {
        const flow = await flowService.getFlow(updatedDetailedConv.flowId);
        if (!flow) {
          throw new Error(`Flow with ID ${updatedDetailedConv.flowId} not found`);
        }

        // Prepare messages for the API (depth>0 = display-only subflow steps,
        // never sent back as history — same rule as the send path)
        const messages = updatedDetailedConv.messages
          .filter(msg => !msg.disabled && !((msg.depth ?? 0) > 0))
          .map(msg => {
            // Same content shaping as the send path: string for text/doc/audio,
            // multipart array when image attachments are present.
            const content = buildApiContent(msg);
            // Same identity carry as the send path: preserved ids keep the
            // canonical copies mergeable with what the UI already shows.
            const identity = { id: msg.id, timestamp: msg.timestamp, processNodeId: msg.processNodeId };
            // Create properly typed message based on role
            if (msg.role === 'user') return { role: 'user', content, ...identity } as OpenAI.ChatCompletionUserMessageParam;
            if (msg.role === 'assistant') return {
              role: 'assistant', content, tool_calls: msg.tool_calls, toolPayloads: msg.toolPayloads, ...identity,
            } as OpenAI.ChatCompletionAssistantMessageParam;
            if (msg.role === 'system') return { role: 'system', content, ...identity } as OpenAI.ChatCompletionSystemMessageParam;
            if (msg.role === 'tool') {
              if (!msg.tool_call_id) return { role: 'user', content: typeof content === 'string' ? `Tool result: ${content}` : content, ...identity } as OpenAI.ChatCompletionUserMessageParam;
              return {
                role: 'tool', content, tool_call_id: msg.tool_call_id, toolPayloads: msg.toolPayloads, ...identity,
              } as OpenAI.ChatCompletionToolMessageParam;
            }
            return { role: 'user', content, ...identity } as OpenAI.ChatCompletionUserMessageParam; // Fallback
          });

        // Make the API call with processNodeId in metadata
        const completion = await openaiRef.current.chat.completions.create({
          model: `flow-${flow.name}`,
          messages,
          stream: false,
          metadata: (() => {
            // Filter out undefined values
            const filteredMeta: { [key: string]: string } = {};
            if (metadata.flujo) filteredMeta.flujo = metadata.flujo;
            if (metadata.requireApproval) filteredMeta.requireApproval = metadata.requireApproval;
            if (metadata.flujodebug) filteredMeta.flujodebug = metadata.flujodebug;
            if (metadata.conversationId) filteredMeta.conversationId = metadata.conversationId;
            filteredMeta.compactToolPayloads = 'true';
            if (metadata.processNodeId) filteredMeta.processNodeId = metadata.processNodeId;
            if (metadata.mcpAppContexts !== undefined) {
              filteredMeta.mcpAppContexts = metadata.mcpAppContexts;
            }
            return filteredMeta;
          })()
        });

        // Handle the response using the existing handler
        const responseData = {
          ...(completion as any),
          status: (completion as any).status || 'completed',
          conversation_id: updatedDetailedConv.id,
          messages: (completion as any).messages || updatedDetailedConv.messages,
          pendingToolCalls: (completion as any).pendingToolCalls,
          debugState: (completion as any).debugState,
          error: (completion as any).error,
          updatedAt: (completion as any).updatedAt || Date.now()
        };

        handleApiResponse(responseData, updatedDetailedConv.id);

      } catch (err) {
        const cancelled = isCancellationError(err) || stoppedConversationIdsRef.current.has(updatedDetailedConv.id);
        if (cancelled) {
          log.info('Edited-message run cancelled by user', { conversationId: updatedDetailedConv.id });
          markConversationStopped(updatedDetailedConv.id, true);
        } else {
          log.error('Error sending edited message:', err);
          setError(err instanceof Error ? err.message : t('chat.page.sendEditedFailed'));
        }
        markConvRunning(updatedDetailedConv.id, false);
        // Scoped teardown: leave another conversation's live view alone.
        if (loadingConversationIdRef.current === updatedDetailedConv.id) {
          setIsLoading(false);
          setLoadingConversationId(null);
          closeEventStream();
        }
      }
    }
  };

  // Begin editing a message in the ChatInput (issue: editing moved out of the
  // bubble). Only user messages with string content are editable.
  const beginEditMessage = useCallback((messageId: string) => {
    const msg = detailedConversation?.messages.find(m => m.id === messageId);
    if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') return;
    setEditingMessage({
      messageId,
      content: msg.content,
      nodeId: msg.processNodeId ?? (availableNodes[0]?.id ?? null),
    });
  }, [detailedConversation, availableNodes]);

  const handleEditingContentChange = useCallback((content: string) => {
    setEditingMessage(prev => (prev ? { ...prev, content } : prev));
  }, []);

  const handleEditingNodeChange = useCallback((nodeId: string | null) => {
    setEditingMessage(prev => (prev ? { ...prev, nodeId } : prev));
  }, []);

  // Plain function (not memoized): references handleEditMessage, which is
  // recreated each render — a useCallback would capture a stale copy.
  const handleSaveEditingMessage = () => {
    if (!editingMessage || !editingMessage.content.trim()) return;
    void handleEditMessage(editingMessage.messageId, editingMessage.content, editingMessage.nodeId || "");
    setEditingMessage(null);
  };

  const handleCancelEditingMessage = useCallback(() => setEditingMessage(null), []);

  // Split conversation at a message (creates new local conversation).
  //
  // `half` picks which side of the cut is kept:
  //   'head' → start … picked message (inclusive) — the original behaviour
  //   'tail' → picked message … end of the conversation
  const splitConversationAtMessage = (messageId: string, half: SplitHalf = 'head') => {
    if (!detailedConversation) return;
    log.debug('Splitting conversation at message', { messageId, half });

    const messageIndex = detailedConversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    const messagesBeforeSplit = buildSplitMessages(detailedConversation.messages, messageIndex, half);

    // A tail split can end up empty once orphan tool results are dropped —
    // creating a blank conversation would only confuse.
    if (messagesBeforeSplit.length === 0) {
      log.debug('Split produced no messages — ignoring', { messageId, half });
      return;
    }

    // Create a new *local* conversation based on the split
    const newId = uuidv4();
    const newSplitConversation: Conversation = {
      id: newId,
      title: t(half === 'head' ? 'chat.page.splitTitle' : 'chat.page.splitTailTitle', { title: detailedConversation.title }),
      messages: messagesBeforeSplit,
      flowId: detailedConversation.flowId,
      createdAt: Date.now(), // New creation time
      updatedAt: Date.now(),
    };

    // Add summary to list and select it
    const newSummary: ConversationListItem = {
       id: newId,
       title: newSplitConversation.title,
       flowId: newSplitConversation.flowId,
       createdAt: newSplitConversation.createdAt,
       updatedAt: newSplitConversation.updatedAt,
    };
    // Client-only until the first message is sent: shields it from list
    // refreshes and skips the (would-404) detail fetch.
    localOnlyConversationIdsRef.current.add(newId);
    setConversationList(prevList => [newSummary, ...prevList].sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt) - (a.lastUserMessageAt ?? a.updatedAt)));
    setCurrentConversationId(newId); // Select the new split conversation
    // The useEffect for currentConversationId will fetch details, but we can set it directly
    setDetailedConversation(newSplitConversation);
    setIsLoadingDetails(false);
    setDetailsError(null);
    // Note: This split conversation doesn't exist on the backend until a message is sent.
  };

  // Mirror of the above: keep the picked message through the END of the thread.
  const splitConversationFromMessage = (messageId: string) =>
    splitConversationAtMessage(messageId, 'tail');

  // Handle Approve/Reject Tool Call
  const handleToolResponse = async (action: 'approve' | 'reject', toolCallId: string, always?: boolean, feedback?: string) => {
    if (!currentConversationId) return;
    log.info(`Handling tool response: ${action}`, { conversationId: currentConversationId, toolCallId, always });

    setPendingToolCalls(null);
    setIsLoading(true); // Indicate processing and potentially restart polling
    setLoadingConversationId(currentConversationId);
    markConvRunning(currentConversationId, true);
    patchConversationStatus(currentConversationId, 'running');
    setError(null);
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
    await openEventStream(currentConversationId);

    try {
      // The /respond endpoint processes the approved/rejected call, then resumes
      // execution (re-invoking the model) once no calls remain pending. It
      // returns the next natural stop point — another approval prompt, a debug
      // pause, completion, or error — which we hand to the shared response
      // handler. Live updates also arrive over the already-open SSE stream.
      const data = await chatService.respondToToolCall(currentConversationId, action, toolCallId, always, feedback);
      log.debug(`Tool response successful`, { conversationId: currentConversationId, action, toolCallId });
      handleApiResponse(data, currentConversationId);

    } catch (err) {
      if (isCancellationError(err) || stoppedConversationIdsRef.current.has(currentConversationId)) {
        log.info('Tool-response resume cancelled by user', { conversationId: currentConversationId });
        markConversationStopped(currentConversationId, true);
        if (loadingConversationIdRef.current === currentConversationId) setIsLoading(false);
        markConvRunning(currentConversationId, false);
        return;
      }
      log.error(`Error sending tool response (${action})`, { conversationId: currentConversationId, toolCallId, err });
      let errorMessage = action === 'approve' ? t('chat.page.approveFailed') : t('chat.page.rejectFailed');
      if (err instanceof ChatApiError) {
        errorMessage += ` (${err.body?.error || err.message})`;
      } else if (err instanceof Error) {
        errorMessage += ` (${err.message})`;
      }
      setError(errorMessage);
      // Stop loading on error since polling won't restart — unless the live
      // view has since moved on to another conversation's run.
      if (loadingConversationIdRef.current === currentConversationId) setIsLoading(false);
      markConvRunning(currentConversationId, false);
    }
  };

  const handleApproveToolCall = (toolCallId: string, always?: boolean) => {
    handleToolResponse('approve', toolCallId, always);
  };

  const handleRejectToolCall = (toolCallId: string, always?: boolean, feedback?: string) => {
    handleToolResponse('reject', toolCallId, always, feedback);
  };

  /**
   * Issue #357: abort ONE in-flight (stalling) tool call. Unlike Stop this keeps
   * the run alive — the backend answers the aborted call with a cancelled tool
   * result and the model continues — so no loading/stream state changes here;
   * the tool:result event updates the chip.
   */
  const handleCancelToolCall = async (toolCallId: string) => {
    if (!currentConversationId) return;
    log.info('Cancelling single tool call', { conversationId: currentConversationId, toolCallId });
    try {
      await chatService.cancelToolCall(currentConversationId, toolCallId);
    } catch (err) {
      log.warn('Failed to cancel tool call', { conversationId: currentConversationId, toolCallId, err });
    }
  };

  const handleSubmitElicitation = async (
    elicitationId: string,
    content: Record<string, string | number | boolean | string[]>
  ) => {
    if (!currentConversationId) return;
    log.info('Submitting elicitation form', { conversationId: currentConversationId, elicitationId });
    setPendingElicitation(null);
    try {
      await fetch(`/v1/chat/conversations/${currentConversationId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'elicitation-submit', elicitationId, content }),
      });
    } catch (err) {
      log.error('Failed to submit elicitation', { conversationId: currentConversationId, elicitationId, err });
    }
  };

  const handleCancelElicitation = async (elicitationId: string) => {
    if (!currentConversationId) return;
    log.info('Cancelling elicitation', { conversationId: currentConversationId, elicitationId });
    setPendingElicitation(null);
    try {
      await fetch(`/v1/chat/conversations/${currentConversationId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'elicitation-cancel', elicitationId }),
      });
    } catch (err) {
      log.error('Failed to cancel elicitation', { conversationId: currentConversationId, elicitationId, err });
    }
  };

  const handleAnswerQuestion = async (questionId: string, answers: string[][]) => {
    if (!currentConversationId) return;
    log.info('Answering question', { conversationId: currentConversationId, questionId });
    setPendingQuestion(null);
    try {
      await fetch(`/v1/chat/conversations/${currentConversationId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'question-answer', questionId, answers }),
      });
    } catch (err) {
      log.error('Failed to answer question', { conversationId: currentConversationId, questionId, err });
    }
  };

  const handleDeclineQuestion = async (questionId: string) => {
    if (!currentConversationId) return;
    log.info('Declining question', { conversationId: currentConversationId, questionId });
    setPendingQuestion(null);
    try {
      await fetch(`/v1/chat/conversations/${currentConversationId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'question-decline', questionId }),
      });
    } catch (err) {
      log.error('Failed to decline question', { conversationId: currentConversationId, questionId, err });
    }
  };

  // --- Debugger Control Handlers ---
  const handleDebugStep = async () => {
    if (!currentConversationId || !isDebugPaused) return;
    log.info('Handling debug step request', { conversationId: currentConversationId });
    setIsLoading(true); // Show loading during step
    setLoadingConversationId(currentConversationId);
    markConvRunning(currentConversationId, true);
    setError(null);
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
    await openEventStream(currentConversationId);
    try {
      const data = await chatService.debugStep(currentConversationId);
      handleApiResponse(data, currentConversationId); // Process the response (updates state, status)
    } catch (err) {
      log.error('Error during debug step API call', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : t('chat.page.debugStepFailed'));
      setIsLoading(false); // Stop loading on error
      markConvRunning(currentConversationId, false);
      setIsDebugPaused(false); // Exit debug mode on error? Or just show error?
      setDebugState(null);
    } finally {
       // setIsLoading(false); // Loading is stopped by handleApiResponse on success/final state
    }
  };

  const handleDebugContinue = async () => {
    if (!currentConversationId || !isDebugPaused) return;
    log.info('Handling debug continue request', { conversationId: currentConversationId });
    setIsLoading(true); // Show loading during continue
    setLoadingConversationId(currentConversationId);
    markConvRunning(currentConversationId, true);
    patchConversationStatus(currentConversationId, 'running');
    setError(null);
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
    // Continue means detach and run normally. Close every local debugger surface
    // immediately; the route atomically clears debugMode and server breakpoints
    // while preserving the pending action/tool batch that still has to finish.
    setDebuggerRequested(false);
    setDebugAttaching(false);
    setExecuteInDebugger(false);
    setIsDebugPaused(false);
    setDebugState(null);
    setDebugSessionActive(false);
    setBreakpoints([]);
    await openEventStream(currentConversationId);
    try {
      const data = await chatService.debugContinue(currentConversationId);
      handleApiResponse(data, currentConversationId); // Process the response
      // Polling might restart via useEffect if status is 'running'
    } catch (err) {
      log.error('Error during debug continue API call', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : t('chat.page.debugContinueFailed'));
      setIsLoading(false); // Stop loading on error
      markConvRunning(currentConversationId, false);
    } finally {
       // setIsLoading(false); // Loading is stopped by handleApiResponse or polling
    }
  };

  // Keep local breakpoints in sync with the authoritative debug state.
  useEffect(() => {
    if (debugState) {
      setBreakpoints(debugState.breakpoints ?? []);
    }
  }, [debugState]);

  // Replace the whole breakpoint set (context-menu actions: clear all, arm/
  // disarm the `tool:*` tool breakpoint, …). Optimistic, reverts on failure.
  const handleSetBreakpoints = useCallback(async (next: string[]) => {
    if (!currentConversationId) return;
    const previous = breakpoints;
    setBreakpoints(next);
    try {
      await chatService.setBreakpoints(currentConversationId, next);
    } catch (err) {
      log.error('Failed to update breakpoints', { conversationId: currentConversationId, err });
      setBreakpoints(previous);
    }
  }, [breakpoints, currentConversationId]);

  // Toggle a breakpoint on a node and persist it to the server.
  const handleToggleBreakpoint = useCallback(async (nodeId: string) => {
    if (!currentConversationId) return;
    const next = breakpoints.includes(nodeId)
      ? breakpoints.filter(id => id !== nodeId)
      : [...breakpoints, nodeId];
    setBreakpoints(next); // optimistic
    try {
      await chatService.setBreakpoints(currentConversationId, next);
    } catch (err) {
      log.error('Failed to update breakpoints', { conversationId: currentConversationId, err });
      setBreakpoints(breakpoints); // revert on failure
    }
  }, [breakpoints, currentConversationId]);

  // Attach the debugger to an already-running conversation. Requests a one-shot
  // pause at the next safe runtime boundary (after the active model/tool call,
  // or before the next node) without replacing the user's breakpoints. When this client owns the run, the
  // still-pending send POST resolves with debugState; otherwise the pause is
  // picked up from the SSE stream and the state is pulled with getDebugState
  // (see the hydration effect below), so attaching also works for background
  // runs and after a reload.
  const handleAttachDebugger = useCallback(async () => {
    if (!currentConversationId) return;
    log.info('Attaching debugger to running conversation', { conversationId: currentConversationId });
    setDebugAttaching(true);
    try {
      await chatService.attachDebugger(currentConversationId);
    } catch (err) {
      log.error('Failed to attach debugger', { conversationId: currentConversationId, err });
      setDebugAttaching(false);
      setError(err instanceof Error ? err.message : t('chat.page.attachDebuggerFailed'));
    }
  }, [currentConversationId, t]);

  // THE Debugger control (single button, see ChatInput). One toggle covers what
  // used to be two separate controls:
  //   closed + idle conversation  → open the panel now, armed: the next run
  //                                 starts in debug mode (flujodebug).
  //   closed + running conversation → open the panel now, attaching: arm the
  //                                 one-shot breakpoint and wait for the pause.
  //   open                        → close it (detach, never cancel).
  // In both opening cases the panel appears IMMEDIATELY with a spinner and
  // disabled controls; it swaps to the live debugger the moment a debugState
  // exists.
  const handleToggleDebugger = useCallback(() => {
    const open = debuggerRequested || debugSessionActive || isDebugPaused;
    if (open) {
      void handleDebugCloseRef.current?.();
      return;
    }
    setDebuggerRequested(true);
    setExecuteInDebugger(true); // the next turn runs in debug mode
    const running =
      (isLoading && loadingConversationId === currentConversationId) ||
      (!!currentConversationId && runningConvs.has(currentConversationId)) ||
      currentConversationSummary?.status === 'running';
    if (running && currentConversationId) {
      if (!eventSourceRef.current) void openEventStream(currentConversationId);
      void handleAttachDebugger();
    }
  }, [
    debuggerRequested,
    debugSessionActive,
    isDebugPaused,
    isLoading,
    loadingConversationId,
    currentConversationId,
    runningConvs,
    currentConversationSummary?.status,
    handleAttachDebugger,
    openEventStream,
  ]);

  // Step Over: advance one node at a time until the active node changes (i.e.
  // skip a process node's internal tool-call iterations), or execution pauses
  // elsewhere / finishes. Implemented client-side as a bounded loop of steps.
  const handleStepOver = async () => {
    if (!currentConversationId || !isDebugPaused) return;
    const startNodeId = debugState?.currentNodeId;
    setIsLoading(true);
    setLoadingConversationId(currentConversationId);
    markConvRunning(currentConversationId, true);
    setError(null);
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
    await openEventStream(currentConversationId);
    try {
      for (let i = 0; i < 50; i++) {
        const data = await chatService.debugStep(currentConversationId);
        const status = data?.status ?? data?.debugState?.status;
        const nodeId = data?.debugState?.currentNodeId;
        // Stop once we leave the original node or are no longer paused for debug.
        if (status !== 'paused_debug' || (nodeId && nodeId !== startNodeId)) {
          handleApiResponse(data, currentConversationId);
          return;
        }
      }
      // Safety cap reached; surface whatever the last response was.
      log.warn('Step Over hit iteration cap', { conversationId: currentConversationId });
      setIsLoading(false);
      markConvRunning(currentConversationId, false);
    } catch (err) {
      log.error('Error during step over', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : t('chat.page.stepOverFailed'));
      setIsLoading(false);
      markConvRunning(currentConversationId, false);
    }
  };

  // Handle Cancel Request (Also used by Debugger)
  const handleCancelRequest = async () => {
    if (!currentConversationId) return;
    log.info('Cancelling request', { conversationId: currentConversationId });

    stopPolling();
    setIsLoading(false);
    setLoadingConversationId(null);
    markConvRunning(currentConversationId, false);
    markConversationStopped(currentConversationId, true); // present the end as a Stop, not an error
    setDebuggerRequested(false);
    setDebugAttaching(false);
    setExecuteInDebugger(false);
    setIsDebugPaused(false);
    setDebugState(null);
    setDebugSessionActive(false);
    setBreakpoints([]);
    closeEventStream();
    setPendingToolCalls(null);
    setRetryWait(null); // #400: Stop during a session-limit wait ends the wait too
    setError(null); // a deliberate Stop is not an error to surface
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error

    try {
      await chatService.cancel(currentConversationId);
      log.debug('Cancel request sent successfully', { conversationId: currentConversationId });
      // Fetch details again to get the potentially updated 'cancelled' status/message
      await fetchDetailedConversation(currentConversationId);
    } catch (err) {
      log.error('Error sending cancel request', { conversationId: currentConversationId, err });
      setError(t('chat.page.cancelFailed'));
    }
  };

  // Stop ANY conversation's run (sidebar stop button) — not just the viewed
  // one. For the viewed conversation, delegate to handleCancelRequest so the
  // local live-run state (stream, polling, pending approvals) is torn down too;
  // for a background conversation there is no local state to tear down, so
  // just cancel server-side and refresh the sidebar statuses.
  const handleStopConversation = async (conversationId: string) => {
    if (conversationId === currentConversationId) {
      await handleCancelRequest();
      return;
    }
    log.info('Stopping background conversation', { conversationId });
    markConversationStopped(conversationId, true);
    try {
      await chatService.cancel(conversationId);
      markConvRunning(conversationId, false);
      // Parked runs are finalized by the cancel route immediately; a live run
      // flips on its next loop iteration — the lifecycle stream catches that.
      await fetchConversations(undefined, { silent: true });
    } catch (err) {
      log.error('Error stopping background conversation', { conversationId, err });
      setError(t('chat.page.cancelFailed'));
    }
  };

  const handleSubflowRecovery = async (scope: SubflowRecoveryScope) => {
    if (!currentConversationId || subflowRecoveryScope) return;
    const conversationId = currentConversationId;
    setSubflowRecoveryScope(scope);
    setError(null);
    setErrorInfo(null); // Issue #383: keep errorInfo in sync with error
    try {
      const result = await chatService.retrySubflowRecovery(conversationId, scope);
      if (result.failed.length > 0) {
        setError(result.failed.map((failure) => failure.error).join('\n'));
      } else {
        markConversationStopped(conversationId, false);
      }
      await Promise.all([
        fetchDetailedConversation(conversationId),
        fetchConversations(undefined, { silent: true }),
      ]);
      try {
        setSubflowRecoveryOptions(await chatService.getSubflowRecoveryOptions(conversationId));
      } catch {
        setSubflowRecoveryOptions(null);
      }
    } catch (err) {
      log.error('Subflow recovery failed', { conversationId, scope, err });
      setError(err instanceof Error ? err.message : t('chat.page.recoveryFailed'));
    } finally {
      setSubflowRecoveryScope(null);
    }
  };

  // Close the debugger = DETACH, not cancel.
  //
  // Closing used to call handleCancelRequest(), which killed the run: the panel
  // is the only UI that can resume a 'paused_debug' conversation, so dismissing
  // it while paused would have left the run parked forever with no way back.
  // Detaching resolves that properly instead: clear the breakpoints, then let
  // the run finish on its own (debug/continue) while the chat view takes over
  // the live progress. An idle/armed panel just closes; the explicit Stop
  // button in the debugger (and the live indicator) still cancels a run.
  const handleDebugClose = useCallback(async () => {
    const conversationId = currentConversationId;
    const wasPaused = isDebugPaused;
    log.info('Closing debugger panel (detach)', { conversationId, wasPaused });
    setDebuggerRequested(false);
    setDebugAttaching(false);
    setExecuteInDebugger(false);
    setIsDebugPaused(false);
    setDebugState(null);
    setDebugSessionActive(false);
    if (!conversationId) return;
    try {
      // Disarm every breakpoint so the resumed run does not stop again with
      // nobody watching (also drops a still-pending attach sentinel).
      await chatService.setBreakpoints(conversationId, []);
      setBreakpoints([]);
    } catch (err) {
      log.error('Failed to clear breakpoints while detaching', { conversationId, err });
    }
    if (!wasPaused) return; // nothing parked — the run (if any) keeps going
    // Resume the parked run in the background and keep tracking it in the
    // normal chat live view.
    setIsLoading(true);
    setLoadingConversationId(conversationId);
    markConvRunning(conversationId, true);
    patchConversationStatus(conversationId, 'running');
    await openEventStream(conversationId);
    try {
      const data = await chatService.debugContinue(conversationId);
      handleApiResponse(data, conversationId);
    } catch (err) {
      log.error('Failed to resume run while detaching the debugger', { conversationId, err });
      setIsLoading(false);
      markConvRunning(conversationId, false);
      setError(err instanceof Error ? err.message : t('chat.page.debugContinueFailed'));
    }
  }, [currentConversationId, isDebugPaused, openEventStream, handleApiResponse, markConvRunning, t]);

  // handleToggleDebugger is declared earlier (it is passed down to the input);
  // route its close branch through the latest handleDebugClose.
  useEffect(() => {
    handleDebugCloseRef.current = handleDebugClose;
  }, [handleDebugClose]);

  // Attach hydration: a pause can arrive as an SSE event (breakpoint:hit /
  // run:paused) for a run whose POST this tab does not own — a background run,
  // another tab's run, or one resumed after a reload. In that case no
  // debugState ever lands in state and the panel would spin forever, so pull it
  // from the server once the conversation reports it is parked.
  useEffect(() => {
    if (!currentConversationId) return;
    if (!debuggerRequested && !debugSessionActive) return;
    if (debugState) return;
    const parked =
      isDebugPaused || currentConversationSummary?.status === 'paused_debug';
    if (!parked) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await chatService.getDebugState(currentConversationId);
        if (cancelled || !data?.debugState) return;
        setDebugState(data.debugState as SharedState);
        setDebugSessionActive(true);
        setIsDebugPaused(true);
        setDebugAttaching(false);
        setBreakpoints(data.breakpoints ?? []);
      } catch (err) {
        log.error('Failed to hydrate debug state', { conversationId: currentConversationId, err });
      }
    })();
    return () => { cancelled = true; };
  }, [
    currentConversationId,
    debuggerRequested,
    debugSessionActive,
    debugState,
    isDebugPaused,
    currentConversationSummary?.status,
  ]);

  // --- Add logging for Edit button prop ---
  log.debug('Rendering Chat component', {
    currentConversationId,
    isHandleEditMessageDefined: typeof handleEditMessage === 'function'
  });
  // --- End logging ---

  // The debugger panel stays open for the whole debug session (not just while
  // paused), so it doesn't flicker shut while a step/continue is executing.
  // It ALSO opens the instant the user presses the Debugger button — before any
  // debugState exists (debuggerRequested) — and shows the pending panel until
  // the first pause hands it a state to render.
  const debugPanelOpen =
    (debuggerRequested || debugSessionActive || isDebugPaused) && !!currentConversationId;
  // While the panel is open but has no debugState yet (`!debugState`), the
  // pending panel is rendered instead of the canvas — armed for the next run, or
  // spinning while an attach lands.
  const debugPendingMode: 'armed' | 'attaching' = debugAttaching ? 'attaching' : 'armed';
  /** The Debugger button is "on" whenever the panel is showing in any form. */
  const debuggerOpen = debugPanelOpen;

  // The viewed conversation counts as running when THIS client started or
  // re-attached to the run (isLoading/loadingConversationId/runningConvs) OR
  // when the server says so (sidebar status — kept fresh by lifecycle events,
  // the fallback refresh, and detail fetches). The status fallback keeps the live
  // indicator + Stop button visible for runs this client didn't start or lost
  // track of (page remount, failed re-attach) — previously the button simply
  // vanished for those, leaving no way to stop the run. The backend list route
  // self-heals a stale 'running' (dead process) to 'error', so this can't
  // stick forever.
  // A parked run (awaiting approval / paused in the debugger) has its own UI —
  // the indicator must not sit next to the approval prompt with a spinner.
  // But the run is still alive while parked at an approval prompt, so Stop
  // must stay reachable: that case renders the indicator in its spinner-less
  // awaitingApproval variant instead of vanishing entirely. (paused_debug
  // keeps its own Cancel in the debugger panel.)
  const viewedConversationAwaitingApproval =
    currentConversationSummary?.status === 'awaiting_tool_approval' ||
    !!pendingToolCalls;
  const viewedConversationParked =
    viewedConversationAwaitingApproval ||
    currentConversationSummary?.status === 'paused_debug';
  const viewedConversationRunning =
    !viewedConversationParked &&
    ((isLoading && loadingConversationId === currentConversationId) ||
      (!!currentConversationId && runningConvs.has(currentConversationId)) ||
      currentConversationSummary?.status === 'running');

  // The viewed conversation was just Stopped by the user (this session). Its
  // server status is 'error' with the cancellation message, but we present it
  // as a neutral "stopped" state rather than a failure. Client-local: on reload
  // a stopped run reads as a plain error (no dedicated 'cancelled' status).
  const viewedConversationStopped =
    !viewedConversationRunning &&
    !!currentConversationId &&
    stoppedConversationIds.has(currentConversationId);
  // Drain the queued messages of the VIEWED conversation once it becomes idle
  // and unblocked (issue #177). FIFO, one run at a time: pop the head and push
  // it through the normal send path. Never drains while a run is in flight,
  // awaiting tool approval, paused in the debugger, ended in error, or was just
  // stopped by the user. `drainingRef` guards against re-entrancy so a single
  // idle window sends exactly one queued message; the next drains after that
  // run's run:done flips runningConvs back off.
  useEffect(() => {
    const convId = currentConversationId;
    if (!convId || drainingRef.current) return;
    // Sending relies on detailedConversation being the viewed conversation.
    if (!detailedConversation || detailedConversation.id !== convId) return;
    const head = peekMsgQueue(queuedMessages, convId);
    if (!head) return;
    const eligible = canDrainQueue({
      running: runningConvs.has(convId),
      pendingApproval: !!pendingToolCalls,
      debugPaused: isDebugPaused,
      hasError: currentConversationSummary?.status === 'error',
      stopped: viewedConversationStopped,
    });
    if (!eligible) return;
    drainingRef.current = true;
    // Non-lossy drain (#221): peek the head first; only remove it from the queue
    // AFTER the send has committed the optimistic bubble. On failure, re-enqueue
    // at the front so the message is retried and never silently dropped.
    const capturedHead = head; // close over the identity
    const timer = setTimeout(async () => {
      try {
        // Dequeue by id (not position) just before we send, so the pending
        // bubble disappears from the "synthetic" layer and gets promoted to a
        // real optimistic bubble inside handleSendMessage.
        setQueuedMessages(prev => removeQueuedMsg(prev, convId, capturedHead.id));
        await handleSendMessage(capturedHead.content, capturedHead.attachments, {
          fromQueue: true,
          nodeOverride: capturedHead.nodeOverride,
          queuedId: capturedHead.id,
        });
      } catch {
        // Send failed — put it back at the front so it is the next to drain.
        setQueuedMessages(prev => requeueFrontMsg(prev, convId, capturedHead));
      } finally {
        drainingRef.current = false;
      }
    }, 0);
    return () => clearTimeout(timer);
    // handleSendMessage is intentionally omitted (stable behavior; including it
    // would re-run this effect every render on its fresh identity).
  }, [
    currentConversationId,
    detailedConversation,
    queuedMessages,
    runningConvs,
    pendingToolCalls,
    isDebugPaused,
    currentConversationSummary?.status,
    viewedConversationStopped,
  ]);

  // ChatHistory is memoized because this parent updates for every streamed chat
  // event. These wrappers keep its action props stable while always invoking
  // the latest implementation/closure.
  const sidebarDeleteConversation = useStableCallback(deleteConversation);
  const sidebarBulkDeleteConversations = useStableCallback(bulkDeleteConversations);
  const sidebarStopConversation = useStableCallback(handleStopConversation);
  const sidebarCreateNewConversation = useStableCallback(createNewConversation);
  const sidebarOpenQuickChat = useCallback(() => setQuickChatOpen(true), []);

  const translateQueueHoldReason = (reason: string | null): string | null => {
    switch (reason) {
      case 'Held — you stopped this run. Send again to continue.': return t('chat.page.queueStopped');
      case 'Held — the last run failed. Retry or send again to continue.': return t('chat.page.queueFailed');
      case 'Held — waiting for tool approval.': return t('chat.page.queueApproval');
      case 'Held — paused in the debugger.': return t('chat.page.queueDebugger');
      default: return reason;
    }
  };

  const subflowRecoveryActions = subflowRecoveryOptions ? (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <Button
        color="inherit"
        size="small"
        startIcon={subflowRecoveryScope === 'branch' ? <CircularProgress color="inherit" size={14} /> : <RefreshIcon />}
        disabled={!!subflowRecoveryScope || !subflowRecoveryOptions.canRetryBranch}
        onClick={() => void handleSubflowRecovery('branch')}
      >
        {t('chat.page.recoverBranch')}
      </Button>
      {subflowRecoveryOptions.canRetrySiblings && (
        <Button
          color="inherit"
          size="small"
          startIcon={subflowRecoveryScope === 'siblings' ? <CircularProgress color="inherit" size={14} /> : <AccountTreeOutlinedIcon />}
          disabled={!!subflowRecoveryScope}
          onClick={() => void handleSubflowRecovery('siblings')}
        >
          {t('chat.page.recoverLevel', { count: subflowRecoveryOptions.incompleteSiblingCount })}
        </Button>
      )}
      {subflowRecoveryOptions.canRetryDeepest && subflowRecoveryOptions.deepestFailedCount > 1 && (
        <Button
          color="inherit"
          size="small"
          startIcon={subflowRecoveryScope === 'deepest' ? <CircularProgress color="inherit" size={14} /> : <AccountTreeIcon />}
          disabled={!!subflowRecoveryScope}
          onClick={() => void handleSubflowRecovery('deepest')}
        >
          {t('chat.page.recoverLeaves', { count: subflowRecoveryOptions.deepestFailedCount })}
        </Button>
      )}
    </Box>
  ) : null;

  const sidebarPanelContent = isLoadingHistory ? (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 2 }}>
      <Spinner size="medium" color="primary" />
    </Box>
  ) : historyError ? (
    <Alert severity="error" sx={{ m: 2 }}>{historyError}</Alert>
  ) : (
    <ChatHistory
      conversations={conversationList}
      totalConversations={conversationPagination.total + localOnlyConversationIdsRef.current.size}
      hasMoreConversations={conversationPagination.hasMore}
      isLoadingMore={isLoadingMoreHistory}
      onLoadMore={loadMoreConversations}
      onLoadAll={loadAllConversations}
      flowNames={flowNames}
      currentConversationId={currentConversationId}
      revealRequest={sidebarRevealRequest}
      onSelectConversation={selectSidebarConversation}
      onDeleteConversation={sidebarDeleteConversation}
      onBulkDelete={sidebarBulkDeleteConversations}
      onStopConversation={sidebarStopConversation}
      onNewConversation={sidebarCreateNewConversation}
      onQuickChat={sidebarOpenQuickChat}
      onCollapse={toggleSidebarCollapsed}
      collapsed={effectiveSidebarCollapsed}
    />
  );

  return (
    <Box
      sx={{
        display: 'flex',
        height: `calc(
          100dvh
          - var(--app-bar-height)
          - var(--active-subnav-height)
          - var(--global-mcp-dock-top)
          - var(--global-mcp-dock-bottom)
        )`,
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
        bgcolor: 'transparent',
      }}
    >
      <Typography component="h1" className="sr-only">{t('chat.title')}</Typography>

      {/* Collapsed state: a slim always-visible affordance to bring the sidebar
          back (so the conversation list is never permanently lost). */}
      {effectiveSidebarCollapsed && !isPhoneLayout && (
        <Box
          sx={{
            width: 40,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            pt: 1.4,
            bgcolor: 'var(--surface-glass)',
            backdropFilter: 'blur(18px)',
          }}
        >
          <Tooltip title={t('chat.page.showSidebar')}>
            <IconButton size="small" onClick={toggleSidebarCollapsed} aria-label={t('chat.page.showSidebar')}>
              <ViewSidebarIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      )}

      {/* Compact layouts use a temporary drawer so focus, Escape, backdrop,
          and restoration behavior remain accessible without crushing chat. */}
      {isCompactLayout && (
        <Drawer
          anchor="left"
          open={mobileSidebarOpen}
          onClose={() => setMobileSidebarOpen(false)}
          ModalProps={{ keepMounted: true }}
          PaperProps={{
            sx: {
              width: 'min(86vw, 340px)',
              maxWidth: 'calc(100vw - 28px)',
              display: 'flex',
              flexDirection: 'column',
              bgcolor: 'var(--surface-glass)',
              backgroundImage: 'none',
              backdropFilter: 'blur(22px) saturate(140%)',
              boxShadow: '24px 0 70px rgba(0,0,0,.45)',
            },
          }}
        >
          {sidebarPanelContent}
        </Drawer>
      )}

      {/* Desktop conversation history remains resizable and collapsible. */}
      {!isCompactLayout && !sidebarCollapsed && (
        <Box
          sx={{
            width: sidebarWidth,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'var(--surface-glass)',
            backdropFilter: 'blur(18px) saturate(135%)',
          }}
        >
          {sidebarPanelContent}
        </Box>
      )}

      {/* Draggable divider: resizes the sidebar. Hidden when collapsed. */}
      {!isCompactLayout && !sidebarCollapsed && (
        <Box
          onPointerDown={startSidebarResize}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setSidebarWidth(width => {
              const next = Math.min(560, Math.max(220, width + (event.key === 'ArrowRight' ? 16 : -16)));
              window.localStorage.setItem('flujo-chat-sidebar-width', String(next));
              return next;
            });
          }}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={560}
          aria-valuenow={Math.round(sidebarWidth)}
          sx={{
            position: 'relative',
            width: '8px',
            flexShrink: 0,
            cursor: 'col-resize',
            bgcolor: 'transparent',
            transition: 'background-color 120ms',
            '&::after': {
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: '50%',
              width: 1,
              content: '""',
              bgcolor: 'divider',
              transition: 'width 120ms, background-color 120ms',
            },
            '&:hover::after': { width: 2, bgcolor: 'primary.main' },
            '&:focus-visible::after': { width: 3, bgcolor: 'primary.main' },
            touchAction: 'none',
          }}
          aria-label={t('chat.page.resizeSidebar')}
        />
      )}

      {/* Main Content Area (Chat or Chat + Debugger). Flex, not Grid: the
          debugger panel has a user-resizable pixel width (drag the divider). */}
      <Box sx={{ flex: 1, height: '100%', display: 'flex', minWidth: 0, minHeight: 0 }}>
        {/* Chat Area */}
        <Box sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          position: 'relative',
          boxSizing: 'border-box',
          pl: canvasDockLayout.placement === 'left' && canvasDockLayout.reservedWidth > 0
            ? `min(${canvasDockLayout.reservedWidth}px, calc(100% - 320px))`
            : 0,
          pr: canvasDockLayout.placement === 'right' && canvasDockLayout.reservedWidth > 0
            ? `min(${canvasDockLayout.reservedWidth}px, calc(100% - 320px))`
            : 0,
          pt: canvasDockLayout.placement === 'top' && canvasDockLayout.reservedHeight > 0
            ? `min(${canvasDockLayout.reservedHeight}px, calc(100% - 240px))`
            : 0,
        }}>
          {/* Conversation title header + inline rename (issue #134, item 2).
              Shown once a conversation is selected. Click the pencil (or the
              title) to edit; Enter/blur saves, Escape cancels. */}
          {currentConversationId && (
            <Box
              sx={{
                px: { xs: 1, sm: 1.5, md: 2 },
                py: { xs: 0.5, sm: 0.75 },
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                minWidth: 0,
                borderBottom: 1,
                borderColor: 'divider',
                bgcolor: 'var(--surface-glass)',
                backdropFilter: 'blur(16px)',
              }}
            >
              {isPhoneLayout && (
                <Tooltip title={t('chat.page.showSidebar')}>
                  <IconButton size="small" onClick={toggleSidebarCollapsed} aria-label={t('chat.page.showSidebar')}>
                    <ViewSidebarIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {isEditingTitle ? (
                <TextField
                  data-ask-flujo-chat-title
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitEditTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitEditTitle(); }
                    else if (e.key === 'Escape') { setIsEditingTitle(false); }
                  }}
                  size="small"
                  autoFocus
                  fullWidth
                  inputProps={{ maxLength: 200, 'aria-label': t('chat.page.conversationTitle') }}
                />
              ) : (
                <>
                  <Typography
                    data-ask-flujo-chat-title
                    variant="subtitle1"
                    noWrap
                    onClick={beginEditTitle}
                    title={detailedConversation?.title || currentConversationSummary?.title || ''}
                    sx={{ flex: 1, minWidth: 0, cursor: 'text' }}
                  >
                    {detailedConversation?.title || currentConversationSummary?.title || t('chat.page.untitled')}
                  </Typography>
                  <Tooltip title={t('chat.page.rename')}>
                    <IconButton size="small" onClick={beginEditTitle} aria-label={t('chat.page.rename')}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {/* Toggle the Executed-Steps path panel (issue #213). */}
                  <Tooltip title={workflowPanelVisible ? t('chat.page.hideExecuted') : t('chat.page.showExecuted')}>
                    <IconButton
                      size="small"
                      color={workflowPanelVisible ? 'primary' : 'default'}
                      onClick={() => setWorkflowPanelVisible(v => !v)}
                      aria-label={t('chat.page.toggleExecuted')}
                    >
                      <AccountTreeOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </>
              )}
            </Box>
          )}

          {/* Flow selector - Use summary data. Only shown once a conversation is
              selected; with no conversation it's confusing (nothing to assign a
              flow to). */}
          {currentConversationId && (
            <Box
              sx={{
                px: { xs: 1, sm: 1.5, md: 2 },
                py: { xs: 0.5, sm: 0.75 },
                borderBottom: 1,
                borderColor: 'divider',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                bgcolor: 'var(--surface-glass)',
                backdropFilter: 'blur(16px)',
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {isQuickChatFlowId(currentConversationSummary?.flowId || detailedConversation?.flowId) ? (
                  // Quick chats have no stored flow to select — the flow lives on
                  // the conversation as a snapshot. Show a badge instead of the
                  // flow dropdown (which would render blank).
                  <Chip color="primary" variant="outlined" icon={<BoltIcon />} label={t('chat.page.quickChat')} />
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <FlowSelector
                      // Remove duplicate selectedFlowId prop
                      selectedFlowId={currentConversationSummary?.flowId || detailedConversation?.flowId || null} // Use summary first, fallback to detail
                      onSelectFlow={handleFlowSelect}
                      disabled={isDebugPaused} // Disable flow selection when debugging
                      hideLabel
                      compact
                      fullScreenPicker={isPhoneLayout}
                    />
                    {/* Keep the FlowBuilder shortcut beside the picker instead
                        of at the far edge of the flexible header row. */}
                    {(() => {
                      const builderFlowId =
                        currentConversationSummary?.flowId || detailedConversation?.flowId || null;
                      if (!builderFlowId) return null;
                      return (
                        <Tooltip title={t('chat.page.openAgent')}>
                          <IconButton
                            size="small"
                            color="primary"
                            onClick={() => router.push(`/flows?flow=${encodeURIComponent(builderFlowId)}`)}
                          >
                            <AccountTreeIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      );
                    })()}
                  </Box>
                )}
              </Box>
              {/* Token totals + context meter (persisted usage; refreshed with the conversation) */}
              <ConversationStats
                usage={detailedConversation?.usage}
                contextInfo={detailedConversation?.contextInfo}
                availableNodes={availableNodes}
                compact={isPhoneLayout}
              />
            </Box>
          )}

        {/* Chat messages - Use detailed data. The wrapper is position:relative and
            does NOT scroll, so the "jump to latest" FAB stays pinned over the
            visible area while the inner Box (the scroll container) scrolls. */}
        <Box sx={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <Box
          {...chatScrollNav.containerProps}
          sx={{
            flex: 1,
            overflow: 'auto',
            px: { xs: 1.5, sm: 2.5, lg: 4 },
            py: { xs: 1.25, sm: 2.5 },
            '& > *': {
              width: '100%',
              maxWidth: { xs: 960, lg: 'none' },
              mx: 'auto',
            },
          }}
        >
          {isLoadingDetails ? (
             <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
               <Spinner size="medium" color="primary" />
             </Box>
          ) : detailsError ? (
             <Alert severity="error" sx={{ m: 2 }}>{detailsError}</Alert>
          ) : detailedConversation ? (
            <>
              <ChatMessages
                messages={detailedConversation.messages} // Pass messages from detailed state
                pendingToolCalls={pendingToolCalls}
                pendingElicitation={pendingElicitation}
                availableNodes={availableNodes} // Memoized nodes for the attribution pill
                conversationId={detailedConversation.id} // Resets the render window on switch
                editingMessageId={editingMessage?.messageId ?? null} // Bubble being edited (in the input)
                onToggleDisabled={toggleMessageDisabled}
                onSplitConversation={splitConversationAtMessage}
                onSplitConversationFromHere={splitConversationFromMessage}
                onRevertToHere={() => fetchDetailedConversation(detailedConversation.id)}
                onBeginEditMessage={beginEditMessage} // "Edit" opens the input editor
                onApproveToolCall={handleApproveToolCall}
                onRejectToolCall={handleRejectToolCall}
                onCancelToolCall={handleCancelToolCall}
                onSubmitElicitation={handleSubmitElicitation}
                onCancelElicitation={handleCancelElicitation}
                pendingQuestion={pendingQuestion}
                onAnswerQuestion={handleAnswerQuestion}
                onDeclineQuestion={handleDeclineQuestion}
                onAppMessage={handleAppMessage}
                onUpdateModelContext={handleAppModelContext}
                onRegisterAppTeardown={handleRegisterInlineTeardown}
                onOpenInCanvas={handleOpenInCanvas}
                autoOpenMcpApps={autoOpenMcpApps}
                autoOpenMcpAppResultIds={autoOpenMcpAppResultIds}
                dismissedMcpAppKeys={dismissedMcpAppKeys}
                autoOpenSuppressed={autoOpenMcpAppsSuppressed}
                onMcpAppManualOpen={handleMcpAppManualOpen}
                anchorMessageId={anchorMessageId} // #374: `?message=<id>` magic link target
                queuedMessages={getMsgQueue(queuedMessages, detailedConversation.id)}
                queueHoldReason={translateQueueHoldReason(drainHoldReason({
                  running: runningConvs.has(detailedConversation.id),
                  pendingApproval: !!pendingToolCalls,
                  debugPaused: isDebugPaused,
                  hasError: currentConversationSummary?.status === 'error',
                  stopped: viewedConversationStopped,
                }))}
              />

              {/* Completion banner: shown once the run has reached a Finish node
                  (status 'completed'). Driven by the same status the sidebar dot
                  uses. Hidden while a run is active or paused for debug so it
                  never competes with the live indicator / debugger. Also hidden
                  for an empty conversation (nothing ran, nothing "completed"). */}
              {!isLoading && !isDebugPaused && detailedConversation.messages.length > 0 && currentConversationSummary?.status === 'completed' && (
                <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
                  <Alert
                    icon={<CheckCircleIcon fontSize="inherit" />}
                    severity="success"
                    variant="filled"
                    sx={{ borderRadius: 2, py: 0.5 }}
                  >
                    {t('chat.page.completed')}
                  </Alert>
                </Box>
              )}

              {/* Stopped banner: the user pressed Stop. The run ends server-side
                  as an error (cancellation), but that is not a failure to the
                  user, so present it neutrally with a Retry (re-runs from the
                  last node). Only for this session's Stop (see
                  viewedConversationStopped). */}
              {!isLoading && !isDebugPaused && viewedConversationStopped && (
                <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
                  <Alert
                    icon={<StopCircleIcon fontSize="inherit" />}
                    severity="info"
                    variant="outlined"
                    sx={{ borderRadius: 2, py: 0.5, alignItems: 'center' }}
                    action={subflowRecoveryActions ?? (
                      <Button
                        color="inherit"
                        size="small"
                        startIcon={<RefreshIcon />}
                        onClick={() => sendToChatCompletions(detailedConversation)}
                      >
                        {t('chat.page.resume')}
                      </Button>
                    )}
                  >
                    {t('chat.page.stopped')}
                  </Alert>
                </Box>
              )}

              {/* Durable recovery status (issue #355). Unknown tool effects are
                  never presented as a safe node retry; the conservative action
                  remains the existing restart-from-turn-entry path. */}
              {!isLoading && !isDebugPaused && !viewedConversationStopped && detailedConversation?.recovery &&
                (detailedConversation.recovery.classification === 'interrupted' || detailedConversation.recovery.manualActionRequired) && (
                <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
                  <Alert
                    icon={<ErrorOutlineIcon fontSize="inherit" />}
                    severity="warning"
                    variant="filled"
                    sx={{ borderRadius: 2, py: 0.5, alignItems: 'center', maxWidth: 760 }}
                    action={
                      <Button
                        color="inherit"
                        size="small"
                        startIcon={<RefreshIcon />}
                        onClick={() => sendToChatCompletions(detailedConversation)}
                      >
                        {t('chat.page.restartTurn')}
                      </Button>
                    }
                  >
                    <Typography variant="body2" fontWeight={600}>
                      {detailedConversation.recovery.currentCheckpoint?.nodeId
                        ? t('chat.page.recoveryAtNode', { node: detailedConversation.recovery.currentCheckpoint.nodeId })
                        : t('chat.page.recovery')}
                    </Typography>
                    {detailedConversation.recovery.sideEffectWarning && (
                      <Typography variant="caption" component="div">
                        {detailedConversation.recovery.sideEffectWarning}
                      </Typography>
                    )}
                  </Alert>
                </Box>
              )}

              {/* Error banner: the run ended in an error state. Guarded by !error
                  so it doesn't duplicate the transient error Alert shown right
                  after a live failure; this one persists across reloads. Not shown
                  for a user Stop (viewedConversationStopped owns that case). */}
              {!isLoading && !isDebugPaused && !error && !viewedConversationStopped &&
                detailedConversation?.recovery?.classification !== 'interrupted' &&
                !detailedConversation?.recovery?.manualActionRequired &&
                currentConversationSummary?.status === 'error' && (
                <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
                  <Alert
                    icon={<ErrorOutlineIcon fontSize="inherit" />}
                    severity="error"
                    variant="filled"
                    sx={{ borderRadius: 2, py: 0.5, alignItems: 'center' }}
                    action={subflowRecoveryActions ?? (
                      <Button
                        color="inherit"
                        size="small"
                        startIcon={<RefreshIcon />}
                        onClick={() => {
                          // Re-run the flow with the conversation as-is; the
                          // backend resumes from the last message's node.
                          sendToChatCompletions(detailedConversation);
                        }}
                      >
                        {t('chat.page.retry')}
                      </Button>
                    )}
                  >
                    <ChatErrorDetails
                      error={detailedConversation?.lastError ?? errorInfo}
                      fallbackMessage={t('chat.page.endedError')}
                    />
                  </Alert>
                </Box>
              )}

              {/* Live execution indicator (progress, active node, tokens, stop).
                  Shown whenever the VIEWED conversation is running — including
                  runs this client didn't start (see viewedConversationRunning) —
                  but never for background runs in other conversations, and never
                  while the debugger owns the pause UI. Owns its own 1s tick so
                  the rest of the tree doesn't re-render. */}
              {/* Todo dock (issue #259): a live checklist maintained by the
                  model's `todo` tool. Shown while the viewed conversation is
                  running and has any tasks. */}
              {viewedConversationRunning && currentTodos.length > 0 && (
                <TodoDock todos={currentTodos} />
              )}

              {viewedConversationRunning && !isDebugPaused && !isPhoneLayout && (
                <LiveRunIndicator
                  liveStats={liveStats}
                  lanes={liveLanes}
                  onOpenLane={setCurrentConversationId}
                  onStop={handleCancelRequest}
                  stopDisabled={!currentConversationId}
                  // #400: only the conversation on screen may paint a countdown.
                  retryWait={retryWait && retryWait.conversationId === currentConversationId ? retryWait : null}
                />
              )}

              {/* Parked at a tool-approval prompt: the run is still alive (and
                  for agentic adapters, blocked mid-request), so keep Stop
                  reachable next to the Approve/Reject prompt — spinner-less so
                  it doesn't suggest activity while waiting on the user. */}
              {!viewedConversationRunning && viewedConversationAwaitingApproval && !isDebugPaused && !isPhoneLayout && (
                <LiveRunIndicator
                  liveStats={liveStats}
                  lanes={liveLanes}
                  onOpenLane={setCurrentConversationId}
                  awaitingApproval
                  onStop={handleCancelRequest}
                  stopDisabled={!currentConversationId}
                />
              )}

              {/* Error Display */}
              {error && (
                <Alert
                  severity="error"
                  sx={{ mt: 2 }}
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      startIcon={<RefreshIcon />}
                      onClick={() => {
                        if (detailedConversation) { // Retry requires detailed conversation
                          sendToChatCompletions(detailedConversation);
                        }
                      }}
                    >
                      {t('chat.page.retry')}
                    </Button>
                  }
                >
                  <ChatErrorDetails error={errorInfo} fallbackMessage={error} compact />
                </Alert>
              )}
            </>
          ) : isPhoneLayout ? (
            <Box
              sx={{
                minHeight: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1.5,
                px: 2,
                textAlign: 'center',
              }}
            >
              <Typography variant="body1" color="text.secondary">
                {conversationList.length > 0
                  ? t('chat.page.selectOrCreate')
                  : t('chat.page.createToStart')}
              </Typography>
              <Button
                variant="contained"
                size="large"
                startIcon={<AddCommentOutlinedIcon />}
                onClick={() => createNewConversation()}
                disabled={flows.length === 0}
                sx={{ minHeight: 48, borderRadius: 999, px: 2.5 }}
              >
                {t('chat.page.newTitle')}
              </Button>
              {conversationList.length > 0 && (
                <Button
                  variant="text"
                  startIcon={<ViewSidebarIcon />}
                  onClick={toggleSidebarCollapsed}
                >
                  {t('chat.page.showSidebar')}
                </Button>
              )}
            </Box>
          ) : (
            // Message when no conversation is selected or loaded
            <Typography variant="body1" color="textSecondary" align="center" sx={{ mt: 4 }}>
              {conversationList.length > 0
                ? t('chat.page.selectOrCreate')
                : t('chat.page.createToStart')}
            </Typography>
          )}
        </Box>
        <ScrollNavCluster
          show={chatScrollNav.show}
          actions={chatScrollNav.actions}
          disabled={chatScrollNav.disabled}
          onAction={chatScrollNav.onAction}
          positionMode="absolute"
          labels={{
            top: t('chat.page.scrollTop'),
            up: t('chat.page.scrollLastMessage'),
            bottom: t('chat.page.scrollLatest'),
          }}
          sx={{ bottom: 16, right: 24, zIndex: 2 }}
        />
        </Box>

        {/* #216: docked, tabbed MCP Apps canvas surface. Pinned above the input,
            hidden entirely when no app is docked. Hosts are mounted once and
            shown/hidden via CSS (never reparented). */}
        {currentConversationId && <DevCanvasDock
          key={currentConversationId}
          conversationId={currentConversationId}
          entries={canvasStateOwnerId === currentConversationId
            ? canvasEntries(canvasState)
            : []}
          activeKey={canvasState.activeKey}
          onSelectTab={handleSelectCanvasTab}
          onCloseTab={handleCloseCanvasTab}
          onAppMessage={handleAppMessage}
          onUpdateModelContext={handleAppModelContext}
          onRegisterTeardown={handleRegisterCanvasTeardown}
          onLayoutChange={handleCanvasLayoutChange}
          onCollapseChange={handleCanvasCollapseChange}
          onCloseAll={handleCloseAllCanvas}
        />}

        {/* On phones the live run becomes an opaque dock instead of a block in
            the scrolling transcript, so messages never show through it. */}
        {isPhoneLayout && viewedConversationRunning && !isDebugPaused && (
          <LiveRunIndicator
            compact
            liveStats={liveStats}
            lanes={liveLanes}
            onOpenLane={setCurrentConversationId}
            onStop={handleCancelRequest}
            stopDisabled={!currentConversationId}
            // #400: only the conversation on screen may paint a countdown.
            retryWait={retryWait && retryWait.conversationId === currentConversationId ? retryWait : null}
          />
        )}
        {isPhoneLayout && !viewedConversationRunning && viewedConversationAwaitingApproval && !isDebugPaused && (
          <LiveRunIndicator
            compact
            liveStats={liveStats}
            lanes={liveLanes}
            onOpenLane={setCurrentConversationId}
            awaitingApproval
            onStop={handleCancelRequest}
            stopDisabled={!currentConversationId}
          />
        )}

        {/* Chat input */}
        {(!isPhoneLayout || !!currentConversationId) && <Box
          sx={{
            p: 0,
            borderTop: 1,
            borderColor: 'divider',
            background: 'linear-gradient(to top, var(--background) 35%, transparent)',
          }}
        >
          {/* Queued messages (issue #177): follow-ups submitted while a run is in
              flight. Shown as removable chips; auto-sent one at a time once the
              conversation is idle. */}
          {currentConversationId && getMsgQueue(queuedMessages, currentConversationId).length > 0 && (
            <Box
              data-testid="queued-messages"
              sx={{ mb: 1, display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <ScheduleIcon fontSize="inherit" /> {t('chat.page.queued')}
              </Typography>
              {getMsgQueue(queuedMessages, currentConversationId).map((q) => (
                <Chip
                  key={q.id}
                  size="small"
                  variant="outlined"
                  label={q.content.trim().slice(0, 40) || (q.attachments.length ? tp('chat.messages.attachment', q.attachments.length) : t('chat.page.queuedMessage'))}
                  onDelete={() => setQueuedMessages(prev => removeQueuedMsg(prev, currentConversationId, q.id))}
                />
              ))}
            </Box>
          )}

          <ChatInput
            onSendMessage={handleSendMessage}
            // Keep the input enabled while a run is in flight so the user can type and
            // QUEUE follow-up messages (issue #177); still disabled for load, missing
            // flow, a pending tool approval, or a debugger pause.
            disabled={isLoadingDetails || !(detailedConversation?.flowId || currentConversationSummary?.flowId) || !!pendingToolCalls || isDebugPaused}
            requireApproval={requireApproval}
            onRequireApprovalChange={handleRequireApprovalChange}
            // ONE Debugger control (issue: two overlapping controls). The old
            // "run in debugger" checkbox + the live indicator's "attach
            // debugger" floater are now this single toggle: it opens the panel
            // immediately and either arms the next run or attaches to the one
            // already in flight.
            debuggerOpen={debuggerOpen}
            onToggleDebugger={handleToggleDebugger}
            // Node picker: shows where the next message resumes; a manual pick
            // overrides it for one send (null = back to automatic).
            availableNodes={availableNodes}
            flow={currentFlow}
            currentNodeId={currentNodeId}
            nodeOverrideActive={!!nodeOverride}
            onSelectNode={setNodeOverride}
            // Message editing happens here in the input, not inline in the bubble.
            editing={editingMessage}
            onEditingContentChange={handleEditingContentChange}
            onEditingNodeChange={handleEditingNodeChange}
            onSaveEdit={handleSaveEditingMessage}
            onCancelEdit={handleCancelEditingMessage}
          />
        </Box>}
        </Box> {/* End Chat Area */}

        {/* Executed-Steps panel (issue #213): a hideable, resizable side panel
            that renders the current conversation's flow and highlights the
            executed path. Independent of the debugger — works for normal,
            non-debug chats. */}
        {workflowPanelVisible && currentConversationId && !isCompactLayout && (
          <>
            {/* Draggable divider: resizes the executed-steps panel. */}
            <Box
              onPointerDown={startWorkflowResize}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                setWorkflowPanelWidth(width => {
                  const max = Math.max(240, Math.round(window.innerWidth * 0.7));
                  const next = Math.min(max, Math.max(240, width + (event.key === 'ArrowRight' ? -16 : 16)));
                  window.localStorage.setItem('flujo-workflow-panel-width', String(next));
                  return next;
                });
              }}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-valuemin={240}
              aria-valuemax={Math.max(240, Math.round((typeof window === 'undefined' ? 1440 : window.innerWidth) * 0.7))}
              aria-valuenow={Math.min(
                Math.max(240, Math.round((typeof window === 'undefined' ? 1440 : window.innerWidth) * 0.7)),
                Math.round(workflowPanelWidth),
              )}
              sx={{
                width: '6px',
                flexShrink: 0,
                display: { xs: 'none', lg: 'block' },
                cursor: 'col-resize',
                bgcolor: 'divider',
                transition: 'background-color 120ms',
                '&:hover': { bgcolor: 'primary.main' },
                '&:focus-visible': { bgcolor: 'primary.main' },
                touchAction: 'none',
              }}
              aria-label={t('chat.page.resizeExecuted')}
            />
            <Box
              sx={{
                width: { xs: '100%', lg: `${workflowPanelWidth}px` },
                minWidth: { xs: 0, lg: 240 },
                maxWidth: { xs: 'none', lg: '70vw' },
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                position: { xs: 'absolute', lg: 'static' },
                inset: { xs: 0, lg: 'auto' },
                zIndex: { xs: 36, lg: 'auto' },
                bgcolor: 'background.default',
              }}
            >
              <ExecutedFlowPanel
                flowId={detailedConversation?.flowId || currentConversationSummary?.flowId || null}
                flowSnapshot={debugState?.flowSnapshot ?? null}
                executedNodeIds={executedNodeIds}
                liveActivity={liveActivity}
                onClose={() => setWorkflowPanelVisible(false)}
              />
            </Box>
          </>
        )}

        {/* Debugger Area (open for the whole debug session, not only when paused).
            Docked side-panel layout — shown unless the user expanded it into the
            full-screen modal (issue #162). */}
        {debugPanelOpen && currentConversationId && !debuggerExpanded && !isCompactLayout && (
          <>
            {/* Draggable divider: resizes the debugger panel. */}
            <Box
              onPointerDown={startDebuggerResize}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                setDebuggerWidth(width => {
                  const max = Math.max(360, Math.round(window.innerWidth * 0.85));
                  const current = width || Math.round(window.innerWidth * 0.5);
                  const next = Math.min(max, Math.max(360, current + (event.key === 'ArrowRight' ? -16 : 16)));
                  window.localStorage.setItem('flujo-debugger-width', String(next));
                  return next;
                });
              }}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-valuemin={360}
              aria-valuemax={Math.max(360, Math.round((typeof window === 'undefined' ? 1440 : window.innerWidth) * 0.85))}
              aria-valuenow={Math.min(
                Math.max(360, Math.round((typeof window === 'undefined' ? 1440 : window.innerWidth) * 0.85)),
                Math.round(debuggerWidth || (typeof window === 'undefined' ? 720 : window.innerWidth * 0.5)),
              )}
              sx={{
                width: '6px',
                flexShrink: 0,
                display: { xs: 'none', lg: 'block' },
                cursor: 'col-resize',
                bgcolor: 'divider',
                transition: 'background-color 120ms',
                '&:hover': { bgcolor: 'primary.main' },
                '&:focus-visible': { bgcolor: 'primary.main' },
                touchAction: 'none',
              }}
              aria-label={t('chat.page.resizeDebugger')}
            />
            <Box
              sx={{
                width: { xs: '100%', lg: debuggerWidth ? `${debuggerWidth}px` : '50%' },
                minWidth: { xs: 0, lg: 360 },
                maxWidth: { xs: 'none', lg: '85vw' },
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                position: { xs: 'absolute', lg: 'static' },
                inset: { xs: 0, lg: 'auto' },
                zIndex: { xs: 40, lg: 'auto' },
                bgcolor: 'background.default',
              }}
            >
              {debugState ? (
                <DebuggerCanvas
                  debugState={debugState}
                  conversationId={currentConversationId}
                  liveActivity={liveActivity}
                  executionEvents={debuggerEvents}
                  onStep={handleDebugStep}
                  onStepOver={handleStepOver}
                  onContinue={handleDebugContinue}
                  onCancel={handleCancelRequest}
                  isLoading={isLoading}
                  breakpoints={breakpoints}
                  onToggleBreakpoint={handleToggleBreakpoint}
                  onSetBreakpoints={handleSetBreakpoints}
                  onClose={handleDebugClose}
                  isExpanded={debuggerExpanded}
                  onToggleExpand={() => setDebuggerExpanded(v => !v)}
                />
              ) : (
                <DebuggerPendingPanel
                  mode={debugPendingMode}
                  onClose={handleDebugClose}
                  isExpanded={debuggerExpanded}
                  onToggleExpand={() => setDebuggerExpanded(v => !v)}
                />
              )}
            </Box>
          </>
        )}
      </Box> {/* End Main Content */}

      {workflowPanelVisible && currentConversationId && isCompactLayout && !debugPanelOpen && (
        <Dialog
          fullScreen
          open
          onClose={() => setWorkflowPanelVisible(false)}
          aria-label={t('chat.page.executedDialog')}
        >
          <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
            <ExecutedFlowPanel
              flowId={detailedConversation?.flowId || currentConversationSummary?.flowId || null}
              flowSnapshot={debugState?.flowSnapshot ?? null}
              executedNodeIds={executedNodeIds}
              liveActivity={liveActivity}
              onClose={() => setWorkflowPanelVisible(false)}
            />
          </Box>
        </Dialog>
      )}

      {/* Debugger full-screen modal (issue #162): the same DebuggerCanvas, given
          the whole viewport so the 3 sections (Conversation / Execution Tracker
          / Detail) have room. Toggled by the expand button in the debugger
          header; the debug session/state is untouched. */}
      {debugPanelOpen && currentConversationId && (debuggerExpanded || isCompactLayout) && (
        <Dialog
          fullScreen
          open
          onClose={() => {
            if (isCompactLayout) handleDebugClose();
            else setDebuggerExpanded(false);
          }}
          aria-label={t('chat.page.debuggerDialog')}
        >
          <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            {debugState ? (
              <DebuggerCanvas
                debugState={debugState}
                conversationId={currentConversationId}
                liveActivity={liveActivity}
                executionEvents={debuggerEvents}
                onStep={handleDebugStep}
                onStepOver={handleStepOver}
                onContinue={handleDebugContinue}
                onCancel={handleCancelRequest}
                isLoading={isLoading}
                breakpoints={breakpoints}
                onToggleBreakpoint={handleToggleBreakpoint}
                onSetBreakpoints={handleSetBreakpoints}
                onClose={handleDebugClose}
                isExpanded={debuggerExpanded || isCompactLayout}
                onToggleExpand={() => {
                  if (isCompactLayout) handleDebugClose();
                  else setDebuggerExpanded(v => !v);
                }}
              />
            ) : (
              <DebuggerPendingPanel
                mode={debugPendingMode}
                onClose={handleDebugClose}
                isExpanded={debuggerExpanded || isCompactLayout}
                onToggleExpand={() => {
                  if (isCompactLayout) handleDebugClose();
                  else setDebuggerExpanded(v => !v);
                }}
              />
            )}
          </Box>
        </Dialog>
      )}

      {/* Flow-switch confirmation: switching an already-executed conversation
          to another flow restarts execution on that flow's Start node. Cancel
          keeps the current flow (the selector is controlled, so no revert is
          needed — we simply never apply the change). */}
      <Dialog open={!!pendingFlowSwitch} onClose={() => setPendingFlowSwitch(null)}>
        <DialogTitle>{t('chat.page.switchTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('chat.page.switchHelp', {
              agent: flows.find(f => f.id === pendingFlowSwitch)?.name || t('chat.page.selectedAgent'),
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingFlowSwitch(null)}>{t('chat.page.cancel')}</Button>
          <Button
            variant="contained"
            onClick={() => {
              const flowId = pendingFlowSwitch;
              setPendingFlowSwitch(null);
              if (flowId) applyFlowSelect(flowId);
            }}
          >
            {t('chat.page.switch')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Quick Chat setup (issue #61) */}
      <QuickChatDialog
        open={quickChatOpen}
        onClose={() => setQuickChatOpen(false)}
        onStart={startQuickChat}
      />
    </Box>
  );
};

export default Chat;
