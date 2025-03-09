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
  Button
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { Conversation } from './index';

interface ChatHistoryProps {
  conversations: Conversation[];
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
                    primary={conversation.title}
                    secondary={formatDate(conversation.updatedAt)}
                    primaryTypographyProps={{
                      noWrap: true,
                      fontWeight: conversation.id === currentConversationId ? 'bold' : 'normal'
                    }}
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
