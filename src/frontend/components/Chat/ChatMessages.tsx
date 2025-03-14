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
  Button
} from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import BlockIcon from '@mui/icons-material/Block';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import MicIcon from '@mui/icons-material/Mic';
import BuildIcon from '@mui/icons-material/Build';
import CodeIcon from '@mui/icons-material/Code';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HandymanIcon from '@mui/icons-material/Handyman';
import TerminalIcon from '@mui/icons-material/Terminal';
import EditIcon from '@mui/icons-material/Edit';
import { ChatMessage } from './index';

interface ChatMessagesProps {
  messages: ChatMessage[];
  onToggleDisabled: (messageId: string) => void;
  onSplitConversation: (messageId: string) => void;
  onEditMessage?: (messageId: string, content: string) => void;
}

const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  onToggleDisabled,
  onSplitConversation,
  onEditMessage
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
  
  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, messageId: string) => {
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
      if (message && message.role === 'user') {
        setEditContent(message.content);
        setEditingMessageId(activeMessageId);
        setIsEditing(true);
      }
      handleMenuClose();
    }
  };
  
  const handleSaveEdit = () => {
    if (editingMessageId && onEditMessage) {
      onEditMessage(editingMessageId, editContent);
      setIsEditing(false);
      setEditingMessageId(null);
    }
  };
  
  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditingMessageId(null);
  };
  
  // Format timestamp
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    });
  };
  
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {messages.map((message) => (
        <Box
          key={message.id}
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
              onClick={(e) => handleMenuOpen(e, message.id)}
              sx={{ ml: 1 }}
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Box>
          
          <Paper
            elevation={1}
            sx={{
              p: 2,
              maxWidth: '80%',
              width: 'fit-content',
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
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
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
                {message.role !== 'tool' && (
                  <Box sx={{ 
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word'
                  }}>
                    <ReactMarkdown 
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: (props) => <Typography variant="body1" sx={{ mb: 1 }}>{props.children}</Typography>,
                        h1: (props) => <Typography variant="h5" sx={{ mt: 2, mb: 1 }}>{props.children}</Typography>,
                        h2: (props) => <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>{props.children}</Typography>,
                        h3: (props) => <Typography variant="subtitle1" sx={{ mt: 1.5, mb: 1 }}>{props.children}</Typography>,
                        h4: (props) => <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 1 }}>{props.children}</Typography>,
                        h5: (props) => <Typography variant="body1" sx={{ mt: 1, mb: 1, fontWeight: 'bold' }}>{props.children}</Typography>,
                        h6: (props) => <Typography variant="body2" sx={{ mt: 1, mb: 1, fontWeight: 'bold' }}>{props.children}</Typography>,
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
                          // Check if this is an inline code block
                          const match = /language-(\w+)/.exec(className || '');
                          const isInline = !match && !className;
                          
                          return isInline ? 
                            <Typography component="code" sx={{ 
                              bgcolor: 'action.hover', 
                              px: 0.5, 
                              py: 0.25, 
                              borderRadius: '4px',
                              fontFamily: 'monospace'
                            }}>{children}</Typography> :
                            <Box component="pre" sx={{ 
                              bgcolor: 'action.hover',
                              p: 1.5,
                              borderRadius: '4px',
                              overflowX: 'auto',
                              fontFamily: 'monospace',
                              fontSize: '0.875rem',
                              my: 1
                            }}>{children}</Box>
                        }
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  </Box>
                )}
              </>
            )}
            
            {/* Display tool calls if any */}
            {message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0 && (
              <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
                <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', color: 'primary.main', mb: 1 }}>
                  <HandymanIcon fontSize="small" sx={{ mr: 1 }} />
                  The assistant is using a tool
                </Typography>
                
                {message.tool_calls.map((toolCall) => {
                  // Extract tool name from the function name
                  // Format is "_-_-_serverName_-_-_toolName"
                  const parts = toolCall.function.name.split('_-_-_');
                  const toolName = parts.length === 3 ? parts[2] : toolCall.function.name;
                  
                  // Try to parse the arguments as JSON
                  let formattedArgs = toolCall.function.arguments;
                  try {
                    const parsedArgs = JSON.parse(toolCall.function.arguments);
                    formattedArgs = JSON.stringify(parsedArgs, null, 2);
                  } catch (e) {
                    // If parsing fails, use the original string
                  }
                  
                  return (
                    <Accordion 
                      key={toolCall.id} 
                      defaultExpanded={false}
                      sx={{ 
                        mb: 0.5,
                        '&:before': { display: 'none' },
                        boxShadow: 'none',
                        bgcolor: 'rgba(0, 0, 0, 0.04)',
                      }}
                    >
                      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          <HandymanIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
                          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                            {toolName}
                          </Typography>
                          <Chip 
                            label={`ID: ${toolCall.id.substring(0, 8)}...`}
                            size="small" 
                            color="default" 
                            variant="outlined" 
                            sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                          />
                        </Box>
                      </AccordionSummary>
                      <AccordionDetails sx={{ p: 0, pl: 2, pr: 2, pb: 1 }}>
                        <Box 
                          component="pre" 
                          sx={{ 
                            bgcolor: 'action.hover',
                            p: 1,
                            borderRadius: '4px',
                            overflowX: 'auto',
                            fontFamily: 'monospace',
                            fontSize: '0.75rem',
                            my: 0.5,
                            maxHeight: '150px'
                          }}
                        >
                          {formattedArgs}
                        </Box>
                      </AccordionDetails>
                    </Accordion>
                  );
                })}
              </Box>
            )}
            
            {/* Display tool call ID for tool messages */}
            {message.role === 'tool' && message.tool_call_id && (
              <Box>
                <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary', mb: 1 }}>
                  <TerminalIcon fontSize="small" sx={{ mr: 1 }} />
                  The tool responded to the assistant
                </Typography>
                
                <Accordion 
                  defaultExpanded={false} // dont Auto-expand the tool result
                  sx={{ 
                    mb: 0.5,
                    '&:before': { display: 'none' },
                    boxShadow: 'none',
                    bgcolor: 'rgba(0, 0, 0, 0.02)',
                  }}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <TerminalIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
                      <Typography variant="subtitle2">
                        Tool Result
                      </Typography>
                      <Chip 
                        label={`ID: ${message.tool_call_id.substring(0, 8)}...`}
                        size="small" 
                        color="default" 
                        variant="outlined" 
                        sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                      />
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Box sx={{ 
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      overflowWrap: 'break-word'
                    }}>
                      {(() => {
                        // Parse tool response content which can be in different formats
                        try {
                          // Try to parse as JSON first
                          const parsedContent = JSON.parse(message.content);
                          
                          // Case 1: Simple string content format: {"content":"This is the result"}
                          if (typeof parsedContent.content === 'string') {
                            return (
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {parsedContent.content}
                              </ReactMarkdown>
                            );
                          }
                          
                          // Case 2: Content object format: {"content":[{"type":"text","text":"Hello..."}]}
                          else if (Array.isArray(parsedContent.content)) {
                            return (
                              <>
                                {parsedContent.content.map((item: any, index: number) => {
                                  if (item.type === 'text') {
                                    return (
                                      <ReactMarkdown key={index} remarkPlugins={[remarkGfm]}>
                                        {item.text}
                                      </ReactMarkdown>
                                    );
                                  } else if (item.type === 'image_url' && item.image_url) {
                                    return (
                                      <Box key={index} sx={{ mt: 1, mb: 1 }}>
                                        <img 
                                          src={item.image_url.url} 
                                          alt={item.image_url.detail || "Image"} 
                                          style={{ maxWidth: '100%', borderRadius: '4px' }}
                                        />
                                      </Box>
                                    );
                                  } else if (item.type === 'image_file' && item.image_file) {
                                    return (
                                      <Box key={index} sx={{ mt: 1, mb: 1 }}>
                                        <Typography variant="caption" color="text.secondary">
                                          Image file: {item.image_file.file_id}
                                        </Typography>
                                      </Box>
                                    );
                                  }
                                  return null;
                                })}
                              </>
                            );
                          }
                          
                          // Case 3: Image URL format
                          else if (parsedContent.image_url) {
                            return (
                              <Box sx={{ mt: 1, mb: 1 }}>
                                <img 
                                  src={parsedContent.image_url.url} 
                                  alt={parsedContent.image_url.detail || "Image"} 
                                  style={{ maxWidth: '100%', borderRadius: '4px' }}
                                />
                              </Box>
                            );
                          }
                          
                          // Case 4: Refusal
                          else if (parsedContent.refusal) {
                            return (
                              <Typography color="error.main">
                                {parsedContent.refusal}
                              </Typography>
                            );
                          }
                          
                          // Fallback: Display the stringified JSON if we can't determine the format
                          return (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {JSON.stringify(parsedContent, null, 2)}
                            </ReactMarkdown>
                          );
                        } catch (e) {
                          // If parsing fails, use the original content
                          return (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {message.content}
                            </ReactMarkdown>
                          );
                        }
                      })()}
                    </Box>
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
                    sx={{ 
                      display: 'flex', 
                      alignItems: 'center',
                      p: 1,
                      borderRadius: 1,
                      bgcolor: 'rgba(0, 0, 0, 0.04)',
                      mb: 0.5
                    }}
                  >
                    {attachment.type === 'document' ? (
                      <AttachFileIcon fontSize="small" sx={{ mr: 1 }} />
                    ) : (
                      <MicIcon fontSize="small" sx={{ mr: 1 }} />
                    )}
                    <Typography variant="caption" noWrap>
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
        {activeMessageId && messages.find(m => m.id === activeMessageId)?.role === 'user' && onEditMessage && (
          <MenuItem onClick={handleStartEditing}>
            <ListItemIcon>
              <EditIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Edit Message</ListItemText>
          </MenuItem>
        )}
        <MenuItem onClick={handleToggleDisabled}>
          <ListItemIcon>
            <BlockIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>
            {messages.find(m => m.id === activeMessageId)?.disabled
              ? 'Enable Message'
              : 'Disable Message'}
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={handleSplitConversation}>
          <ListItemIcon>
            <CallSplitIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Split Conversation Here</ListItemText>
        </MenuItem>
      </Menu>
      
      {/* Invisible element to scroll to */}
      <div ref={messagesEndRef} />
    </Box>
  );
};

export default ChatMessages;
