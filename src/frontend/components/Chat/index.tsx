"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react'; // Added useCallback
import { Box, Paper, Typography, Divider, CircularProgress, Alert, Button } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useLocalStorage, StorageKey } from '@/utils/storage';
import { Grid } from '@mui/material'; // Import Grid for layout
import ChatHistory from './ChatHistory';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import FlowSelector from './FlowSelector';
import DebuggerCanvas from './DebuggerCanvas';
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
import { Flow, FlowNode } from '@/shared/types/flow'; // Import Flow and FlowNode types

const log = createLogger('frontend/components/Chat/index');

// Define types for our chat data
export interface Attachment {
  id: string;
  type: 'document' | 'audio';
  content: string;
  originalName?: string;
}

// Use the shared FlujoChatMessage type and extend it with UI-specific fields
export type ChatMessage = FlujoChatMessage & {
  attachments?: Attachment[];
};

// Represents the full conversation details including messages
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  flowId: string | null;
  createdAt: number;
  updatedAt: number;
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

  // State for ongoing chat completion requests (send/poll)
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null); // General error display

  // Other states
  const [flows, setFlows] = useState<Flow[]>([]); // Use the Flow type from shared types
  const [requireApproval, setRequireApproval] = useState<boolean>(false);
  const [executeInDebugger, setExecuteInDebugger] = useState<boolean>(false); // State for debugger checkbox
  const [pendingToolCalls, setPendingToolCalls] = useState<OpenAI.ChatCompletionMessageToolCall[] | null>(null);
  const [isDebugPaused, setIsDebugPaused] = useState<boolean>(false); // State to control UI split
  const [debugState, setDebugState] = useState<SharedState | null>(null); // State to hold debug data

  // Live execution stats, driven by the SSE event stream while a run is active.
  const [liveStats, setLiveStats] = useState<
    { totalTokens: number; activeNode: string | null; startedAt: number; lastEventAt: number } | null
  >(null);
  // Breakpoint node IDs for the visual debugger (mirrors server state).
  const [breakpoints, setBreakpoints] = useState<string[]>([]);
  // Which conversation currently has an active run (so the live indicator only
  // shows for the conversation being viewed, not for background runs).
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  // Re-render tick (1s) so elapsed/"stuck" indicators update while loading.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

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
      fetchedList = (await chatService.listConversations()).sort((a, b) => b.updatedAt - a.updatedAt);
      setConversationList(fetchedList);
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
      if (idToSelect && fetchedList.some(c => c.id === idToSelect)) {
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
         // No conversations left
         if (liveSelection !== null) {
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

  // Fetch detailed conversation when ID changes
  const fetchDetailedConversation = useCallback(async (id: string) => {
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
            ? { ...c, title: conversation.title, flowId: conversation.flowId, updatedAt: conversation.updatedAt }
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
    if (currentConversationId) {
      fetchDetailedConversation(currentConversationId);
    } else {
      // Clear details if no conversation is selected
      setDetailedConversation(null);
      setIsLoadingDetails(false);
      setDetailsError(null);
    }
  }, [currentConversationId, fetchDetailedConversation]); // Trigger fetch when selection changes

  // --- Conversation Management Functions ---

  // Get current conversation summary from the list for UI elements
  const currentConversationSummary = conversationList.find(
    (conv) => conv.id === currentConversationId
  ) || null;

  // Create a new conversation (now persists to backend immediately)
  const createNewConversation = async () => {
    log.debug('Attempting to create new conversation');
    setError(null); // Clear previous errors

    // Determine the flowId - backend requires a non-null string
    const selectedFlowId = flows[0]?.id || null; // Get the first available flow ID
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

    switch (event.type) {
      case 'run:start':
        setLiveStats({ totalTokens: 0, activeNode: null, startedAt: Date.now(), lastEventAt: Date.now() });
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
        break;
      case 'handoff':
        touch({ activeNode: `→ ${event.toNodeId}` });
        break;
      case 'run:awaiting_approval':
        setPendingToolCalls(event.pendingToolCalls || []);
        break;
      case 'breakpoint:hit':
      case 'run:paused':
        // Flip the UI to paused; the awaited POST response carries the full
        // debugState (trace + current node) and populates the debugger panel.
        setIsLoading(false);
        setIsDebugPaused(true);
        break;
      case 'run:done':
        setLiveStats(null);
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
  }, [closeEventStream, fetchDetailedConversation, fetchConversations]);

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
    log.info('Re-attaching to in-progress run', { conversationId: currentConversationId });
    loadingConversationIdRef.current = currentConversationId; // guard re-entry before state commits
    setIsLoading(true);
    setLoadingConversationId(currentConversationId);
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
      // Revert optimistic UI update
      setConversationList(previousList);
      setCurrentConversationId(previousSelectionId);
      // Optionally call fetchConversations() again to ensure sync despite error?
      // await fetchConversations(previousSelectionId);
    }
  };

  // Handle flow selection (Persists via PATCH and updates local state)
  const handleFlowSelect = async (flowId: string) => {
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

    if (isFirstUserMessage) {
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

    // --- Check for Debug Paused State ---
    if (data.status === 'paused_debug' && data.debugState) {
      log.info('API Response: Paused for debugging', { conversationId });
      setDebugState(data.debugState as SharedState);
      setIsDebugPaused(true);
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
    } else if (data.status === 'completed' || data.status === 'error') {
      // Only hide the debugger panel if the execution is definitively finished or errored
      log.info(`API Response: Execution completed or errored (Status: ${data.status}). Hiding debugger panel.`, { conversationId });
      setIsDebugPaused(false);
      setDebugState(null);
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
      setPendingToolCalls(data.pendingToolCalls || []);
      setIsLoading(false); // Stop loading indicator
      setLoadingConversationId(null);
      closeEventStream();
      stopPolling();
    } else if (data.status === 'completed' || data.status === 'error') {
      log.info('API Response/Polling: Stopping due to final status', { conversationId, status: data.status });
      stopPolling();
      setIsLoading(false);
      setLoadingConversationId(null);
      closeEventStream();
      if (data.status === 'error') {
         // Handle OpenAI compatible error structure
         const errorMessage = data.error?.message || data.lastResponse?.error || 'Unknown error during execution';
         setError(errorMessage);
         log.error('API Response/Polling: Execution resulted in error', { conversationId, error: data.error || data.lastResponse });
      }
      // Fetch final state one last time for completed/error?
      fetchDetailedConversation(conversationId);
    } else if (data.status === 'running' && !isDebugPaused) {
       // If status is running and we are NOT paused for debug, clear pending calls and continue polling/loading
       setPendingToolCalls(null);
       if (!pollingIntervalRef.current) { // Restart polling if it stopped
          setIsLoading(true); // Ensure loading indicator is on
       }
    } else {
       // Other statuses or conditions
       setPendingToolCalls(null); // Clear pending calls for safety
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
  }, [setDetailedConversation, setPendingToolCalls, setIsLoading, setError, setIsDebugPaused, setDebugState, setConversationList, fetchDetailedConversation, closeEventStream]);


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

  // Tick once per second while loading so elapsed/"stuck" indicators refresh.
  useEffect(() => {
    if (!isLoading) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isLoading]);


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
    // Seed live stats immediately so the indicator shows 0 tokens / 0s right away.
    setLiveStats({ totalTokens: 0, activeNode: null, startedAt: Date.now(), lastEventAt: Date.now() });
    // Subscribe to live events BEFORE issuing the (blocking) POST so no early
    // events are missed on a fast run.
    await openEventStream(conversation.id);

    let success = false; // Track if API call itself succeeded

    try {
      // Look up the flow by ID to get its name
      const flow = await flowService.getFlow(conversation.flowId);
      if (!flow) {
        throw new Error(`Flow with ID ${conversation.flowId} not found`);
      }

      log.debug('Sending to chat completions', { flowId: conversation.flowId, flowName: flow.name, conversationId: conversation.id });

      // Prepare messages for the API from the detailed conversation
      const messages = conversation.messages
        .filter(msg => !msg.disabled)
        .map(msg => {
          let content = msg.content;
          if (msg.attachments && msg.attachments.length > 0) {
            content += '\n\n' + msg.attachments.map(att =>
              `[${att.type.toUpperCase()}]: ${att.content}`
            ).join('\n\n');
          }
          
          // Include processNodeId in the message object if it exists
          const processNodeId = msg.processNodeId;
          
          // Create properly typed message based on role
          if (msg.role === 'user') {
            // For user messages, include processNodeId as a custom property
            return { 
              role: 'user', 
              content,
              processNodeId // Include processNodeId if it exists
            } as OpenAI.ChatCompletionUserMessageParam & { processNodeId?: string };
          }
          if (msg.role === 'assistant') {
            return { 
              role: 'assistant', 
              content, 
              tool_calls: msg.tool_calls,
              processNodeId // Include processNodeId if it exists
            } as OpenAI.ChatCompletionAssistantMessageParam & { processNodeId?: string };
          }
          if (msg.role === 'system') {
            return { 
              role: 'system', 
              content,
              processNodeId // Include processNodeId if it exists
            } as OpenAI.ChatCompletionSystemMessageParam & { processNodeId?: string };
          }
          if (msg.role === 'tool') {
            if (!msg.tool_call_id) {
              return { 
                role: 'user', 
                content: `Tool result: ${content}`,
                processNodeId // Include processNodeId if it exists
              } as OpenAI.ChatCompletionUserMessageParam & { processNodeId?: string };
            }
            return { 
              role: 'tool', 
              content, 
              tool_call_id: msg.tool_call_id,
              processNodeId // Include processNodeId if it exists
            } as OpenAI.ChatCompletionToolMessageParam & { processNodeId?: string };
          }
          // Fallback
          return { 
            role: 'user', 
            content,
            processNodeId // Include processNodeId if it exists
          } as OpenAI.ChatCompletionUserMessageParam & { processNodeId?: string };
        });

      // Call the API
      const completion = await openaiRef.current.chat.completions.create({
        model: `flow-${flow.name}`,
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
      stopPolling();
      setIsLoading(false); // Stop loading on error
      setLoadingConversationId(null);
      closeEventStream();

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
      setLiveStats({ totalTokens: 0, activeNode: null, startedAt: Date.now(), lastEventAt: Date.now() });
      await openEventStream(updatedDetailedConv.id);
      try {
        const flow = await flowService.getFlow(updatedDetailedConv.flowId);
        if (!flow) {
          throw new Error(`Flow with ID ${updatedDetailedConv.flowId} not found`);
        }

        // Prepare messages for the API
        const messages = updatedDetailedConv.messages
          .filter(msg => !msg.disabled)
          .map(msg => {
            let content = msg.content;
            if (msg.attachments && msg.attachments.length > 0) {
              content += '\n\n' + msg.attachments.map(att =>
                `[${att.type.toUpperCase()}]: ${att.content}`
              ).join('\n\n');
            }
            // Create properly typed message based on role
            if (msg.role === 'user') return { role: 'user', content } as OpenAI.ChatCompletionUserMessageParam;
            if (msg.role === 'assistant') return { role: 'assistant', content, tool_calls: msg.tool_calls } as OpenAI.ChatCompletionAssistantMessageParam;
            if (msg.role === 'system') return { role: 'system', content } as OpenAI.ChatCompletionSystemMessageParam;
            if (msg.role === 'tool') {
              if (!msg.tool_call_id) return { role: 'user', content: `Tool result: ${content}` } as OpenAI.ChatCompletionUserMessageParam;
              return { role: 'tool', content, tool_call_id: msg.tool_call_id } as OpenAI.ChatCompletionToolMessageParam;
            }
            return { role: 'user', content } as OpenAI.ChatCompletionUserMessageParam; // Fallback
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
        log.error('Error sending edited message:', err);
        setError(err instanceof Error ? err.message : 'Failed to send edited message');
        setIsLoading(false);
        setLoadingConversationId(null);
        closeEventStream();
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
      log.error(`Error sending tool response (${action})`, { conversationId: currentConversationId, toolCallId, err });
      let errorMessage = `Failed to ${action} tool call.`;
      if (err instanceof ChatApiError) {
        errorMessage += ` Error: ${err.body?.error || err.message}`;
      } else if (err instanceof Error) {
        errorMessage += ` Error: ${err.message}`;
      }
      setError(errorMessage);
      setIsLoading(false); // Stop loading on error since polling won't restart
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
    setError(null);
    await openEventStream(currentConversationId);
    try {
      const data = await chatService.debugStep(currentConversationId);
      handleApiResponse(data, currentConversationId); // Process the response (updates state, status)
    } catch (err) {
      log.error('Error during debug step API call', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : 'Failed to execute debug step.');
      setIsLoading(false); // Stop loading on error
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
    setError(null);
    setIsDebugPaused(false); // Assume we are exiting explicit pause
    setDebugState(null);
    await openEventStream(currentConversationId);
    try {
      const data = await chatService.debugContinue(currentConversationId);
      handleApiResponse(data, currentConversationId); // Process the response
      // Polling might restart via useEffect if status is 'running'
    } catch (err) {
      log.error('Error during debug continue API call', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : 'Failed to continue execution.');
      setIsLoading(false); // Stop loading on error
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
    } catch (err) {
      log.error('Error during step over', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : 'Failed to step over.');
      setIsLoading(false);
    }
  };

  // Handle Cancel Request (Also used by Debugger)
  const handleCancelRequest = async () => {
    if (!currentConversationId) return;
    log.info('Cancelling request', { conversationId: currentConversationId });

    stopPolling();
    setIsLoading(false);
    setLoadingConversationId(null);
    closeEventStream();
    setPendingToolCalls(null);

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

  // --- Add logging for Edit button prop ---
  log.debug('Rendering Chat component', {
    currentConversationId,
    isHandleEditMessageDefined: typeof handleEditMessage === 'function'
  });
  // --- End logging ---

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 64px)' }}>
      {/* Left sidebar with conversation history */}
      <Box
        sx={{
          width: 300,
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
            onNewConversation={createNewConversation}
          />
        )}
      </Box>

      {/* Main Content Area (Chat or Chat + Debugger) */}
      <Grid container sx={{ flex: 1, height: '100%' }}>
        {/* Chat Area */}
        <Grid item xs={isDebugPaused ? 6 : 12} sx={{ display: 'flex', flexDirection: 'column', height: '100%', borderRight: isDebugPaused ? 1 : 0, borderColor: 'divider' }}>
          {/* Flow selector - Use summary data */}
          <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
            <FlowSelector
              // Remove duplicate selectedFlowId prop
              selectedFlowId={currentConversationSummary?.flowId || detailedConversation?.flowId || null} // Use summary first, fallback to detail
              onSelectFlow={handleFlowSelect}
              disabled={isDebugPaused} // Disable flow selection when debugging
            />
          </Box>

        {/* Chat messages - Use detailed data */}
        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
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
                availableNodes={flows.find(f => f.id === detailedConversation.flowId)?.nodes?.map(node => ({
                  id: node.id,
                  label: node.data.label || node.id
                })) || []} // Pass available nodes for the selected flow
                onToggleDisabled={toggleMessageDisabled}
                onSplitConversation={splitConversationAtMessage}
                onEditMessage={handleEditMessage}
                onApproveToolCall={handleApproveToolCall}
                onRejectToolCall={handleRejectToolCall}
              />

              {/* Live execution indicator (progress, active node, tokens, stop).
                  Only shown for the conversation actually running, so a background
                  run does not display its status in a different conversation. */}
              {isLoading && loadingConversationId === currentConversationId && (() => {
                const elapsed = liveStats ? Math.max(0, Math.round((nowTick - liveStats.startedAt) / 1000)) : 0;
                const sinceLast = liveStats ? Math.round((nowTick - liveStats.lastEventAt) / 1000) : 0;
                const stuck = !!liveStats && sinceLast >= 20;
                return (
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', my: 2, gap: 0.5 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <CircularProgress size={20} color={stuck ? 'warning' : 'primary'} />
                      <Typography variant="body2" color="textSecondary">
                        {liveStats?.activeNode ? `Running: ${liveStats.activeNode}` : 'Working…'}
                      </Typography>
                      <Button
                        variant="outlined"
                        color="secondary"
                        size="small"
                        onClick={handleCancelRequest}
                        disabled={!currentConversationId}
                      >
                        Stop
                      </Button>
                    </Box>
                    <Typography variant="caption" color={stuck ? 'warning.main' : 'textSecondary'}>
                      {(liveStats?.totalTokens ?? 0).toLocaleString()} tokens · {elapsed}s elapsed
                      {stuck ? ` · no activity for ${sinceLast}s — may be stuck` : ''}
                    </Typography>
                  </Box>
                );
              })()}

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

        {/* Chat input */}
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
          <ChatInput
            onSendMessage={handleSendMessage}
            // Disable if loading details, loading response, no flow selected (check both detailed and summary), OR awaiting approval
            disabled={isLoadingDetails || isLoading || !(detailedConversation?.flowId || currentConversationSummary?.flowId) || !!pendingToolCalls || isDebugPaused} // Also disable input when paused
            requireApproval={requireApproval}
            onRequireApprovalChange={setRequireApproval}
            executeInDebugger={executeInDebugger} // Pass debugger state
            onExecuteInDebuggerChange={setExecuteInDebugger} // Pass debugger handler
          />
        </Box>
        </Grid> {/* End Chat Area Grid */}

        {/* Debugger Area (Conditional) */}
        {isDebugPaused && debugState && currentConversationId && (
          <Grid item xs={6} sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <DebuggerCanvas
              debugState={debugState}
              conversationId={currentConversationId}
              onStep={handleDebugStep}
              onStepOver={handleStepOver}
              onContinue={handleDebugContinue}
              onCancel={handleCancelRequest}
              isLoading={isLoading}
              breakpoints={breakpoints}
              onToggleBreakpoint={handleToggleBreakpoint}
            />
          </Grid>
        )}
      </Grid> {/* End Main Content Grid */}
    </Box>
  );
};

export default Chat;
