"use client";

import React, { useRef, useEffect, useMemo } from 'react';
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
  Divider,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Button,
  FormControl,
  InputLabel,
  Select,
  SelectChangeEvent
} from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import BlockIcon from '@mui/icons-material/Block';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import MicIcon from '@mui/icons-material/Mic';
// import BuildIcon from '@mui/icons-material/Build'; // Not used
// import CodeIcon from '@mui/icons-material/Code'; // Not used
// import CheckCircleIcon from '@mui/icons-material/CheckCircle'; // Not used
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HandymanIcon from '@mui/icons-material/Handyman';
import TerminalIcon from '@mui/icons-material/Terminal';
import EditIcon from '@mui/icons-material/Edit';
import ThumbUpIcon from '@mui/icons-material/ThumbUp'; // For Approve
import ThumbDownIcon from '@mui/icons-material/ThumbDown'; // For Reject
import { ChatMessage, Attachment } from './index';
import OpenAI from 'openai'; // Import OpenAI types for tool calls
import { FlujoChatMessage } from '@/shared/types/chat'; // Import shared type
import { createLogger } from '@/utils/logger'; // Import the logger

const log = createLogger('frontend/components/Chat/ChatMessages'); // Initialize logger

interface ChatMessagesProps {
  messages: ChatMessage[];
  pendingToolCalls?: OpenAI.ChatCompletionMessageToolCall[] | null; // Add pending calls prop
  availableNodes?: { id: string; label: string }[]; // Add available nodes for dropdown
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

const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  pendingToolCalls, // Destructure new prop
  availableNodes = [], // Destructure with default empty array
  onToggleDisabled,
  onSplitConversation,
  onEditMessage,
  onApproveToolCall, // Destructure new prop
  onRejectToolCall // Destructure new prop
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Message menu state
  const [menuAnchorEl, setMenuAnchorEl] = React.useState<null | HTMLElement>(null);
  const [activeMessageId, setActiveMessageId] = React.useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = React.useState<string | null>(null);
  const [isEditing, setIsEditing] = React.useState<boolean>(false);
  const [editContent, setEditContent] = React.useState<string>('');
  const [editNodeId, setEditNodeId] = React.useState<string | null>(null);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, messageId: string) => {
    // Log messageId directly
    log.debug(`handleMenuOpen called with messageId: ${messageId}`);
    setMenuAnchorEl(event.currentTarget);
    setActiveMessageId(messageId);
  };

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
        setEditNodeId(message.processNodeId || null);
        setEditingMessageId(activeMessageId);
        setIsEditing(true);
      }
      handleMenuClose();
    }
  };

  const handleSaveEdit = () => {
    if (editingMessageId && onEditMessage) {
      onEditMessage(editingMessageId, editContent, editNodeId);
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

  const handleNodeIdChange = (event: SelectChangeEvent) => {
    // Convert empty string to null, otherwise use the string value
    setEditNodeId(event.target.value === "" ? null : event.target.value);
  };

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

  // Find the active message *before* rendering the Menu
  // This avoids potential state timing issues within the IIFE
  const activeMsgForMenu = useMemo(() => {
    if (!activeMessageId) return null;
    return messages.find(m => m.id === activeMessageId) || null;
  }, [activeMessageId, messages]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Ensure messages is an array before mapping */}
      {Array.isArray(messages) && messages.map((message, index) => ( // Added index for potential fallback key
        <Box
          key={message.id || `msg-${index}`} // Use message.id as key, fallback to index if needed
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
            opacity: message.disabled ? 0.5 : 1,
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
              <Tooltip title={`Process Node ID: ${message.processNodeId}`}>
                <Chip
                  label={`Node: ${message.processNodeId.substring(0, 6)}...`}
                  size="small"
                  color="primary"
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

            <IconButton
              size="small"
              onClick={(e) => {
                // Log message.id directly in the onClick handler
                log.debug(`IconButton onClick - message.id: ${message.id}`);
                handleMenuOpen(e, message.id);
              }}
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
              // width: 'fit-content', // Removed to allow container to respect maxWidth better for wrapping
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
              whiteSpace: 'pre-wrap', // Preserve whitespace and wrap lines
              // wordWrap: 'break-word', // Redundant with overflowWrap
              overflow: 'hidden', // Prevent content from visually overflowing the paper
            }}
          >
            {isEditing && message.id === editingMessageId ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
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
                    value={editNodeId || ""}
                    label="Process Node"
                    onChange={handleNodeIdChange}
                  >
                    <MenuItem value=""><em>None</em></MenuItem>
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
                    onClick={handleCancelEdit}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleSaveEdit}
                  >
                    Save
                  </Button>
                </Box>
              </Box>
            ) : (
              <>
                {/* Render message content only if it's a string and not a tool message */}
                {message.role !== 'tool' && typeof message.content === 'string' && (
                  // Box removed, styles moved to Paper and ReactMarkdown components
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                      components={{
                        p: (props) => <Typography variant="body1" sx={{ mb: 0.5 }}>{props.children}</Typography>,
                        h1: (props) => <Typography variant="h5" sx={{ mt: 2, mb: 0.5 }}>{props.children}</Typography>,
                        h2: (props) => <Typography variant="h6" sx={{ mt: 2, mb: 0.5 }}>{props.children}</Typography>,
                        h3: (props) => <Typography variant="subtitle1" sx={{ mt: 1.5, mb: 0.5 }}>{props.children}</Typography>,
                        h4: (props) => <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>{props.children}</Typography>,
                        h5: (props) => <Typography variant="body1" sx={{ mt: 1, mb: 0.5, fontWeight: 'bold' }}>{props.children}</Typography>,
                        h6: (props) => <Typography variant="body2" sx={{ mt: 1, mb: 0.5, fontWeight: 'bold' }}>{props.children}</Typography>,
                        ul: (props) => <Box component="ul" sx={{ pl: 2, mb: 1 }}>{props.children}</Box>,
                        ol: (props) => <Box component="ol" sx={{ pl: 2, mb: 1 }}>{props.children}</Box>,
                        li: (props) => <Box component="li" sx={{ mb: 0.5 }}>{props.children}</Box>,
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
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  // Box removed
                )}
                {/* Fallback for non-string content (e.g., assistant message with only tool calls) */}
                {message.role !== 'tool' && typeof message.content !== 'string' && !hasToolCalls(message) && (
                   <Typography variant="body2" fontStyle="italic" color="text.secondary">
                     [No text content]
                   </Typography>
                )}
              </>
            )}

            {/* Display tool calls if any - use type guard */}
            {hasToolCalls(message) && message.tool_calls.length > 0 && (
              <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
                <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', color: 'primary.main', mb: 1 }}>
                  <HandymanIcon fontSize="small" sx={{ mr: 1 }} />
                  The assistant is using a tool
                </Typography>

                {message.tool_calls.map((toolCall, tcIndex) => { // Added index for key
                  const parts = toolCall.function.name.split('_-_-_');
                  const toolName = parts.length === 3 ? parts[2] : toolCall.function.name;
                  let formattedArgs = toolCall.function.arguments;
                  try {
                    const parsedArgs = JSON.parse(toolCall.function.arguments);
                    formattedArgs = JSON.stringify(parsedArgs, null, 2);
                  } catch (e) { /* Use original string */ }

                  return (
                    <Accordion
                      key={toolCall.id || `tc-${message.id}-${tcIndex}`} // Use toolCall.id as key
                      defaultExpanded={false}
                      sx={{ mb: 0.5, '&:before': { display: 'none' }, boxShadow: 'none', bgcolor: 'rgba(0, 0, 0, 0.04)' }}
                    >
                      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          <HandymanIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
                          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                            {toolName}
                          </Typography>
                          <Chip
                            label={`ID: ${toolCall.id ? toolCall.id.substring(0, 8) : 'N/A'}...`}
                            size="small" color="default" variant="outlined"
                            sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                          />
                        </Box>
                      </AccordionSummary>
                      <AccordionDetails sx={{ p: 0, pl: 2, pr: 2, pb: 1 }}>
                        <Box component="pre" sx={{
                          bgcolor: 'action.hover', p: 1, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace',
                          fontSize: '0.75rem', my: 0.5, maxHeight: '150px', whiteSpace: 'pre-wrap', // Ensure wrapping
                          wordBreak: 'break-word', // Ensure breaking
                        }}>
                          {formattedArgs}
                        </Box>
                      </AccordionDetails>
                    </Accordion>
                  );
                })}
              </Box>
            )}

            {/* Display tool call result for tool messages */}
            {message.role === 'tool' && message.tool_call_id && (
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
                    </Box>
                  </AccordionSummary>
                  {/* Add overflow: hidden to AccordionDetails */}
                  <AccordionDetails sx={{ overflow: 'hidden' }}>
                    {/* Re-introduce Box with width, minWidth, and wrapping styles */}
                    <Box sx={{ width: '100%', minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {/* Ensure content is string before rendering */}
                      {typeof message.content === 'string' ? (() => {
                        // Use simpler rendering logic, relying on Box styles
                        try {
                          const parsedContent = JSON.parse(message.content);
                          if (typeof parsedContent.content === 'string') {
                            // Render the 'content' field if it exists (structured result)
                            return <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsedContent.content}</ReactMarkdown>;
                          }
                          // Otherwise, render the stringified JSON
                          return <ReactMarkdown remarkPlugins={[remarkGfm]}>{`\`\`\`json\n${JSON.stringify(parsedContent, null, 2)}\n\`\`\``}</ReactMarkdown>;
                        } catch (e) {
                          // If parsing fails, render original string content as markdown
                          return <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>;
                        }
                      })() : (
                         <Typography variant="body2" fontStyle="italic" color="text.secondary">
                         [Invalid tool content]
                       </Typography>
                    )}
                    </Box> {/* Add missing closing Box tag */}
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
                ))}
              </Box>
            )}
          </Paper>
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
          // Fix log: Pass activeMessageId correctly using JSON.stringify
          log.debug('Entering menu item rendering logic', JSON.stringify({ activeMessageId: activeMessageId }));
          // --- Added Detailed Logging ---
          log.debug('Active message object for menu:', JSON.stringify(activeMsgForMenu));
          log.debug('Active message role for menu:', activeMsgForMenu?.role);
          // --- End Detailed Logging ---
          try {
            const hasOnEditMessageProp = !!onEditMessage;
            const shouldShowEdit = activeMsgForMenu.role === 'user' && hasOnEditMessageProp;

            // Fix log: Use JSON.stringify for the object
            log.debug('Rendering Edit Message menu item check', JSON.stringify({
              activeMessageId: activeMsgForMenu.id, // Use ID from the message object
              messageRole: activeMsgForMenu.role,
              onEditMessagePropType: typeof onEditMessage,
              hasOnEditMessageProp: hasOnEditMessageProp,
              shouldShowEdit
            }));

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

      {/* Invisible element to scroll to */}
      <div ref={messagesEndRef} />

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
            const parts = toolCall.function.name.split('_-_-_');
            const toolName = parts.length === 3 ? parts[2] : toolCall.function.name;
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
