"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Box, Paper, Typography, Divider, CircularProgress, Alert, Button } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useLocalStorage, StorageKey } from '@/utils/storage';
import ChatHistory from './ChatHistory';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import FlowSelector from './FlowSelector';
import Spinner from '@/frontend/components/shared/Spinner';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { flowService } from '@/frontend/services/flow';
import { createLogger } from '@/utils/logger';

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

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  flowId: string | null;
  createdAt: number;
  updatedAt: number;
}

const Chat: React.FC = () => {
  // State for conversations and current conversation
  const [conversations, setConversations, isLoadingHistory] = useLocalStorage<Conversation[]>(
    StorageKey.CHAT_HISTORY,
    []
  );
  const [currentConversationId, setCurrentConversationId] = useLocalStorage<string | null>(
    StorageKey.CURRENT_CONVERSATION_ID,
    null
  );
  const [selectedFlowId, setSelectedFlowId] = useLocalStorage<string | null>(
    StorageKey.SELECTED_FLOW_ID,
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flows, setFlows] = useState<any[]>([]);
  
  // OpenAI client reference
  const openaiRef = useRef<OpenAI | null>(null);
  
  // Initialize OpenAI client
  useEffect(() => {
    // Create OpenAI client with custom baseURL
    const baseURL = window.location.origin + '/v1';
    
    openaiRef.current = new OpenAI({
      baseURL,
      apiKey: 'FLUJO',
      dangerouslyAllowBrowser: true, // Required for client-side usage
    });
  }, []);
  
  // Get current conversation
  const currentConversation = conversations.find(
    (conv) => conv.id === currentConversationId
  ) || null;
  
  // Create a new conversation
  const createNewConversation = () => {
    log.debug('Creating new conversation');
    const newConversation: Conversation = {
      id: uuidv4(),
      title: 'New Conversation',
      messages: [],
      flowId: selectedFlowId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    setConversations([...conversations, newConversation]);
    setCurrentConversationId(newConversation.id);
    return newConversation;
  };
  
  // Load available flows
  useEffect(() => {
    const loadFlows = async () => {
      log.debug('Loading flows');
      try {
        const loadedFlows = await flowService.loadFlows();
        setFlows(loadedFlows);
        
        // If no flow is selected but flows exist, select the first one
        if (!selectedFlowId && loadedFlows.length > 0) {
          log.debug('Setting default flow', { flowId: loadedFlows[0].id });
          setSelectedFlowId(loadedFlows[0].id);
        }
      } catch (error) {
        log.error('Error loading flows:', error);
      }
    };
    
    loadFlows();
  }, [selectedFlowId, setSelectedFlowId]);
  
  // Initialize with the most recent conversation if one exists
  useEffect(() => {
    if (!isLoadingHistory && conversations.length > 0 && !currentConversationId) {
      // Select the most recent conversation
      const mostRecentConversation = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      log.debug('Setting most recent conversation', { conversationId: mostRecentConversation.id });
      setCurrentConversationId(mostRecentConversation.id);
    }
  }, [conversations, currentConversationId, isLoadingHistory, setCurrentConversationId]);
  
  // Update conversation title based on first message
  useEffect(() => {
    if (currentConversation && currentConversation.title === 'New Conversation' && currentConversation.messages.length > 0) {
      const firstUserMessage = currentConversation.messages.find(m => m.role === 'user');
      if (firstUserMessage) {
        // Create a title from the first few words of the first message
        const title = firstUserMessage.content.split(' ').slice(0, 5).join(' ') + '...';
        log.debug('Updating conversation title', { conversationId: currentConversation.id, title });
        updateConversation({
          ...currentConversation,
          title
        });
      }
    }
  }, [currentConversation]);
  
  // Update conversation
  const updateConversation = (updatedConversation: Conversation) => {
    log.debug('Updating conversation', { conversationId: updatedConversation.id });
    const updatedWithTimestamp = {
      ...updatedConversation,
      updatedAt: Date.now()
    };
    
    setConversations(
      conversations.map((conv) =>
        conv.id === updatedConversation.id
          ? updatedWithTimestamp
          : conv
      )
    );
  };
  
  // Delete conversation
  const deleteConversation = (conversationId: string) => {
    log.debug('Deleting conversation', { conversationId });
    setConversations(conversations.filter((conv) => conv.id !== conversationId));
    
    // If we deleted the current conversation, select another one
    if (currentConversationId === conversationId) {
      const remainingConversations = conversations.filter(
        (conv) => conv.id !== conversationId
      );
      
      if (remainingConversations.length > 0) {
        // Sort by updatedAt to get the most recent conversation
        const sortedConversations = [...remainingConversations].sort((a, b) => b.updatedAt - a.updatedAt);
        log.debug('Setting new current conversation after delete', { conversationId: sortedConversations[0].id });
        setCurrentConversationId(sortedConversations[0].id);
      } else {
        // Don't automatically create a new conversation, just set to null
        log.debug('No conversations left after delete');
        setCurrentConversationId(null);
      }
    }
  };
  
  // Handle flow selection
  const handleFlowSelect = (flowId: string) => {
    log.debug('Flow selected', { flowId });
    setSelectedFlowId(flowId);
    
    // Update current conversation with selected flow
    if (currentConversation) {
      updateConversation({
        ...currentConversation,
        flowId
      });
    }
  };
  
  // Handle sending a message
  const handleSendMessage = async (content: string, attachments: Attachment[] = []) => {
    if (!content.trim() && attachments.length === 0) return;
    
    log.debug('Sending message', { contentLength: content.length, attachmentsCount: attachments.length });
    
    // Get or create conversation
    let conversation = currentConversation;
    if (!conversation) {
      // Create a new conversation only when sending a message
      conversation = createNewConversation();
    }
    
    // Create user message
    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined
    };
    
    // Add user message to conversation
    const updatedMessages = [...conversation.messages, userMessage];
    const updatedConversation = {
      ...conversation,
      messages: updatedMessages,
      flowId: selectedFlowId || conversation.flowId
    };
    
    updateConversation(updatedConversation);
    
    // Send to API if a flow is selected
    if (updatedConversation.flowId) {
      await sendToChatCompletions(updatedConversation);
    } else {
      setError('Please select a flow before sending messages');
    }
  };
  
  // Send conversation to chat completions API
  const sendToChatCompletions = async (conversation: Conversation) => {
    if (!conversation.flowId || !openaiRef.current) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Look up the flow by ID to get its name
      const flow = await flowService.getFlow(conversation.flowId);
      
      if (!flow) {
        throw new Error(`Flow with ID ${conversation.flowId} not found`);
      }
      
      log.debug('Sending to chat completions', { flowId: conversation.flowId, flowName: flow.name });
      
      // Prepare messages for the API
      // Filter out disabled messages and format attachments
      const messages = conversation.messages
        .filter(msg => !msg.disabled)
        .map(msg => {
          let content = msg.content;
          
          // Add attachments to content if they exist
          if (msg.attachments && msg.attachments.length > 0) {
            content += '\n\n' + msg.attachments.map(att => 
              `[${att.type.toUpperCase()}]: ${att.content}`
            ).join('\n\n');
          }
          
          // Create properly typed message based on role
          if (msg.role === 'user') {
            return {
              role: 'user',
              content
            } as OpenAI.ChatCompletionUserMessageParam;
          } else if (msg.role === 'assistant') {
            return {
              role: 'assistant',
              content,
              tool_calls: msg.tool_calls
            } as OpenAI.ChatCompletionAssistantMessageParam;
          } else if (msg.role === 'system') {
            return {
              role: 'system',
              content
            } as OpenAI.ChatCompletionSystemMessageParam;
          } else if (msg.role === 'tool') {
            if (!msg.tool_call_id) {
              // If missing tool_call_id, convert to user message
              return {
                role: 'user',
                content: `Tool result: ${content}`
              } as OpenAI.ChatCompletionUserMessageParam;
            }
            return {
              role: 'tool',
              content,
              tool_call_id: msg.tool_call_id
            } as OpenAI.ChatCompletionToolMessageParam;
          }
          
          // Fallback to user message
          return {
            role: 'user',
            content
          } as OpenAI.ChatCompletionUserMessageParam;
        });
      
      // Call the API using flow name instead of ID
      const completion = await openaiRef.current.chat.completions.create({
        model: `flow-${flow.name}`, // Use flow-[FlowName] as model
        messages,
        stream: false,
      });
      
      // Get the response message from the completion
      const responseMessage = completion.choices[0].message;
      
      // Log the full response for debugging
      log.debug('Chat completion response:', { 
        responseMessage,
        hasToolCalls: responseMessage.tool_calls && responseMessage.tool_calls.length > 0
      });
      
      // Start with the existing conversation messages
      let updatedMessages = [...conversation.messages];
      
      // Check if the response contains a custom property with all messages from the flow execution
      // This would be available if we've modified our backend to include it
      const responseData = completion as any;
      
      if (responseData && responseData.messages && Array.isArray(responseData.messages)) {
        // We have messages from the flow execution in the response
        log.info('Found flow execution messages in response', { 
          messageCount: responseData.messages.length 
        });
        
        // Get the last user message index to know where to insert new messages
        const lastUserMsgIndex = updatedMessages.findLastIndex(msg => msg.role === 'user');
        
        if (lastUserMsgIndex !== -1) {
          // Keep messages up to and including the last user message
          updatedMessages = updatedMessages.slice(0, lastUserMsgIndex + 1);
          
          // Find the index of the last user message in the response messages
          const responseLastUserIndex = responseData.messages.findLastIndex((msg: any) => msg.role === 'user');
          
          if (responseLastUserIndex !== -1) {
            // Only add messages that come after the last user message in the response
            // This ensures we only add new messages and not duplicate old ones
            responseData.messages.slice(responseLastUserIndex + 1).forEach((msg: any) => {
              if (msg.role !== 'user') { // Skip user messages as we already have them
                const newMessage: ChatMessage = {
                  id: uuidv4(),
                  role: msg.role as 'assistant' | 'system' | 'tool',
                  content: typeof msg.content === 'string' ? msg.content : '',
                  timestamp: Date.now(),
                  tool_calls: msg.tool_calls,
                  tool_call_id: msg.tool_call_id
                };
                updatedMessages.push(newMessage);
              }
            });
          }
        }
      } else {
        // No flow execution messages, just use the standard OpenAI response
        // Create a new assistant message from the response
        const assistantMessage: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: responseMessage.content || '',
          timestamp: Date.now(),
          tool_calls: responseMessage.tool_calls
        };
        
        // Add the assistant message to our conversation
        updatedMessages.push(assistantMessage);
        
        // If there are tool calls in the response, add tool result messages
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
          log.info('Tool calls found in response', { 
            toolCallsCount: responseMessage.tool_calls.length,
            toolCalls: JSON.stringify(responseMessage.tool_calls)
          });
          
          // For each tool call, add a tool message with the result
          // In a real implementation, you would process the tool calls and get actual results
          responseMessage.tool_calls.forEach(toolCall => {
            const toolResultMessage: ChatMessage = {
              id: uuidv4(),
              role: 'tool',
              content: `Result for tool call: ${toolCall.function.name}`,
              timestamp: Date.now(),
              tool_call_id: toolCall.id
            };
            
            updatedMessages.push(toolResultMessage);
          });
        }
      }
      
      const updatedConversation = {
        ...conversation,
        messages: updatedMessages
      };
      
      updateConversation(updatedConversation);
    } catch (err) {
      log.error('Error calling chat completions:', err);
      
      // Extract detailed error information if available
      let errorMessage = 'An error occurred while sending the message';
      
      if (err instanceof Error) {
        errorMessage = err.message;
        
        // Check if this is an Axios error with a response
        if ('response' in err && err.response) {
          const responseData = (err as any).response.data;
          
          // Extract detailed error information from the response
          if (responseData && responseData.error) {
            const apiError = responseData.error;
            
            // Format a more detailed error message
            errorMessage = apiError.message || errorMessage;
            
            // Add error code if available
            if (apiError.code) {
              errorMessage += ` (Code: ${apiError.code})`;
            }
            
            // Add error type if available and different from code
            if (apiError.type && apiError.type !== apiError.code) {
              errorMessage += ` [Type: ${apiError.type}]`;
            }
            
            // Add parameter information if available
            if (apiError.param) {
              errorMessage += ` - Parameter: ${apiError.param}`;
            }
            
            // Add details if available
            if (apiError.details) {
              try {
                const detailsStr = typeof apiError.details === 'string' 
                  ? apiError.details 
                  : JSON.stringify(apiError.details);
                errorMessage += `\nDetails: ${detailsStr}`;
              } catch (e) {
                // Ignore stringify errors
              }
            }
          }
        }
      }
      
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };
  
  // Toggle message disabled state
  const toggleMessageDisabled = (messageId: string) => {
    if (!currentConversation) return;
    
    log.debug('Toggling message disabled state', { messageId });
    
    const updatedMessages = currentConversation.messages.map(msg => 
      msg.id === messageId ? { ...msg, disabled: !msg.disabled } : msg
    );
    
    updateConversation({
      ...currentConversation,
      messages: updatedMessages
    });
  };
  
  // Edit a message and re-send the conversation
  const handleEditMessage = async (messageId: string, newContent: string) => {
    if (!currentConversation) return;
    
    log.debug('Editing message', { messageId, contentLength: newContent.length });
    
    // Find the index of the message to edit
    const messageIndex = currentConversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;
    
    // Get the message to edit
    const messageToEdit = currentConversation.messages[messageIndex];
    
    // Create updated message with new content
    const updatedMessage: ChatMessage = {
      ...messageToEdit,
      content: newContent,
      timestamp: Date.now() // Update timestamp to show it was edited
    };
    
    // Get messages up to and including the edited message
    const messagesUpToEdit = [
      ...currentConversation.messages.slice(0, messageIndex),
      updatedMessage
    ];
    
    // Update conversation with truncated messages
    const updatedConversation = {
      ...currentConversation,
      messages: messagesUpToEdit
    };
    
    updateConversation(updatedConversation);
    
    // Re-send the conversation if a flow is selected
    if (updatedConversation.flowId) {
      await sendToChatCompletions(updatedConversation);
    }
  };
  
  // Split conversation at a message
  const splitConversationAtMessage = (messageId: string) => {
    if (!currentConversation) return;
    
    log.debug('Splitting conversation at message', { messageId });
    
    // Find the index of the message
    const messageIndex = currentConversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;
    
    // Get messages before the split point
    const messagesBeforeSplit = currentConversation.messages.slice(0, messageIndex + 1);
    
    // Create a new conversation with the messages before the split
    const newConversation: Conversation = {
      id: uuidv4(),
      title: `Split from ${currentConversation.title}`,
      messages: messagesBeforeSplit,
      flowId: currentConversation.flowId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    setConversations([...conversations, newConversation]);
    setCurrentConversationId(newConversation.id);
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
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <Spinner size="medium" color="primary" />
          </Box>
        ) : (
          <ChatHistory 
            conversations={conversations}
            currentConversationId={currentConversationId}
            onSelectConversation={setCurrentConversationId}
            onDeleteConversation={deleteConversation}
            onNewConversation={createNewConversation}
          />
        )}
      </Box>
      
      {/* Main chat area */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Flow selector */}
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <FlowSelector 
            selectedFlowId={currentConversation?.flowId || selectedFlowId}
            onSelectFlow={handleFlowSelect}
          />
        </Box>
        
        {/* Chat messages */}
        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          {currentConversation ? (
            <>
              <ChatMessages 
                messages={currentConversation.messages}
                onToggleDisabled={toggleMessageDisabled}
                onSplitConversation={splitConversationAtMessage}
                onEditMessage={handleEditMessage}
              />
              
              {isLoading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
                  <CircularProgress size={24} />
                </Box>
              )}
              
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
                        if (currentConversation) {
                          sendToChatCompletions(currentConversation);
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
            <Typography variant="body1" color="textSecondary" align="center" sx={{ mt: 4 }}>
              {conversations.length > 0 
                ? "Select a conversation from the sidebar or create a new one to start chatting"
                : "Create a new conversation to start chatting"}
            </Typography>
          )}
        </Box>
        
        {/* Chat input */}
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
          <ChatInput 
            onSendMessage={handleSendMessage}
            disabled={isLoading || (!currentConversation && !selectedFlowId)}
          />
        </Box>
      </Box>
    </Box>
  );
};

export default Chat;
