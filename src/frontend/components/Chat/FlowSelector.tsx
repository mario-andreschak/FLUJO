"use client";

import React, { useState, useEffect } from 'react';
import { 
  FormControl, 
  InputLabel, 
  Select, 
  MenuItem, 
  Typography, 
  Box, 
  CircularProgress,
  FormHelperText,
  SelectChangeEvent
} from '@mui/material';
import { Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';

interface FlowSelectorProps {
  selectedFlowId: string | null;
  onSelectFlow: (flowId: string) => void;
  disabled?: boolean; // Add disabled prop
}

const FlowSelector: React.FC<FlowSelectorProps> = ({
  selectedFlowId,
  onSelectFlow,
  disabled = false // Default to false
}) => {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Load flows on component mount
  useEffect(() => {
    const loadFlows = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        const loadedFlows = await flowService.loadFlows();
        setFlows(loadedFlows);
      } catch (err) {
        console.error('Error loading flows:', err);
        setError('Failed to load flows');
      } finally {
        setIsLoading(false);
      }
    };
    
    loadFlows();
  }, []);
  
  // Handle flow selection
  const handleFlowChange = (event: SelectChangeEvent<string>) => {
    const flowId = event.target.value;
    onSelectFlow(flowId);
  };
  
  // Get selected flow name
  const getSelectedFlowName = () => {
    if (!selectedFlowId) return '';
    
    const flow = flows.find(f => f.id === selectedFlowId);
    return flow ? flow.name : '';
  };
  
  return (
    <Box>
      <Typography variant="subtitle1" gutterBottom>
        Select Flow
      </Typography>
      
      {isLoading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Loading flows...
          </Typography>
        </Box>
      ) : error ? (
        <Typography color="error" variant="body2">
          {error}
        </Typography>
      ) : flows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No flows available. Create some flows in the Flow Builder first.
        </Typography>
      ) : (
        <FormControl fullWidth disabled={disabled}> {/* Apply disabled prop */}
          <InputLabel id="flow-select-label">Flow</InputLabel>
          <Select
            labelId="flow-select-label"
            id="flow-select"
            value={selectedFlowId || ''}
            label="Flow"
            onChange={handleFlowChange}
            disabled={disabled} // Apply disabled prop
          >
            {flows.map((flow) => (
              <MenuItem key={flow.id} value={flow.id}>
                {flow.name}
              </MenuItem>
            ))}
          </Select>
          <FormHelperText>
            {selectedFlowId 
              ? `Using "${getSelectedFlowName()}" flow for this conversation` 
              : 'Select a flow to use for this conversation'}
          </FormHelperText>
        </FormControl>
      )}
    </Box>
  );
};

export default FlowSelector;
