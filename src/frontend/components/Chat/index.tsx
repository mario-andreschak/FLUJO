"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react'; // Added useCallback
import { Box, Paper, Typography, Divider, CircularProgress, Alert, Button } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useLocalStorage, StorageKey } from '@/utils/storage';
import ChatHistory from './ChatHistory';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import FlowSelector from './FlowSelector';
import Spinner from '@/frontend/components/shared/Spinner';
import { v4 as uuidv4 } from 'uuid';
import OpenAI, { OpenAIError, APIError } from 'openai'; // Import APIError
import { flowService } from '@/frontend/services/flow';
import { createLogger } from '@/utils/logger';
import axios from 'axios'; // Import axios for polling
import { ChatCompletionMetadata } from '@/shared/types'; // Import the shared type

const log = createLogger('frontend/components/Chat/index');

// Define types for our chat data
export interface Attachment {
  id: string;
  type: 'document' | 'audio';
  content: string;
  originalName?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  attachments?: Attachment[];
  disabled?: boolean;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

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
  status?: 'running' | 'awaiting_tool_approval' | 'completed' | 'error'; // Optional status from backend state
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
  const [flows, setFlows] = useState<any[]>([]); // Consider typing this if possible
  const [requireApproval, setRequireApproval] = useState<boolean>(false);
  const [pendingToolCalls, setPendingToolCalls] = useState<OpenAI.ChatCompletionMessageToolCall[] | null>(null);

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

  // Function to poll conversation state (Updates detailedConversation)
  const pollConversationState = useCallback(async (conversationId: string) => {
    log.debug('Polling conversation state', { conversationId });
    try {
      const response = await axios.get<Conversation>(`/v1/chat/conversations/${conversationId}`); // Expect full Conversation
      const data = response.data;

      log.verbose('Polling response data', JSON.stringify(data));

      // Update the detailed conversation state
      setDetailedConversation(prevDetailed => {
         // Only update if the fetched data is for the currently selected conversation
         if (prevDetailed?.id === conversationId) {
            // Check if messages or status actually changed to avoid unnecessary re-renders
            const messagesChanged = JSON.stringify(prevDetailed.messages) !== JSON.stringify(data.messages);
            // const statusChanged = prevDetailed.status !== data.status; // Need status on Conversation type
            // For now, update if messages changed
            if (messagesChanged) {
               log.info('Polling: Updating detailed conversation messages', { conversationId, newMessageCount: data.messages.length });
               return data; // Replace with new data
            }
            return prevDetailed; // No change detected
         }
         return prevDetailed; // Not the current conversation, ignore
      });

      // Update pending tool calls based on polled data
      // Assuming the backend response includes status and pendingToolCalls directly
      const backendState = data as any; // Use 'any' carefully to access potential backend-specific fields
      if (backendState.status === 'awaiting_tool_approval') {
        log.info('Polling: Pausing for tool approval', { conversationId });
        setPendingToolCalls(backendState.pendingToolCalls || []);
        stopPolling();
      } else if (backendState.status === 'completed' || backendState.status === 'error') {
        log.info('Polling: Stopping due to final status', { conversationId, status: backendState.status });
        stopPolling();
        setIsLoading(false);
        if (backendState.status === 'error' && backendState.lastResponse?.error) {
          setError(`Error during execution: ${backendState.lastResponse.error}`);
        }
      } else {
         // If status is running or something else, clear pending calls
         setPendingToolCalls(null);
      }
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
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [/* Include dependencies like setDetailedConversation if needed, but avoid conversations */]);

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
                conversationId: conversation.id // Pass the correct ID
            };
            const filteredMeta: Record<string, string> = {};
            if (meta.flujo) filteredMeta.flujo = meta.flujo;
            if (meta.requireApproval) filteredMeta.requireApproval = meta.requireApproval;
            if (meta.conversationId) filteredMeta.conversationId = meta.conversationId;
            return filteredMeta;
        })()
      });

      log.debug('Chat completion initial response received', { completionId: completion.id });
      success = true; // API call itself succeeded

      // Polling will handle message updates and final status.
      // Start polling if not already started (handled by useEffect based on isLoading)

      // Check if the completion response *immediately* indicates an error
      const responseData = completion as any;
      if (responseData.status === 'error' && responseData.lastResponse?.error) {
         log.warn('Completion response indicates error', { error: responseData.lastResponse.error });
         setError(`Error during execution: ${responseData.lastResponse.error}`);
         success = false; // Mark as failed if backend reports immediate error
         stopPolling(); // Stop polling if backend says it errored
         setIsLoading(false); // Stop loading indicator
      } else if (responseData.status === 'awaiting_tool_approval') {
         // If backend immediately requires approval, update state and stop polling
         log.info('Completion response requires tool approval', { conversationId: conversation.id });
         setPendingToolCalls(responseData.pendingToolCalls || []);
         stopPolling(); // Stop polling as backend is paused
         // Keep isLoading=true until user responds or polling confirms completion/error
      } else if (responseData.status === 'completed') {
         // If backend immediately completes, stop polling and loading
         log.info('Completion response indicates immediate completion', { conversationId: conversation.id });
         stopPolling();
         setIsLoading(false);
         // Fetch final state one last time? Polling might have missed the last update.
         await fetchDetailedConversation(conversation.id);
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
      // The polling useEffect or error handling should manage isLoading
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
  const handleEditMessage = async (messageId: string, newContent: string) => {
    if (!detailedConversation) return;
    log.debug('Editing message', { messageId, contentLength: newContent.length });

    const messageIndex = detailedConversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    const messageToEdit = detailedConversation.messages[messageIndex];
    const updatedMessage: ChatMessage = {
      ...messageToEdit,
      content: newContent,
      timestamp: Date.now()
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
      await sendToChatCompletions(updatedDetailedConv); // Re-send truncated conversation
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

  // Handle Cancel Request
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

      {/* Main chat area */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Flow selector - Use summary data */}
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <FlowSelector
            selectedFlowId={currentConversationSummary?.flowId || detailedConversation?.flowId || null} // Use summary first, fallback to detail
            onSelectFlow={handleFlowSelect}
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
            disabled={isLoadingDetails || isLoading || !(detailedConversation?.flowId || currentConversationSummary?.flowId) || !!pendingToolCalls}
            requireApproval={requireApproval}
            onRequireApprovalChange={setRequireApproval}
          />
        </Box>
      </Box>
    </Box>
  );
};

export default Chat;
