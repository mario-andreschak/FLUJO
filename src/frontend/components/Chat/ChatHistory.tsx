"use client";

import React from 'react';
import { 
  Box, 
  List, 
  ListItem, 
  ListItemButton, 
  ListItemText, 
  IconButton, 
  Typography, 
  Divider,
  Button,
  Tooltip
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { ConversationListItem } from './index'; // Import ConversationListItem instead

interface ChatHistoryProps {
  conversations: ConversationListItem[]; // Use ConversationListItem[]
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewConversation: () => void;
}

const ChatHistory: React.FC<ChatHistoryProps> = ({
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation
}) => {
  // Format date for display
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Get color based on conversation status
  const getStatusColor = (status?: ConversationListItem['status']) => {
    switch (status) {
      case 'running': return 'primary.main';
      case 'awaiting_tool_approval': return 'warning.main';
      case 'paused_debug': return 'secondary.main';
      case 'completed': return 'success.main';
      case 'error': return 'error.main';
      default: return 'transparent';
    }
  };

  // Get status description for tooltip
  const getStatusDescription = (status?: ConversationListItem['status']) => {
    switch (status) {
      case 'running': return 'Processing';
      case 'awaiting_tool_approval': return 'Waiting for tool approval';
      case 'paused_debug': return 'Paused in debug mode';
      case 'completed': return 'Completed';
      case 'error': return 'Error';
      default: return '';
    }
  };

  return (
    <>
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="h6">Conversations</Typography>
        <Button 
          variant="contained" 
          color="primary" 
          startIcon={<AddIcon />}
          onClick={onNewConversation}
          size="small"
        >
          New
        </Button>
      </Box>
      
      <Divider />
      
      <List sx={{ overflow: 'auto', flex: 1 }}>
        {conversations.length === 0 ? (
          <ListItem>
            <ListItemText 
              primary="No conversations yet" 
              secondary="Start a new conversation" 
              primaryTypographyProps={{ align: 'center' }}
              secondaryTypographyProps={{ align: 'center' }}
            />
          </ListItem>
        ) : (
          conversations
            .sort((a, b) => b.updatedAt - a.updatedAt) // Sort by most recent
            .map((conversation) => (
              <ListItem 
                key={conversation.id}
                disablePadding
                secondaryAction={
                  <IconButton 
                    edge="end" 
                    aria-label="delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteConversation(conversation.id);
                    }}
                  >
                    <DeleteIcon />
                  </IconButton>
                }
                sx={{
                  opacity: conversation.id === currentConversationId ? 1 : 0.7,
                }}
              >
                <ListItemButton 
                  selected={conversation.id === currentConversationId}
                  onClick={() => onSelectConversation(conversation.id)}
                  sx={{ pr: 7 }} // Make room for the delete button
                >
                  <ListItemText 
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        {conversation.status && (
                          <Tooltip title={getStatusDescription(conversation.status)}>
                            <Box
                              component="span"
                              sx={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                bgcolor: getStatusColor(conversation.status),
                                display: 'inline-block',
                                flexShrink: 0
                              }}
                            />
                          </Tooltip>
                        )}
                        <Typography
                          component="span"
                          noWrap
                          fontWeight={conversation.id === currentConversationId ? 'bold' : 'normal'}
                        >
                          {conversation.title}
                        </Typography>
                      </Box>
                    }
                    secondary={formatDate(conversation.updatedAt)}
                  />
                </ListItemButton>
              </ListItem>
            ))
        )}
      </List>
    </>
  );
};

export default ChatHistory;
