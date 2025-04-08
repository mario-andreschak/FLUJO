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
import Spinner from '@/frontend/components/shared/Spinner';
import { v4 as uuidv4 } from 'uuid';
import OpenAI, { OpenAIError, APIError } from 'openai'; // Import APIError
import { flowService } from '@/frontend/services/flow';
import { createLogger } from '@/utils/logger';
import axios, { AxiosResponse } from 'axios'; // Import axios for polling and AxiosResponse
// Correctly import SharedState here
import { ChatCompletionMetadata, FlujoChatMessage } from '@/shared/types/chat'; // Import the shared types
import type { SharedState } from '@/backend/execution/flow/types'; // Import SharedState type from backend
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

  // Refs
  const openaiRef = useRef<OpenAI | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // --- Effects ---

  // Initialize OpenAI client
  useEffect(() => {
    const baseURL = window.location.origin + '/v1';
    openaiRef.current = new OpenAI({
      baseURL,
      apiKey: 'FLUJO', // Replace with actual key if needed, though likely handled by backend proxy
      dangerouslyAllowBrowser: true,
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
  const fetchConversations = useCallback(async (selectIdAfterFetch?: string | null) => {
    log.debug('Fetching conversation list from backend');
    setIsLoadingHistory(true);
    setHistoryError(null);
    let fetchedList: ConversationListItem[] = [];
    try {
      const response = await axios.get<ConversationListItem[]>('/v1/chat/conversations');
      fetchedList = response.data.sort((a, b) => b.updatedAt - a.updatedAt);
      setConversationList(fetchedList);
      log.info(`Fetched ${fetchedList.length} conversations for the list`);
    } catch (err) {
      log.error('Error fetching conversation list:', err);
      setHistoryError('Failed to load conversation history.');
      setConversationList([]); // Clear list on error
    } finally {
      setIsLoadingHistory(false);

      // --- Auto-selection logic ---
      const idToSelect = selectIdAfterFetch !== undefined ? selectIdAfterFetch : currentConversationId;

      if (idToSelect && fetchedList.some(c => c.id === idToSelect)) {
         // If the intended ID exists in the new list, ensure it's selected
         if (idToSelect !== currentConversationId) {
            log.debug(`Setting currentConversationId to ${idToSelect} after fetch/operation.`);
            setCurrentConversationId(idToSelect);
         }
      } else if (fetchedList.length > 0) {
         // If intended ID is invalid or null, select the most recent
         const mostRecentId = fetchedList[0].id;
         if (mostRecentId !== currentConversationId) {
            log.debug(`Selecting most recent conversation ${mostRecentId} after fetch/operation.`);
            setCurrentConversationId(mostRecentId);
         }
      } else {
         // No conversations left
         if (currentConversationId !== null) {
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
      const response = await axios.get<Conversation>(`/v1/chat/conversations/${id}`);
      // TODO: Adapt if backend returns SharedState - map it to Conversation type here if needed
      // For now, assume the GET endpoint returns the Conversation structure (or compatible)
      setDetailedConversation(response.data);
      log.info('Fetched detailed conversation successfully', { conversationId: id });
    } catch (err: any) { // Use any for error checking
       log.error('Error fetching detailed conversation:', { conversationId: id, err });
       if (axios.isAxiosError(err) && err.response?.status === 404) {
          setDetailsError(`Conversation ${id} not found.`);
          // Clear the invalid selection and refresh the list
          setCurrentConversationId(null);
          fetchConversations(); // Refresh list and auto-select valid one
       } else {
          setDetailsError(`Failed to load details for conversation ${id}.`);
       }
      setDetailedConversation(null);
    } finally {
      setIsLoadingDetails(false);
    }
  }, []); // No dependencies needed if it only uses the 'id' argument

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
      const response = await axios.post<ConversationListItem>('/v1/chat/conversations', payload);

      // Use the data returned from the backend for consistency
      const createdConversationSummary = response.data;
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
      if (axios.isAxiosError(err) && err.response?.data?.error) {
        errorMsg += ` Error: ${err.response.data.error}`;
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
      await axios.delete(`/v1/chat/conversations/${conversationId}`);
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
      const response = await axios.patch<ConversationListItem>(
        `/v1/chat/conversations/${currentConversationId}`,
        { flowId } // Send only the flowId in the body
      );

      const updatedSummaryFromServer = response.data;
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
      if (axios.isAxiosError(err) && err.response?.data?.error) {
        errorMsg += ` Error: ${err.response.data.error}`;
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

    // Create user message
    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined
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

  // Function to handle responses, including debug state
  const handleApiResponse = useCallback((response: AxiosResponse<any>, conversationId: string) => {
    const data = response.data;
    log.verbose('Handling API response data', JSON.stringify(data));

    // --- Check for Debug Paused State ---
    if (data.status === 'paused_debug' && data.debugState) {
      log.info('API Response: Paused for debugging', { conversationId });
      setDebugState(data.debugState as SharedState);
      setIsDebugPaused(true);
      setIsLoading(false); // Stop general loading indicator
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
      // Update conversation list status with type assertion
      setConversationList(prevList => prevList.map(c => c.id === conversationId ? { ...c, status: 'paused_debug' as ConversationListItem['status'], updatedAt: data.debugState.updatedAt } : c).sort((a, b) => b.updatedAt - a.updatedAt));
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
         if (prevDetailed?.id === conversationId) {
           // Compare validated messages
           const messagesChanged = JSON.stringify(prevDetailed.messages) !== JSON.stringify(validatedMessages);
           if (messagesChanged) {
             log.info('API Response/Polling: Updating detailed conversation messages', { conversationId, newMessageCount: validatedMessages.length });
             // Use updatedAt from response if available, otherwise keep existing
             return { ...prevDetailed, messages: validatedMessages, updatedAt: data.updatedAt || prevDetailed.updatedAt }; // Use validated messages
           }
         }
         return prevDetailed;
       });
    }

    // Update pending tool calls based on standard response/polling data
    if (data.status === 'awaiting_tool_approval') {
      log.info('API Response/Polling: Pausing for tool approval', { conversationId });
      setPendingToolCalls(data.pendingToolCalls || []);
      setIsLoading(false); // Stop loading indicator
      stopPolling();
    } else if (data.status === 'completed' || data.status === 'error') {
      log.info('API Response/Polling: Stopping due to final status', { conversationId, status: data.status });
      stopPolling();
      setIsLoading(false);
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

    // Update conversation list status from standard response/polling with type assertion
    if (data.status && data.conversation_id === conversationId) {
       setConversationList(prevList => prevList.map(c => c.id === conversationId ? { ...c, status: data.status as ConversationListItem['status'], updatedAt: data.updatedAt || c.updatedAt } : c).sort((a, b) => b.updatedAt - a.updatedAt));
    }

    return false; // Indicate standard response was handled
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setDetailedConversation, setPendingToolCalls, setIsLoading, setError, setIsDebugPaused, setDebugState, setConversationList, fetchDetailedConversation]);


  // Function to poll conversation state (Updates detailedConversation)
  const pollConversationState = useCallback(async (conversationId: string) => {
    // Stop polling if debug mode is active and paused
    if (isDebugPaused) {
        log.debug("Polling skipped: Debugger is paused.");
        stopPolling();
        return;
    }
    log.debug('Polling conversation state', { conversationId });
    try {
      // Use the GET endpoint which now returns the full Conversation structure
      const response = await axios.get<Conversation>(`/v1/chat/conversations/${conversationId}`);
      // Use the common handler
      handleApiResponse(response, conversationId);
    } catch (error: any) {
      log.error('Polling error:', error);
      stopPolling();
      setIsLoading(false);
      if (axios.isAxiosError(error) && error.response?.status === 404) {
         setError(`Conversation ${conversationId} not found during polling.`);
         // Optionally refresh list and clear selection
         // fetchConversations();
         // setCurrentConversationId(null);
      } else {
         setError('Connection error during update. Please retry.');
      }
    }
  }, [handleApiResponse, isDebugPaused]); // Add isDebugPaused dependency

  // Function to stop polling
  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      log.debug('Stopping polling interval');
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  };

  // Effect to manage polling based on isLoading and currentConversationId
  useEffect(() => {
    if (isLoading && currentConversationId) {
      // Start polling immediately and then set interval
      pollConversationState(currentConversationId);
      pollingIntervalRef.current = setInterval(() => {
        pollConversationState(currentConversationId);
      }, 2000); // Poll every 2 seconds
      log.debug('Polling started', { conversationId: currentConversationId });
    } else {
      // Stop polling if not loading or no conversation selected
      stopPolling();
    }

    // Cleanup function to stop polling when component unmounts or dependencies change
    return () => {
      stopPolling();
    };
  }, [isLoading, currentConversationId, pollConversationState]); // Rerun effect when isLoading or currentConversationId changes


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

      // --- Extract relevant data from completion and pass to handler ---
      // The completion object itself is not an AxiosResponse. We need to simulate
      // the structure handleApiResponse expects based on the completion data.
      const responseDataForHandler = {
          data: { // Simulate the 'data' property of AxiosResponse
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
          },
          // Simulate other AxiosResponse properties (likely not needed by handler)
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {}
      } as AxiosResponse<any>; // Cast to AxiosResponse for the handler

      const handledDebug = handleApiResponse(responseDataForHandler, conversation.id);

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
      } else if (axios.isAxiosError(err)) {
        errorMessage = `Network Error: ${err.message}`;
        if (err.response?.data?.error) {
          const apiError = err.response.data.error;
          errorMessage = apiError.message || errorMessage;
          if (apiError.code) errorMessage += ` (Code: ${apiError.code})`;
          if (apiError.type) errorMessage += ` [Type: ${apiError.type}]`;
          if (apiError.param) errorMessage += ` - Param: ${apiError.param}`;
          if (apiError.details) {
             try {
               const detailsStr = typeof apiError.details === 'string' ? apiError.details : JSON.stringify(apiError.details);
               errorMessage += `\nDetails: ${detailsStr}`;
             } catch (e) { /* ignore stringify error */ }
          }
          log.verbose('AxiosError backend details', JSON.stringify(apiError));
        } else if (err.response) {
          errorMessage += ` (Status: ${err.response.status})`;
        } else if (err.request) {
          errorMessage += ' (No response received)';
        }
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }
      setError(errorMessage);
      stopPolling();
      setIsLoading(false); // Stop loading on error

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
        const responseDataForHandler = {
          data: {
            ...(completion as any),
            status: (completion as any).status || 'completed',
            conversation_id: updatedDetailedConv.id,
            messages: (completion as any).messages || updatedDetailedConv.messages,
            pendingToolCalls: (completion as any).pendingToolCalls,
            debugState: (completion as any).debugState,
            error: (completion as any).error,
            updatedAt: (completion as any).updatedAt || Date.now()
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {}
        } as AxiosResponse<any>;

        handleApiResponse(responseDataForHandler, updatedDetailedConv.id);

      } catch (err) {
        log.error('Error sending edited message:', err);
        setError(err instanceof Error ? err.message : 'Failed to send edited message');
        setIsLoading(false);
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
    setError(null);

    try {
      // The POST endpoint should handle state updates and trigger continuation
      await axios.post(`/v1/chat/conversations/${currentConversationId}/respond`, {
        action,
        toolCallId,
      });
      log.debug(`Tool response successful`, { conversationId: currentConversationId, action, toolCallId });
      // Polling should resume automatically via the isLoading state change in useEffect

    } catch (err) {
      log.error(`Error sending tool response (${action})`, { conversationId: currentConversationId, toolCallId, err });
      let errorMessage = `Failed to ${action} tool call.`;
      if (axios.isAxiosError(err) && err.response?.data?.error) {
        errorMessage += ` Error: ${err.response.data.error}`;
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
    setError(null);
    try {
      const response = await axios.post(`/v1/chat/conversations/${currentConversationId}/debug/step`);
      handleApiResponse(response, currentConversationId); // Process the response (updates state, status)
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
    setError(null);
    setIsDebugPaused(false); // Assume we are exiting explicit pause
    setDebugState(null);
    try {
      const response = await axios.post(`/v1/chat/conversations/${currentConversationId}/debug/continue`);
      handleApiResponse(response, currentConversationId); // Process the response
      // Polling might restart via useEffect if status is 'running'
    } catch (err) {
      log.error('Error during debug continue API call', { conversationId: currentConversationId, err });
      setError(err instanceof Error ? err.message : 'Failed to continue execution.');
      setIsLoading(false); // Stop loading on error
    } finally {
       // setIsLoading(false); // Loading is stopped by handleApiResponse or polling
    }
  };

  // Handle Cancel Request (Also used by Debugger)
  const handleCancelRequest = async () => {
    if (!currentConversationId) return;
    log.info('Cancelling request', { conversationId: currentConversationId });

    stopPolling();
    setIsLoading(false);
    setPendingToolCalls(null);

    try {
      await axios.post(`/v1/chat/conversations/${currentConversationId}/cancel`);
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

              {/* Loading Indicator and Cancel Button */}
              {isLoading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', my: 2, gap: 2 }}>
                  <CircularProgress size={24} />
                  <Button
                    variant="outlined"
                    color="secondary"
                    size="small"
                    onClick={handleCancelRequest}
                    disabled={!currentConversationId}
                  >
                    Cancel
                  </Button>
                </Box>
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
            {/* Placeholder for DebuggerCanvas */}
            <Box sx={{ flex: 1, p: 2, overflow: 'auto', border: 1, borderColor: 'warning.main', borderRadius: 1, m: 1 }}>
               <Typography variant="h6">Debugger View</Typography>
               <Typography variant="body2">Conversation ID: {currentConversationId}</Typography>
               <Typography variant="body2">Status: {debugState.status}</Typography>
               <Typography variant="body2">Current Node: {debugState.currentNodeId}</Typography>
               <Typography variant="body2">Trace Steps: {debugState.executionTrace?.length || 0}</Typography>
               {/* Add Buttons */}
               <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
                   <Button variant="outlined" size="small" onClick={handleDebugStep} disabled={isLoading}>Next Step</Button>
                   <Button variant="contained" size="small" onClick={handleDebugContinue} disabled={isLoading}>Continue (Yolo)</Button>
                   <Button variant="outlined" color="secondary" size="small" onClick={handleCancelRequest} disabled={isLoading}>Cancel</Button>
                   {/* Add Previous button later */}
               </Box>
               {/* Add Trace List and Inspector later */}
               <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '400px', overflowY: 'auto', background: '#f0f0f0', padding: '8px', borderRadius: '4px', marginTop: '10px' }}>
                   {JSON.stringify(debugState.executionTrace?.slice(-1)[0], null, 2)} {/* Show last trace step */}
               </pre>
            </Box>
            {/* <DebuggerCanvas debugState={debugState} conversationId={currentConversationId} /> */}
          </Grid>
        )}
      </Grid> {/* End Main Content Grid */}
    </Box>
  );
};

export default Chat;
