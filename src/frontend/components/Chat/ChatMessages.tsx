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
  Chip
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import BlockIcon from '@mui/icons-material/Block';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import MicIcon from '@mui/icons-material/Mic';
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
              {message.role === 'user' ? 'You' : 'Assistant'} • {formatTime(message.timestamp)}
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
              borderRadius: 2,
              bgcolor: message.role === 'user' ? 'primary.light' : 'background.paper',
              color: message.role === 'user' ? 'primary.contrastText' : 'text.primary',
              position: 'relative',
            }}
          >
            <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
              {message.content}
            </Typography>
            
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
