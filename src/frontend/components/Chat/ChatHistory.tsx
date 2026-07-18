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
import BoltIcon from '@mui/icons-material/Bolt';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { ConversationListItem } from './index'; // Import ConversationListItem instead

interface ChatHistoryProps {
  conversations: ConversationListItem[]; // Use ConversationListItem[]
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** Stop the run of a conversation that is running or awaiting tool approval.
   *  Rendered as a stop button on those list items — including background
   *  conversations, which otherwise have no reachable Stop at all. */
  onStopConversation?: (id: string) => void;
  onNewConversation: () => void;
  /** Start a Quick Chat (model + optional MCP servers, no saved flow) — issue #61. */
  onQuickChat?: () => void;
  /** Optional: collapse/hide the sidebar. When provided, a toggle button is
   *  rendered next to the header. State is owned by the parent. */
  onCollapse?: () => void;
}

const ChatHistory: React.FC<ChatHistoryProps> = ({
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onStopConversation,
  onNewConversation,
  onQuickChat,
  onCollapse
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
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
        {onCollapse && (
          <Tooltip title="Hide sidebar">
            <IconButton size="small" onClick={onCollapse} aria-label="Hide conversation sidebar">
              <ChevronLeftIcon />
            </IconButton>
          </Tooltip>
        )}
        <Typography variant="h6" sx={{ flex: 1 }} noWrap>Conversations</Typography>
        {onQuickChat && (
          <Tooltip title="Quick Chat: a model + optional MCP servers, no saved flow">
            <Button
              variant="outlined"
              color="primary"
              startIcon={<BoltIcon />}
              onClick={onQuickChat}
              size="small"
            >
              Quick
            </Button>
          </Tooltip>
        )}
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
            .map((conversation) => {
              // Any conversation whose run is still alive — executing or holding
              // tool calls (awaiting approval) — gets a stop button, so a run can
              // be stopped without first switching to its conversation.
              const stoppable =
                !!onStopConversation &&
                (conversation.status === 'running' || conversation.status === 'awaiting_tool_approval');
              return (
              <ListItem
                key={conversation.id}
                disablePadding
                secondaryAction={
                  <>
                    {stoppable && (
                      <Tooltip title="Stop this run">
                        <IconButton
                          edge="end"
                          aria-label="stop run"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStopConversation(conversation.id);
                          }}
                        >
                          <StopCircleIcon color="error" />
                        </IconButton>
                      </Tooltip>
                    )}
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
                  </>
                }
                sx={{
                  opacity: conversation.id === currentConversationId ? 1 : 0.7,
                }}
              >
                <ListItemButton
                  selected={conversation.id === currentConversationId}
                  onClick={() => onSelectConversation(conversation.id)}
                  sx={{ pr: stoppable ? 12 : 7 }} // Make room for the action buttons
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
                        <Tooltip title={conversation.title} enterDelay={500}>
                          <Typography
                            component="span"
                            fontWeight={conversation.id === currentConversationId ? 'bold' : 'normal'}
                            sx={{
                              // Allow the title to wrap to two lines with an
                              // ellipsis (issue #134) instead of the old single-
                              // line clamp, so longer generated titles are
                              // readable; the tooltip shows the full title.
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                              wordBreak: 'break-word',
                            }}
                          >
                            {conversation.title}
                          </Typography>
                        </Tooltip>
                      </Box>
                    }
                    secondary={formatDate(conversation.updatedAt)}
                  />
                </ListItemButton>
              </ListItem>
              );
            })
        )}
      </List>
    </>
  );
};

export default ChatHistory;
