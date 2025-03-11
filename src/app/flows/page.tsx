"use client";

import React, { useState, useEffect } from 'react';
import { Box, Typography, Button, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, TextField } from '@mui/material';
import FlowBuilder from '@/frontend/components/Flow/FlowManager/FlowBuilder';
import FlowLayout from '@/frontend/components/Flow/FlowManager/FlowLayout';
import { Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/flows/page');

const FlowsPage = () => {
  log.debug('Rendering FlowsPage');
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  // Copy flow dialog state
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [flowToCopy, setFlowToCopy] = useState<Flow | null>(null);
  const [newFlowName, setNewFlowName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  // Load flows on component mount
  useEffect(() => {
    log.info('Loading flows');
    const loadFlows = async () => {
      setIsLoading(true);
      try {
        const loadedFlows = await flowService.loadFlows();
        log.debug('Flows loaded successfully', { count: loadedFlows.length });
        setFlows(loadedFlows);
      } catch (error) {
        log.error('Error loading flows', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadFlows();
  }, []);

  // Validate flow name
  const validateFlowName = (name: string): string | null => {
    log.debug('Validating flow name', { name });
    
    // Check if name is empty
    if (!name.trim()) {
      log.debug('Flow name validation failed: empty name');
      return "Flow name cannot be empty";
    }
    
    // Check if name contains only allowed characters (alphanumeric, underscores, dashes)
    if (!/^[\w-]+$/.test(name)) {
      log.debug('Flow name validation failed: invalid characters');
      return "Flow name can only contain letters, numbers, underscores, and dashes";
    }
    
    // Check for duplicate names
    const isDuplicate = flows.some(flow => flow.name.toLowerCase() === name.toLowerCase());
    if (isDuplicate) {
      log.debug('Flow name validation failed: duplicate name');
      return "A flow with this name already exists";
    }
    
    log.debug('Flow name validation passed');
    return null;
  };

  const handleSaveFlow = async (flow: Flow) => {
    log.info('Saving flow', { flowId: flow.id, flowName: flow.name });
    try {
      await flowService.saveFlow(flow);
      log.debug('Flow saved successfully');
      
      // Update local state
      setFlows(prevFlows => {
        const existingFlowIndex = prevFlows.findIndex(f => f.id === flow.id);
        if (existingFlowIndex >= 0) {
          log.debug('Updating existing flow in state');
          // Update existing flow
          const updatedFlows = [...prevFlows];
          updatedFlows[existingFlowIndex] = flow;
          return updatedFlows;
        } else {
          log.debug('Adding new flow to state');
          // Add new flow
          return [...prevFlows, flow];
        }
      });
      
      setSelectedFlow(flow.id);
    } catch (error) {
      log.error('Error saving flow', error);
    }
  };

  const handleDeleteFlow = async (flowId: string) => {
    log.info('Deleting flow', { flowId });
    try {
      await flowService.deleteFlow(flowId);
      log.debug('Flow deleted successfully');
      
      // Update local state
      setFlows(prevFlows => prevFlows.filter(f => f.id !== flowId));
      
      if (selectedFlow === flowId) {
        log.debug('Clearing selected flow as it was deleted');
        setSelectedFlow(null);
      }
    } catch (error) {
      log.error('Error deleting flow', error);
    }
  };
  
  const handleCopyFlow = (flowId: string) => {
    log.info('Copying flow', { flowId });
    const flowToCopy = flows.find(f => f.id === flowId);
    if (flowToCopy) {
      log.debug('Found flow to copy', { flowName: flowToCopy.name });
      setFlowToCopy(flowToCopy);
      setNewFlowName(`${flowToCopy.name}_copy`);
      setCopyDialogOpen(true);
    } else {
      log.warn('Flow to copy not found', { flowId });
    }
  };
  
  const handleCopyDialogClose = () => {
    log.debug('Closing copy flow dialog');
    setCopyDialogOpen(false);
    setFlowToCopy(null);
    setNewFlowName('');
    setNameError(null);
  };
  
  const handleCopyConfirm = async () => {
    log.info('Confirming flow copy');
    if (!flowToCopy) {
      log.warn('No flow to copy');
      return;
    }
    
    // Validate flow name
    const error = validateFlowName(newFlowName);
    if (error) {
      log.debug('Flow name validation failed', { error });
      setNameError(error);
      return;
    }
    
    // Create a new flow with the same nodes and edges but a new ID and name
    const newId = uuidv4();
    log.debug('Creating new flow from copy', { newId, newName: newFlowName });
    const newFlow: Flow = {
      id: newId, // Generate a new ID
      name: newFlowName,
      nodes: flowToCopy.nodes,
      edges: flowToCopy.edges,
    };
    
    // Save the new flow
    await handleSaveFlow(newFlow);
    
    // Close the dialog
    handleCopyDialogClose();
    
    // Select the new flow
    log.debug('Selecting newly copied flow');
    setSelectedFlow(newFlow.id);
  };
  
  const handleNewFlowNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    log.debug('Flow name changed', { name });
    setNewFlowName(name);
    setNameError(validateFlowName(name));
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          p: 2,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="h5">Flow Builder</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="contained"
            color="primary"
            onClick={() => {
              // Generate a unique name for the new flow
              let baseName = "NewFlow";
              let newName = baseName;
              let counter = 1;
              
              // Check if a flow with this name already exists
              while (flows.some(flow => flow.name === newName)) {
                newName = `${baseName}${counter}`;
                counter++;
              }
              
              // Create a new flow with the unique name
              const newFlow = flowService.createNewFlow(newName);
              
              // Add a Start node
              const startNode = flowService.createNode('start', { x: 250, y: 150 });
              if (!startNode.data.properties) {
                startNode.data.properties = {};
              }
              startNode.data.properties.promptTemplate = '';
              
              newFlow.nodes = [startNode];
              newFlow.edges = [];
              
              // Save the new flow
              handleSaveFlow(newFlow);
            }}
          >
            New Flow
          </Button>
        </Box>
      </Box>
      <FlowLayout
        flows={flows}
        selectedFlow={selectedFlow}
        onSelectFlow={setSelectedFlow}
        onDeleteFlow={handleDeleteFlow}
        onCopyFlow={handleCopyFlow}
        isLoading={isLoading}
      >
        <FlowBuilder
          key={selectedFlow || 'new'}
          initialFlow={selectedFlow ? flows.find((f: Flow) => f.id === selectedFlow) : undefined}
          onSave={handleSaveFlow}
          onDelete={handleDeleteFlow}
          allFlows={flows}
          onSelectFlow={setSelectedFlow}
        />
      </FlowLayout>
      
      {/* Copy Flow Dialog */}
      <Dialog open={copyDialogOpen} onClose={handleCopyDialogClose}>
        <DialogTitle>Copy Flow</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Enter a name for the copied flow:
          </DialogContentText>
          <TextField
            autoFocus
            margin="dense"
            label="Flow Name"
            type="text"
            fullWidth
            value={newFlowName}
            onChange={handleNewFlowNameChange}
            error={!!nameError}
            helperText={nameError}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCopyDialogClose}>Cancel</Button>
          <Button 
            onClick={handleCopyConfirm} 
            variant="contained" 
            color="primary"
            disabled={!!nameError}
          >
            Copy
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default FlowsPage;
