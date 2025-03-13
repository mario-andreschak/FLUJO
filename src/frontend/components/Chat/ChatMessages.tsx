"use client";

import React, { useRef, useEffect } from 'react';
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
  Divider
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
import { ChatMessage } from './index';

interface ChatMessagesProps {
  messages: ChatMessage[];
  onToggleDisabled: (messageId: string) => void;
  onSplitConversation: (messageId: string) => void;
}

const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  onToggleDisabled,
  onSplitConversation
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  
  // Message menu state
  const [menuAnchorEl, setMenuAnchorEl] = React.useState<null | HTMLElement>(null);
  const [activeMessageId, setActiveMessageId] = React.useState<string | null>(null);
  
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
                : message.role === 'assistant' 
                  ? 'background.paper'
                  : message.role === 'tool'
                    ? 'success.light'
                    : 'info.light',
              color: message.role === 'user' 
                ? 'primary.contrastText' 
                : message.role === 'assistant'
                  ? 'text.primary'
                  : message.role === 'tool'
                    ? 'success.contrastText'
                    : 'info.contrastText',
              position: 'relative',
              borderLeft: message.role === 'tool' ? '4px solid' : 'none',
              borderColor: message.role === 'tool' ? 'success.main' : 'transparent',
            }}
          >
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
            
            {/* Display tool calls if any */}
            {message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0 && (
              <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                  Tool Calls:
                </Typography>
                
                {message.tool_calls.map((toolCall) => {
                  // Extract tool name from the function name
                  // Format is "-_-_-serverName-_-_-toolName"
                  const parts = toolCall.function.name.split('-_-_-');
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
                    <Box 
                      key={toolCall.id} 
                      sx={{ 
                        p: 1,
                        borderRadius: 1,
                        bgcolor: 'rgba(0, 0, 0, 0.04)',
                        mb: 0.5
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
                        <BuildIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
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
                    </Box>
                  );
                })}
              </Box>
            )}
            
            {/* Display tool call ID for tool messages */}
            {message.role === 'tool' && message.tool_call_id && (
              <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <CheckCircleIcon fontSize="small" sx={{ mr: 1, color: 'success.main' }} />
                  <Typography variant="caption" color="text.secondary">
                    Tool Result for call ID: {message.tool_call_id.substring(0, 8)}...
                  </Typography>
                </Box>
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
