"use client";

import React, { useState, useEffect } from 'react';
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
  TextField,
  InputAdornment,
  Divider,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SearchIcon from '@mui/icons-material/Search';
import FilterListIcon from '@mui/icons-material/FilterList';
import { Flow } from '@/frontend/types/flow/flow';
import Spinner from '@/frontend/components/shared/Spinner';
import { createLogger } from '@/utils/logger';

const log = createLogger('components/Flow/FlowManager/FlowBuilder/FlowList');

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
  const [searchTerm, setSearchTerm] = useState('');
  const [filteredFlows, setFilteredFlows] = useState<Flow[]>(flows);
  
  // Update filtered flows when search term or flows change
  useEffect(() => {
    if (searchTerm.trim() === '') {
      setFilteredFlows(flows);
    } else {
      const lowercaseSearch = searchTerm.toLowerCase();
      const results = flows.filter(flow => 
        flow.name.toLowerCase().includes(lowercaseSearch)
      );
      setFilteredFlows(results);
      log.debug('Filtered flows', { count: results.length, term: searchTerm });
    }
  }, [searchTerm, flows]);

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  };

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
      {/* Search field */}
      <Box sx={{ p: 1, pb: 0 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="Search flows..."
          value={searchTerm}
          onChange={handleSearchChange}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
      </Box>
      
      {/* Stats row */}
      <Box sx={{ px: 2, py: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="body2" color="textSecondary">
          {filteredFlows.length} of {flows.length} flows
        </Typography>
        {searchTerm && filteredFlows.length === 0 && (
          <Typography variant="body2" color="error">
            No matches found
          </Typography>
        )}
      </Box>
      
      <Divider />
      
      {/* Scrollable flow list */}
      <Box sx={{ maxHeight: '240px', overflow: 'auto' }}>
        <List disablePadding>
          {filteredFlows.map((flow) => (
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
                        onClick={(e) => {
                          e.stopPropagation();
                          onCopyFlow(flow.id);
                        }}
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
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteFlow(flow.id);
                      }}
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
      </Box>
    </Paper>
  );
};

export default FlowList;
