"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'; // Added useCallback
import { Box, Paper, Typography, Divider, CircularProgress, Alert, Button, Chip, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, IconButton, Tooltip, Fab, Zoom, TextField } from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import BoltIcon from '@mui/icons-material/Bolt';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import EditIcon from '@mui/icons-material/Edit';
import { useLocalStorage, StorageKey } from '@/utils/storage';
import ChatHistory from './ChatHistory';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import LiveRunIndicator, { LiveRunStats } from './LiveRunIndicator';
import ConversationStats from './ConversationStats';
import FlowSelector from './FlowSelector';
import QuickChatDialog, { QuickChatStartSelection } from './QuickChatDialog';
import DebuggerCanvas from './DebuggerCanvas';
import { isQuickChatFlowId } from '@/utils/shared/quickChat';
import Spinner from '@/frontend/components/shared/Spinner';
import { v4 as uuidv4 } from 'uuid';
import OpenAI, { OpenAIError, APIError } from 'openai'; // Import APIError
import { flowService } from '@/frontend/services/flow';
import { chatService, ChatApiError } from '@/frontend/services/chat';
import { createLogger } from '@/utils/logger';
// Correctly import SharedState here
import { ChatCompletionMetadata, FlujoChatMessage } from '@/shared/types/chat'; // Import the shared types
import type { SharedState } from '@/backend/execution/flow/types'; // Import SharedState type from backend
import type { ExecutionEvent } from '@/shared/types/execution/events'; // Live execution events (SSE)
import {
  LiveActivity,
  EMPTY_LIVE_ACTIVITY,
  pruneLiveActivity,
  resourceActivityKey,
} from '@/utils/shared/liveActivity';
import { Flow, FlowNode } from '@/shared/types/flow'; // Import Flow and FlowNode types
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';

const log = createLogger('frontend/components/Chat/index');

// Define types for our chat data
export interface Attachment {
  id: string;
  type: 'document' | 'audio' | 'image';
  // For document/audio this is text (the contents / transcription). For an
  // image it is a `data:` URL (e.g. `data:image/png;base64,...`) — the form a
  // pasted screenshot is read into.
  content: string;
  originalName?: string;
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
  const docAudio = attachments.filter(a => a.type !== 'image');
  const images = attachments.filter(a => a.type === 'image');
  if (docAudio.length > 0) {
    text += '\n\n' + docAudio.map(a => `[${a.type.toUpperCase()}]: ${a.content}`).join('\n\n');
  }
  if (images.length === 0) {
    return text;
  }
  const parts: OpenAI.ChatCompletionContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.content } });
  }
  return parts;
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
  status?: 'running' | 'awaiting_tool_approval' | 'paused_debug' | 'completed' | 'error';
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
    byNode?: Record<string, { promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number; cacheReadTokens?: number }>;
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
}

// Represents the summary item shown in the list
// Note: Backend GET /v1/chat/conversations returns this structure
export interface ConversationListItem {
  id: string;
  title: string;
  flowId: string | null;
  createdAt: number;
  updatedAt: number;
  status?: 'running' | 'awaiting_tool_approval' | 'paused_debug' | 'completed' | 'error'; // Added 'paused_debug'
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
      x.createdAt === y.createdAt &&
      x.updatedAt === y.updatedAt
    );
  });


/** The backend reports a user Stop as a model error coded 'cancelled' with the
 *  message "Execution cancelled by user." (mapped to a 500 by the OpenAI-shaped
 *  route). Recognise it from any error shape the SDK/REST layers throw so a
 *  deliberate Stop is never surfaced as a provider failure. */
const CANCELLED_MESSAGE_RE = /cancelled by user|execution cancelled/i;
const isCancellationError = (err: unknown): boolean => {
  const anyErr = err as { code?: unknown; error?: { code?: unknown }; message?: unknown; body?: { error?: unknown } };
  if (anyErr?.code === 'cancelled' || anyErr?.error?.code === 'cancelled') return true;
  const texts = [anyErr?.message, typeof anyErr?.body?.error === 'string' ? anyErr.body.error : undefined];
  return texts.some(t => typeof t === 'string' && CANCELLED_MESSAGE_RE.test(t));
};

const Chat: React.FC = () => {
  // --- State Management ---
  // List of conversation summaries for the sidebar, fetched from backend
  const [conversationList, setConversationList] = useState<ConversationListItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Full details of the currently selected conversation, fetched when selected
  const [detailedConversation, setDetailedConversation] = useState<Conversation | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState<boolean>(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  // Currently selected conversation ID (persisted)
  const [currentConversationId, setCurrentConversationId] = useLocalStorage<string | null>(
    StorageKey.CURRENT_CONVERSATION_ID,
    null
  );

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
  const [error, setError] = useState<string | null>(null); // General error display

  // Other states
  const [flows, setFlows] = useState<Flow[]>([]); // Use the Flow type from shared types
  const [requireApproval, setRequireApproval] = useState<boolean>(false);
  // Inline conversation-title rename (issue #134, item 2).
  const [isEditingTitle, setIsEditingTitle] = useState<boolean>(false);
  const [titleDraft, setTitleDraft] = useState<string>('');
  const [executeInDebugger, setExecuteInDebugger] = useState<boolean>(false); // State for debugger checkbox
  const [pendingToolCalls, setPendingToolCalls] = useState<OpenAI.ChatCompletionMessageToolCall[] | null>(null);
  // Flow the user asked to switch an already-executed conversation to; a
  // confirmation dialog is shown before the switch is applied (Cancel discards).
  const [pendingFlowSwitch, setPendingFlowSwitch] = useState<string | null>(null);
  // Manually picked node for the NEXT message (the chat input's node picker).
  // null = automatic (follow the conversation). Cleared once a message is sent
  // with it, and on conversation switch.
  const [nodeOverride, setNodeOverride] = useState<string | null>(null);
  const [isDebugPaused, setIsDebugPaused] = useState<boolean>(false); // State to control UI split
  const [debugState, setDebugState] = useState<SharedState | null>(null); // State to hold debug data
  // Whether a debug session is active (panel should stay open). Decoupled from
  // isDebugPaused so the debugger panel does NOT vanish while a step is executing
  // (between pauses) — it stays open and shows live progress, then re-populates
  // when the next pause arrives. Cleared when the session ends or is closed.
  const [debugSessionActive, setDebugSessionActive] = useState<boolean>(false);

  // User-resizable debugger panel width in px (0 = default 50%). Persisted so
  // the preferred split survives reloads. Adjusted by dragging the divider
  // between the chat and the debugger.
  const [debuggerWidth, setDebuggerWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const saved = Number(window.localStorage.getItem('flujo-debugger-width'));
    return Number.isFinite(saved) && saved > 0 ? saved : 0;
  });
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
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('flujo-chat-sidebar-collapsed', next ? '1' : '0');
      }
      return next;
    });
  }, []);
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
  // Live node/resource activity (Tier 3): which nodes/artifacts the run is
  // touching RIGHT NOW, for canvas highlighting in the debugger. Entries decay
  // by age (LIVE_HIGHLIGHT_TTL_MS); pruned on each event application.
  const [liveActivity, setLiveActivity] = useState<LiveActivity>(EMPTY_LIVE_ACTIVITY);
  // Breakpoint node IDs for the visual debugger (mirrors server state).
  const [breakpoints, setBreakpoints] = useState<string[]>([]);
  // Which conversation currently has an active run (so the live indicator only
  // shows for the conversation being viewed, not for background runs).
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);

  // Refs
  const openaiRef = useRef<OpenAI | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Highest event seq applied, for ordering + dedupe across SSE reconnects.
  const lastSeqRef = useRef<number>(-1);
  // Mirror of the viewed conversation id, for use inside stable event callbacks.
  const currentConversationIdRef = useRef<string | null>(currentConversationId);
  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);
  // Conversations that exist only in this client (a split that hasn't been sent
  // yet): the periodic list refresh must not wipe them, and detail fetches for
  // them would 404. Ids drop out as soon as the backend starts returning them.
  const localOnlyConversationIdsRef = useRef<Set<string>>(new Set());
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
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState<boolean>(false);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 80; // px tolerance
    stickToBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scrollMessagesToBottom('smooth');
  }, [scrollMessagesToBottom]);

  // Reset to "stick" whenever the viewed conversation changes.
  useEffect(() => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
  }, [currentConversationId]);

  // Keep pinned to the bottom as messages change — new messages AND in-place
  // streaming updates (the reducer rebuilds the array either way) — but only
  // while the user hasn't scrolled up.
  useEffect(() => {
    if (stickToBottomRef.current) scrollMessagesToBottom('auto');
  }, [detailedConversation?.messages, scrollMessagesToBottom]);
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
  const fetchConversations = useCallback(async (
    selectIdAfterFetch?: string | null,
    options?: { silent?: boolean }
  ) => {
    // `silent` refreshes the list in place (e.g. after a background run finishes
    // to pick up the server-generated title) without flashing the loading
    // spinner or wiping the sidebar on a transient error.
    const silent = options?.silent ?? false;
    log.debug('Fetching conversation list from backend', { silent });
    if (!silent) {
      setIsLoadingHistory(true);
      setHistoryError(null);
    }
    let fetchedList: ConversationListItem[] = [];
    let fetchFailed = false;
    try {
      fetchedList = (await chatService.listConversations())
        // Never re-add a conversation whose DELETE is still in flight.
        .filter(c => !pendingDeleteIdsRef.current.has(c.id))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      // Anything the backend returns is no longer client-only.
      for (const c of fetchedList) localOnlyConversationIdsRef.current.delete(c.id);
      setConversationList(prev => {
        // Preserve client-only conversations (an unsent split) — the server
        // list can't contain them yet.
        const localOnly = prev.filter(c => localOnlyConversationIdsRef.current.has(c.id));
        const next = localOnly.length > 0
          ? [...localOnly, ...fetchedList].sort((a, b) => b.updatedAt - a.updatedAt)
          : fetchedList;
        // Keep the previous array identity when nothing changed, so the
        // periodic silent refresh doesn't re-render the sidebar for no reason.
        return sameConversationLists(prev, next) ? prev : next;
      });
      log.info(`Fetched ${fetchedList.length} conversations for the list`);
    } catch (err) {
      fetchFailed = true;
      log.error('Error fetching conversation list:', err);
      if (!silent) {
        setHistoryError('Failed to load conversation history.');
        setConversationList([]); // Clear list on error
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
      if (idToSelect && idExists(idToSelect)) {
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
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCurrentConversationId]); // Include dependencies that affect auto-selection logic if needed

  useEffect(() => {
    // Fetch initial list on mount
    fetchConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty array ensures this runs only once on mount

  // Keep the sidebar live. New conversations (another tab, the scheduler, API
  // clients) and status changes only exist server-side, and the SSE streams are
  // per-conversation — so the LIST needs a lightweight poll. Silent: no
  // spinner, selection untouched, and the list state keeps its identity when
  // nothing changed. Paused while the tab is hidden; refreshed immediately on
  // return to the tab.
  useEffect(() => {
    const LIST_POLL_MS = 5000;
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      fetchConversations(undefined, { silent: true });
    };
    const interval = setInterval(tick, LIST_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
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
    setDetailedConversation(null); // Clear previous details
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

      setDetailedConversation(conversation);
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
        ).sort((a, b) => b.updatedAt - a.updatedAt)
      );
      log.info('Fetched detailed conversation successfully', { conversationId: id });
    } catch (err: any) { // Use any for error checking
       log.error('Error fetching detailed conversation:', { conversationId: id, err });
       // Ignore errors for a selection that is no longer current.
       if (currentConversationIdRef.current !== id) return;
       if (err instanceof ChatApiError && err.status === 404) {
          setDetailsError(`Conversation ${id} not found.`);
          // Clear the invalid selection and refresh the list
          setCurrentConversationId(null);
          fetchConversations(); // Refresh list and auto-select valid one
       } else {
          setDetailsError(`Failed to load details for conversation ${id}.`);
       }
      setDetailedConversation(null);
    } finally {
      // Only clear the loading flag if this fetch still owns the view; otherwise
      // a newer in-flight fetch manages its own loading state.
      if (currentConversationIdRef.current === id) {
        setIsLoadingDetails(false);
      }
    }
  }, [fetchConversations, setCurrentConversationId]); // currentConversationId read via ref

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

  // Reflect the viewed conversation's persisted "Require Tool Approval" setting in
  // the checkbox. Keyed on the conversation id so it only re-syncs on a switch, not
  // on every content refresh (which would clobber a just-toggled value mid-run).
  useEffect(() => {
    if (detailedConversation) {
      setRequireApproval(detailedConversation.requireApproval ?? false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Nodes of the conversation's flow, for message attribution + the edit
  // dropdown. Memoized: a fresh array per render would defeat the memoized
  // message bubbles (prop identity would change on every SSE event).
  const availableNodes = useMemo(
    () =>
      flows
        .find(f => f.id === detailedConversation?.flowId)
        ?.nodes?.map(node => ({
          id: node.id,
          label: node.data.label || node.id,
        })) || [],
    [flows, detailedConversation?.flowId]
  );

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
  const createNewConversation = async () => {
    log.debug('Attempting to create new conversation');
    setError(null); // Clear previous errors

    // Determine the flowId - backend requires a non-null string.
    // Prefer the last MANUALLY picked flow if it still exists (issue #134, item
    // 6), then the first favorited flow (#120), then the first flow.
    const rememberedFlow =
      lastPickedFlowId && !isQuickChatFlowId(lastPickedFlowId)
        ? flows.find(f => f.id === lastPickedFlowId)
        : undefined;
    const selectedFlowId = (rememberedFlow ?? flows.find(f => f.favorite) ?? flows[0])?.id || null;
    if (!selectedFlowId) {
      log.error('Cannot create conversation: No flows available or first flow has no ID.');
      setError('Cannot create a new conversation: No flows available.');
      return;
    }

    const newId = uuidv4();
    const now = Date.now();
    const initialTitle = 'New Conversation';

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
        [createdConversationSummary, ...prevList].sort((a, b) => b.updatedAt - a.updatedAt) // Add and re-sort
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
      let errorMsg = 'Failed to create conversation on the server.';
      if (err instanceof ChatApiError) {
        errorMsg += ` Error: ${err.body?.error || err.message}`;
      } else if (err instanceof Error) {
        errorMsg += ` Error: ${err.message}`;
      }
      setError(errorMsg);
      // Do not update UI state if backend creation failed
    }
  };

  // --- Quick Chat (issue #61): a model + optional MCP servers, no saved flow ---
  const [quickChatOpen, setQuickChatOpen] = useState<boolean>(false);

  // Synthesize the ephemeral flow, create a conversation seeded with it as a
  // snapshot, then select it. Every turn afterwards uses the normal streaming
  // send path (the engine resolves the flow from the snapshot on the state).
  const startQuickChat = async (selection: QuickChatStartSelection) => {
    setError(null);
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
      title: 'Quick Chat',
      flowId: flow.id,
      flowSnapshot: flow,
      createdAt: now,
      updatedAt: now,
    });

    setConversationList(prev =>
      [created, ...prev].sort((a, b) => b.updatedAt - a.updatedAt)
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
      ).sort((a, b) => b.updatedAt - a.updatedAt) // Keep sorted
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

    switch (event.type) {
      case 'run:start':
        setLiveStats({ totalTokens: 0, activeNode: null, startedAt: Date.now(), lastEventAt: Date.now() });
        setLiveActivity(EMPTY_LIVE_ACTIVITY);
        if (event.conversationId) {
          patchConversationStatus(event.conversationId, 'running');
          markConversationStopped(event.conversationId, false); // a new run clears the prior Stop notice
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
      case 'usage':
        setLiveStats(prev => ({
          totalTokens: (prev?.totalTokens ?? 0) + (event.totalTokens || 0),
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
        }
        break;
      case 'resource:read':
      case 'resource:write': {
        // Light up both the acting node (if attributed) and the resource
        // artifact itself (matched by server+uri or run-artifact name in the
        // canvas). resource:write also bumps resourceVersion so the run-data
        // panel refetches.
        const kind = event.type === 'resource:read' ? 'read' as const : 'write' as const;
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
      case 'error':
        setError(event.message || 'Execution error');
        break;
      default:
        touch({});
        break;
    }
  }, [closeEventStream, fetchDetailedConversation, fetchConversations, markConvRunning, patchConversationStatus, markConversationStopped]);

  // Open the SSE stream for a conversation and resolve once it is connected
  // (or after a short timeout). Callers await this BEFORE issuing the run's POST
  // so the subscription exists before the server emits any events — otherwise a
  // fast run can finish before the stream attaches and the live view sees
  // nothing. The browser auto-reconnects using Last-Event-ID to replay misses.
  const openEventStream = useCallback((conversationId: string, fromSeq?: number): Promise<void> => {
    closeEventStream();
    // Accept events at/after the replay position (fromSeq) or everything (-1).
    lastSeqRef.current = fromSeq !== undefined ? fromSeq - 1 : -1;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversationId, currentConversationSummary?.status, openEventStream]);

  // Delete conversation
  const deleteConversation = async (conversationId: string) => {
    log.debug('Attempting to delete conversation', { conversationId });
    setError(null); // Clear previous general errors

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
    }
    markConvRunning(conversationId, false);

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
      // No need to refetch here, optimistic update is sufficient
      // Selection is handled above

    } catch (err) {
      log.error('Error deleting conversation:', { conversationId, err });
      setError(`Failed to delete conversation ${conversationId}. Please try again.`);
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

  // Handle flow selection from the selector. If the conversation has already
  // been executed, switching flows means execution will restart on the new
  // flow's Start node — ask for confirmation first (Cancel keeps the current
  // flow). Fresh conversations switch immediately.
  const handleFlowSelect = (flowId: string) => {
    if (!currentConversationId) {
      log.warn('Cannot update flow: No conversation selected.');
      setError('Please select a conversation first.');
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

    if (!currentConversationId) {
      log.warn('Cannot update flow: No conversation selected.');
      setError('Please select a conversation first.');
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
      ).sort((a, b) => b.updatedAt - a.updatedAt) // Keep sorted
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
        ).sort((a, b) => b.updatedAt - a.updatedAt) // Re-sort based on server timestamp
      );
      // --- End Confirm UI Update ---

    } catch (err) {
      log.error('Error updating flowId on backend:', { conversationId: currentConversationId, flowId, err });
      let errorMsg = 'Failed to update the selected flow.';
      if (err instanceof ChatApiError) {
        errorMsg += ` Error: ${err.body?.error || err.message}`;
      } else if (err instanceof Error) {
        errorMsg += ` Error: ${err.message}`;
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
      setError('Failed to rename the conversation.');
    }
  };


  // Handle sending a message
  const handleSendMessage = async (content: string, attachments: Attachment[] = []) => {
    if (!content.trim() && attachments.length === 0) return;
    if (!detailedConversation) {
       log.error("Cannot send message, detailed conversation not loaded.");
       setError("Cannot send message: conversation details not loaded.");
       return;
    }

    log.debug('Sending message', { conversationId: detailedConversation.id, contentLength: content.length, attachmentsCount: attachments.length });

    // Determine the appropriate processNodeId for the user message
    let nodeIdToAssign: string | undefined = undefined;
    const existingMessages = detailedConversation.messages;
    const isFirstUserMessage = !existingMessages.some(msg => msg.role === 'user');
    const currentFlowId = detailedConversation.flowId;

    if (nodeOverride) {
      // The user manually picked a node in the chat input's node picker: the
      // message resumes execution there. One-shot — consumed by this send.
      nodeIdToAssign = nodeOverride;
      setNodeOverride(null);
      log.debug(`Assigning manually picked node ID to user message: ${nodeIdToAssign}`);
    } else if (isFirstUserMessage) {
      // For the first user message, use the start node ID from the current flow
      const currentFlow = flows.find(f => f.id === currentFlowId);
      // Assuming the first node in the array is the start node
      // TODO: Consider a more reliable way to identify the start node (e.g., by type)
      const startNode = currentFlow?.nodes?.[0];
      if (startNode) {
        nodeIdToAssign = startNode.id;
        log.debug(`Assigning start node ID to first user message: ${nodeIdToAssign}`);
      } else {
        log.warn(`Could not find start node for flow ${currentFlowId}. User message will not have a processNodeId.`);
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
        const startNode = currentFlow?.nodes?.[0];
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
      setError('Please select a flow for this conversation before sending messages');
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
      ).sort((a, b) => b.updatedAt - a.updatedAt)); // Re-sort
      return true; // Indicate debug state was handled
    } else if ((data.status === 'completed' || data.status === 'error') && isViewed) {
      // Only hide the debugger panel if the execution is definitively finished
      // or errored — and only when the finished conversation is the one on
      // screen (a background run ending must not close the viewed debugger).
      log.info(`API Response: Execution completed or errored (Status: ${data.status}). Hiding debugger panel.`, { conversationId });
      setIsDebugPaused(false);
      setDebugState(null);
      setDebugSessionActive(false);
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
         const errorMessage = data.error?.message || data.lastResponse?.error || 'Unknown error during execution';
         // A user Stop ends the run as a cancellation error: present it neutrally
         // (the "stopped" banner) rather than flashing a red failure.
         if (CANCELLED_MESSAGE_RE.test(errorMessage) || stoppedConversationIdsRef.current.has(conversationId)) {
           markConversationStopped(conversationId, true);
           // Don't wipe an error banner that may belong to another conversation.
           if (isTracked || isViewed) setError(null);
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
       ).sort((a, b) => b.updatedAt - a.updatedAt)); // Re-sort based on potentially new timestamp
    }


    return false; // Indicate standard response was handled
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setDetailedConversation, setPendingToolCalls, setIsLoading, setError, setIsDebugPaused, setDebugState, setConversationList, fetchDetailedConversation, closeEventStream, markConvRunning, patchConversationStatus, markConversationStopped]);


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
       setError("Cannot send message: Missing conversation ID or flow ID.");
       return false;
    }

    // Reset pending calls and error before sending
    setPendingToolCalls(null);
    setError(null);
    setIsLoading(true); // Set loading true for the API call itself
    setLoadingConversationId(conversation.id); // Scope the live indicator to this conversation
    markConvRunning(conversation.id, true);
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
            const meta: ChatCompletionMetadata = {
                flujo: "true",
                requireApproval: requireApproval ? "true" : undefined,
                flujodebug: executeInDebugger ? "true" : undefined, // Add flujodebug flag
                conversationId: conversation.id // Pass the correct ID
            };
            // Ensure only defined string values are included
            const filteredMeta: { [key: string]: string } = {};
            if (meta.flujo) filteredMeta.flujo = meta.flujo;
            if (meta.requireApproval) filteredMeta.requireApproval = meta.requireApproval;
            if (meta.flujodebug) filteredMeta.flujodebug = meta.flujodebug; // Include flujodebug
            if (meta.conversationId) filteredMeta.conversationId = meta.conversationId;
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
      const metadata: ChatCompletionMetadata = {
        flujo: "true",
        requireApproval: requireApproval ? "true" : undefined,
        flujodebug: executeInDebugger ? "true" : undefined,
        conversationId: updatedDetailedConv.id,
        processNodeId: processNodeId || undefined // Add processNodeId to metadata
      };

      // Call the API with the updated metadata
      if (!openaiRef.current) return;
      setError(null);
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
            if (msg.role === 'assistant') return { role: 'assistant', content, tool_calls: msg.tool_calls, ...identity } as OpenAI.ChatCompletionAssistantMessageParam;
            if (msg.role === 'system') return { role: 'system', content, ...identity } as OpenAI.ChatCompletionSystemMessageParam;
            if (msg.role === 'tool') {
              if (!msg.tool_call_id) return { role: 'user', content: typeof content === 'string' ? `Tool result: ${content}` : content, ...identity } as OpenAI.ChatCompletionUserMessageParam;
              return { role: 'tool', content, tool_call_id: msg.tool_call_id, ...identity } as OpenAI.ChatCompletionToolMessageParam;
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
            if (metadata.processNodeId) filteredMeta.processNodeId = metadata.processNodeId;
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
          setError(err instanceof Error ? err.message : 'Failed to send edited message');
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

  // Split conversation at a message (creates new local conversation)
  const splitConversationAtMessage = (messageId: string) => {
    if (!detailedConversation) return;
    log.debug('Splitting conversation at message', { messageId });

    const messageIndex = detailedConversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    const messagesBeforeSplit = detailedConversation.messages.slice(0, messageIndex + 1);

    // Create a new *local* conversation based on the split
    const newId = uuidv4();
    const newSplitConversation: Conversation = {
      id: newId,
      title: `Split from ${detailedConversation.title}`,
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
    setConversationList(prevList => [newSummary, ...prevList].sort((a, b) => b.updatedAt - a.updatedAt));
    setCurrentConversationId(newId); // Select the new split conversation
    // The useEffect for currentConversationId will fetch details, but we can set it directly
    setDetailedConversation(newSplitConversation);
    setIsLoadingDetails(false);
    setDetailsError(null);
    // Note: This split conversation doesn't exist on the backend until a message is sent.
  };

  // Handle Approve/Reject Tool Call
  const handleToolResponse = async (action: 'approve' | 'reject', toolCallId: string) => {
    if (!currentConversationId) return;
    log.info(`Handling tool response: ${action}`, { conversationId: currentConversationId, toolCallId });

    setPendingToolCalls(null);
    setIsLoading(true); // Indicate processing and potentially restart polling
    setLoadingConversationId(currentConversationId);
    markConvRunning(currentConversationId, true);
    setError(null);
    await openEventStream(currentConversationId);

    try {
      // The /respond endpoint processes the approved/rejected call, then resumes
      // execution (re-invoking the model) once no calls remain pending. It
      // returns the next natural stop point — another approval prompt, a debug
      // pause, completion, or error — which we hand to the shared response
      // handler. Live updates also arrive over the already-open SSE stream.
      const data = await chatService.respondToToolCall(currentConversationId, action, toolCallId);
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
      let errorMessage = `Failed to ${action} tool call.`;
      if (err instanceof ChatApiError) {
        errorMessage += ` Error: ${err.body?.error || err.message}`;
      } else if (err instanceof Error) {
        errorMessage += ` Error: ${err.message}`;
      }
      setError(errorMessage);
      // Stop loading on error since polling won't restart — unless the live
      // view has since moved on to another conversation's run.
      if (loadingConversationIdRef.current === currentConversationId) setIsLoading(false);
      markConvRunning(currentConversationId, false);
    }
  };

  const handleApproveToolCall = (toolCallId: string) => {
    handleToolResponse('approve', toolCallId);
  };

  const handleRejectToolCall = (toolCallId: string) => {
    handleToolResponse('reject', toolCallId);
  };

  // --- Debugger Control Handlers ---
  const handleDebugStep = async () => {
    if (!currentConversationId || !isDebugPaused) return;
    log.info('Handling debug step request', { conversationId: currentConversationId });
    setIsLoading(true); // Show loading during step
    setLoadingConversationId(currentConversationId);
    markConvRunning(currentConversationId, true);
    setError(null);
    await openEventStream(currentConversationId);
    try {
      const data = await chatService.debugStep(currentConversationId);
      handleApiResponse(data, currentConversationId); // Process the response (updates state, status)
    } catch (err) {
      log.error('Error during debug step API call', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : 'Failed to execute debug step.');
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
    setError(null);
    setIsDebugPaused(false); // No longer paused — running until the next pause/end.
    // Keep debugState + debugSessionActive so the panel stays open and shows live
    // progress while continuing (it repopulates on the next pause); previously
    // nulling debugState here made the panel vanish until the next breakpoint.
    await openEventStream(currentConversationId);
    try {
      const data = await chatService.debugContinue(currentConversationId);
      handleApiResponse(data, currentConversationId); // Process the response
      // Polling might restart via useEffect if status is 'running'
    } catch (err) {
      log.error('Error during debug continue API call', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : 'Failed to continue execution.');
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
      setError(err instanceof Error ? err.message : 'Failed to step over.');
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
    setDebugSessionActive(false);
    closeEventStream();
    setPendingToolCalls(null);
    setError(null); // a deliberate Stop is not an error to surface

    try {
      await chatService.cancel(currentConversationId);
      log.debug('Cancel request sent successfully', { conversationId: currentConversationId });
      // Fetch details again to get the potentially updated 'cancelled' status/message
      await fetchDetailedConversation(currentConversationId);
    } catch (err) {
      log.error('Error sending cancel request', { conversationId: currentConversationId, err });
      setError('Failed to send cancel request to the server.');
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
      // flips on its next loop iteration — the list poll catches that.
      await fetchConversations(undefined, { silent: true });
    } catch (err) {
      log.error('Error stopping background conversation', { conversationId, err });
      setError('Failed to send cancel request to the server.');
    }
  };

  // Manually dismiss the debugger panel. Hides the split view and clears the
  // local debug state, then cancels the paused run so the conversation is not
  // left stuck in 'paused_debug' on the backend.
  const handleDebugClose = async () => {
    log.info('Closing debugger panel', { conversationId: currentConversationId });
    setIsDebugPaused(false);
    setDebugState(null);
    setDebugSessionActive(false);
    await handleCancelRequest();
  };

  // --- Add logging for Edit button prop ---
  log.debug('Rendering Chat component', {
    currentConversationId,
    isHandleEditMessageDefined: typeof handleEditMessage === 'function'
  });
  // --- End logging ---

  // The debugger panel stays open for the whole debug session (not just while
  // paused), so it doesn't flicker shut while a step/continue is executing.
  const debugPanelOpen = (debugSessionActive || isDebugPaused) && !!debugState && !!currentConversationId;

  // The viewed conversation counts as running when THIS client started or
  // re-attached to the run (isLoading/loadingConversationId/runningConvs) OR
  // when the server says so (sidebar status — kept fresh by the list poll, the
  // detail fetch, and run events). The status fallback is what keeps the live
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

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 64px)' }}>
      {/* Collapsed state: a slim always-visible affordance to bring the sidebar
          back (so the conversation list is never permanently lost). */}
      {sidebarCollapsed && (
        <Box
          sx={{
            width: 40,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            justifyContent: 'center',
            pt: 1,
          }}
        >
          <Tooltip title="Show conversation sidebar">
            <IconButton size="small" onClick={toggleSidebarCollapsed} aria-label="Show conversation sidebar">
              <ViewSidebarIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      )}

      {/* Left sidebar with conversation history (resizable + collapsible) */}
      {!sidebarCollapsed && (
        <Box
          sx={{
            width: sidebarWidth,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {isLoadingHistory ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 2 }}>
              <Spinner size="medium" color="primary" />
            </Box>
          ) : historyError ? (
             <Alert severity="error" sx={{ m: 2 }}>{historyError}</Alert>
          ) : (
            <ChatHistory
              conversations={conversationList} // Pass the list state (ConversationListItem[])
              currentConversationId={currentConversationId}
              onSelectConversation={setCurrentConversationId}
              onDeleteConversation={deleteConversation}
              onStopConversation={handleStopConversation}
              onNewConversation={createNewConversation}
              onQuickChat={() => setQuickChatOpen(true)}
              onCollapse={toggleSidebarCollapsed}
            />
          )}
        </Box>
      )}

      {/* Draggable divider: resizes the sidebar. Hidden when collapsed. */}
      {!sidebarCollapsed && (
        <Box
          onPointerDown={startSidebarResize}
          sx={{
            width: '6px',
            flexShrink: 0,
            cursor: 'col-resize',
            bgcolor: 'divider',
            transition: 'background-color 120ms',
            '&:hover': { bgcolor: 'primary.main' },
            touchAction: 'none',
          }}
          aria-label="Resize conversation sidebar"
        />
      )}

      {/* Main Content Area (Chat or Chat + Debugger). Flex, not Grid: the
          debugger panel has a user-resizable pixel width (drag the divider). */}
      <Box sx={{ flex: 1, height: '100%', display: 'flex', minWidth: 0, minHeight: 0 }}>
        {/* Chat Area */}
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Conversation title header + inline rename (issue #134, item 2).
              Shown once a conversation is selected. Click the pencil (or the
              title) to edit; Enter/blur saves, Escape cancels. */}
          {currentConversationId && (
            <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
              {isEditingTitle ? (
                <TextField
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
                  inputProps={{ maxLength: 200, 'aria-label': 'Conversation title' }}
                />
              ) : (
                <>
                  <Typography
                    variant="h6"
                    noWrap
                    onClick={beginEditTitle}
                    title={detailedConversation?.title || currentConversationSummary?.title || ''}
                    sx={{ flex: 1, minWidth: 0, cursor: 'text' }}
                  >
                    {detailedConversation?.title || currentConversationSummary?.title || 'Untitled Conversation'}
                  </Typography>
                  <Tooltip title="Rename conversation">
                    <IconButton size="small" onClick={beginEditTitle} aria-label="Rename conversation">
                      <EditIcon fontSize="small" />
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
            <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {isQuickChatFlowId(currentConversationSummary?.flowId || detailedConversation?.flowId) ? (
                  // Quick chats have no stored flow to select — the flow lives on
                  // the conversation as a snapshot. Show a badge instead of the
                  // flow dropdown (which would render blank).
                  <Chip color="primary" variant="outlined" icon={<BoltIcon />} label="Quick Chat" />
                ) : (
                  <FlowSelector
                    // Remove duplicate selectedFlowId prop
                    selectedFlowId={currentConversationSummary?.flowId || detailedConversation?.flowId || null} // Use summary first, fallback to detail
                    onSelectFlow={handleFlowSelect}
                    disabled={isDebugPaused} // Disable flow selection when debugging
                  />
                )}
              </Box>
              {/* Token totals + context meter (persisted usage; refreshed with the conversation) */}
              <ConversationStats
                usage={detailedConversation?.usage}
                contextInfo={detailedConversation?.contextInfo}
                availableNodes={availableNodes}
              />
            </Box>
          )}

        {/* Chat messages - Use detailed data. The wrapper is position:relative and
            does NOT scroll, so the "jump to latest" FAB stays pinned over the
            visible area while the inner Box (the scroll container) scrolls. */}
        <Box sx={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <Box
          ref={messagesScrollRef}
          onScroll={handleMessagesScroll}
          sx={{ flex: 1, overflow: 'auto', p: 2 }}
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
                availableNodes={availableNodes} // Memoized nodes for the selected flow
                conversationId={detailedConversation.id} // Resets the render window on switch
                onToggleDisabled={toggleMessageDisabled}
                onSplitConversation={splitConversationAtMessage}
                onEditMessage={handleEditMessage}
                onApproveToolCall={handleApproveToolCall}
                onRejectToolCall={handleRejectToolCall}
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
                    Conversation completed
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
                    action={
                      <Button
                        color="inherit"
                        size="small"
                        startIcon={<RefreshIcon />}
                        onClick={() => sendToChatCompletions(detailedConversation)}
                      >
                        Resume
                      </Button>
                    }
                  >
                    Conversation stopped
                  </Alert>
                </Box>
              )}

              {/* Error banner: the run ended in an error state. Guarded by !error
                  so it doesn't duplicate the transient error Alert shown right
                  after a live failure; this one persists across reloads. Not shown
                  for a user Stop (viewedConversationStopped owns that case). */}
              {!isLoading && !isDebugPaused && !error && !viewedConversationStopped && currentConversationSummary?.status === 'error' && (
                <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
                  <Alert
                    icon={<ErrorOutlineIcon fontSize="inherit" />}
                    severity="error"
                    variant="filled"
                    sx={{ borderRadius: 2, py: 0.5, alignItems: 'center' }}
                    action={
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
                        Retry
                      </Button>
                    }
                  >
                    Conversation ended with an error
                  </Alert>
                </Box>
              )}

              {/* Live execution indicator (progress, active node, tokens, stop).
                  Shown whenever the VIEWED conversation is running — including
                  runs this client didn't start (see viewedConversationRunning) —
                  but never for background runs in other conversations, and never
                  while the debugger owns the pause UI. Owns its own 1s tick so
                  the rest of the tree doesn't re-render. */}
              {viewedConversationRunning && !isDebugPaused && (
                <LiveRunIndicator
                  liveStats={liveStats}
                  onStop={handleCancelRequest}
                  stopDisabled={!currentConversationId}
                />
              )}

              {/* Parked at a tool-approval prompt: the run is still alive (and
                  for agentic adapters, blocked mid-request), so keep Stop
                  reachable next to the Approve/Reject prompt — spinner-less so
                  it doesn't suggest activity while waiting on the user. */}
              {!viewedConversationRunning && viewedConversationAwaitingApproval && !isDebugPaused && (
                <LiveRunIndicator
                  liveStats={liveStats}
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
                      Retry
                    </Button>
                  }
                >
                  {error}
                </Alert>
              )}
            </>
          ) : (
            // Message when no conversation is selected or loaded
            <Typography variant="body1" color="textSecondary" align="center" sx={{ mt: 4 }}>
              {conversationList.length > 0
                ? "Select a conversation or create a new one."
                : "Create a new conversation to start chatting."}
            </Typography>
          )}
        </Box>
        {/* Jump-to-latest: appears only when the user has scrolled up from the
            bottom. Clicking re-enables stick-to-bottom and scrolls down. */}
        <Zoom in={showScrollToBottom} unmountOnExit>
          <Fab
            size="small"
            color="primary"
            aria-label="Scroll to latest messages"
            onClick={jumpToLatest}
            sx={{ position: 'absolute', bottom: 16, right: 24, zIndex: 2 }}
          >
            <KeyboardArrowDownIcon />
          </Fab>
        </Zoom>
        </Box>

        {/* Chat input */}
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
          <ChatInput
            onSendMessage={handleSendMessage}
            // Disable only when the VIEWED conversation is busy, so a run in one
            // conversation no longer blocks typing/sending in another (parallel use).
            // runningConvs scopes "busy" per-conversation; pendingToolCalls /
            // isDebugPaused are viewed-conversation states.
            disabled={isLoadingDetails || (!!currentConversationId && runningConvs.has(currentConversationId)) || !(detailedConversation?.flowId || currentConversationSummary?.flowId) || !!pendingToolCalls || isDebugPaused}
            requireApproval={requireApproval}
            onRequireApprovalChange={handleRequireApprovalChange}
            executeInDebugger={executeInDebugger} // Pass debugger state
            onExecuteInDebuggerChange={setExecuteInDebugger} // Pass debugger handler
            // Node picker: shows where the next message resumes; a manual pick
            // overrides it for one send (null = back to automatic).
            availableNodes={availableNodes}
            currentNodeId={currentNodeId}
            nodeOverrideActive={!!nodeOverride}
            onSelectNode={setNodeOverride}
          />
        </Box>
        </Box> {/* End Chat Area */}

        {/* Debugger Area (open for the whole debug session, not only when paused) */}
        {debugPanelOpen && (
          <>
            {/* Draggable divider: resizes the debugger panel. */}
            <Box
              onPointerDown={startDebuggerResize}
              sx={{
                width: '6px',
                flexShrink: 0,
                cursor: 'col-resize',
                bgcolor: 'divider',
                transition: 'background-color 120ms',
                '&:hover': { bgcolor: 'primary.main' },
                touchAction: 'none',
              }}
              aria-label="Resize debugger panel"
            />
            <Box
              sx={{
                width: debuggerWidth ? `${debuggerWidth}px` : '50%',
                minWidth: 360,
                maxWidth: '85vw',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
              }}
            >
              <DebuggerCanvas
                debugState={debugState}
                conversationId={currentConversationId}
                liveActivity={liveActivity}
                onStep={handleDebugStep}
                onStepOver={handleStepOver}
                onContinue={handleDebugContinue}
                onCancel={handleCancelRequest}
                isLoading={isLoading}
                breakpoints={breakpoints}
                onToggleBreakpoint={handleToggleBreakpoint}
                onClose={handleDebugClose}
              />
            </Box>
          </>
        )}
      </Box> {/* End Main Content */}

      {/* Flow-switch confirmation: switching an already-executed conversation
          to another flow restarts execution on that flow's Start node. Cancel
          keeps the current flow (the selector is controlled, so no revert is
          needed — we simply never apply the change). */}
      <Dialog open={!!pendingFlowSwitch} onClose={() => setPendingFlowSwitch(null)}>
        <DialogTitle>Switch flow?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This conversation has already been processed with its current flow.
            {' '}If you switch to
            {' '}<strong>{flows.find(f => f.id === pendingFlowSwitch)?.name || 'the selected flow'}</strong>,
            {' '}the conversation will continue processing from that flow&apos;s Start node again.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingFlowSwitch(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              const flowId = pendingFlowSwitch;
              setPendingFlowSwitch(null);
              if (flowId) applyFlowSelect(flowId);
            }}
          >
            Switch Flow
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
