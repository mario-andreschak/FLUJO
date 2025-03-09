"use client";

import React from 'react';
import {
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton,
  Paper,
  Typography,
  Tooltip,
  Box,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Flow } from '@/frontend/types/flow/flow';
import Spinner from '@/frontend/components/shared/Spinner';

interface FlowListProps {
  flows: Flow[];
  selectedFlow: string | null;
  onSelectFlow: (flowId: string) => void;
  onDeleteFlow: (flowId: string) => void;
  onCopyFlow?: (flowId: string) => void;
  isLoading?: boolean;
}

export const FlowList = ({
  flows,
  selectedFlow,
  onSelectFlow,
  onDeleteFlow,
  onCopyFlow,
  isLoading = false,
}: FlowListProps) => {
  if (isLoading) {
    return (
      <Paper sx={{ p: 2, mb: 2, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100px' }}>
        <Spinner size="medium" color="primary" />
      </Paper>
    );
  }
  
  if (flows.length === 0) {
    return (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography color="textSecondary">No flows created yet</Typography>
      </Paper>
    );
  }

  return (
    <Paper sx={{ mb: 2 }}>
      <List>
        {flows.map((flow) => (
          <ListItem
            key={flow.id}
            disablePadding
            secondaryAction={
              <Box>
                {onCopyFlow && (
                  <Tooltip title="Copy flow">
                    <IconButton
                      edge="end"
                      aria-label="copy"
                      onClick={() => onCopyFlow(flow.id)}
                      sx={{ mr: 1 }}
                    >
                      <ContentCopyIcon />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="Delete flow">
                  <IconButton
                    edge="end"
                    aria-label="delete"
                    onClick={() => onDeleteFlow(flow.id)}
                  >
                    <DeleteIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            }
          >
            <ListItemButton
              selected={selectedFlow === flow.id}
              onClick={() => onSelectFlow(flow.id)}
            >
              <ListItemText
                primary={flow.name}
                secondary={`${flow.nodes.length} nodes, ${flow.edges.length} connections`}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Paper>
  );
};

export default FlowList;
