"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { 
  Box, 
  Typography, 
  Button, 
  Dialog, 
  DialogTitle, 
  DialogContent, 
  DialogContentText, 
  DialogActions, 
  TextField,
  Snackbar,
  Alert,
  Breadcrumbs,
  Link,
  Tooltip,
  Paper,
  IconButton,
  Fade,
  Zoom,
  useTheme
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import HomeIcon from '@mui/icons-material/Home';
import AddIcon from '@mui/icons-material/Add';
import FlowBuilder from '@/frontend/components/Flow/FlowManager/FlowBuilder';
import FlowDashboard from '@/frontend/components/Flow/FlowDashboard';
import { Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/flows/page');

const FlowsPage = () => {
  log.debug('Rendering FlowsPage');
  const theme = useTheme();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  
  // Copy flow dialog state
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [flowToCopy, setFlowToCopy] = useState<Flow | null>(null);
  const [newFlowName, setNewFlowName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  
  // Snackbar for notifications
  const [snackbar, setSnackbar] = useState<{open: boolean; message: string; severity: 'success' | 'error' | 'info' | 'warning'}>({
    open: false,
    message: '',
    severity: 'info'
  });

  // Load flows on component mount and when selected flow changes
  useEffect(() => {
    log.info('Loading flows');
    const loadFlows = async () => {
      setIsLoading(true);
      try {
        const loadedFlows = await flowService.loadFlows();
        log.debug('Flows loaded successfully', { count: loadedFlows.length });
        setFlows(loadedFlows);
        
        // If a flow was previously selected, verify it still exists
        if (selectedFlow) {
          const flowExists = loadedFlows.some(flow => flow.id === selectedFlow);
          if (!flowExists) {
            log.warn('Previously selected flow no longer exists', { flowId: selectedFlow });
            setSelectedFlow(null);
            setIsEditing(false);
            showSnackbar('The previously selected flow is no longer available', 'warning');
          }
        }
      } catch (error) {
        log.error('Error loading flows', error);
        showSnackbar('Failed to load flows', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    loadFlows();
  }, [selectedFlow]);
  
  // Handle flow selection
  const handleSelectFlow = useCallback((flowId: string) => {
    log.debug('Flow selected', { flowId });
    setSelectedFlow(flowId);
    setIsEditing(true); // Auto-enter edit mode when a flow is selected
  }, []);
  
  // Handle back to dashboard
  const handleBackToDashboard = useCallback(() => {
    log.debug('Returning to dashboard');
    setIsEditing(false);
  }, []);
  
  // Show snackbar notification
  const showSnackbar = useCallback((message: string, severity: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    log.debug('Showing snackbar', { message, severity });
    setSnackbar({
      open: true,
      message,
      severity
    });
  }, []);
  
  // Handle snackbar close
  const handleSnackbarClose = useCallback(() => {
    setSnackbar(prev => ({ ...prev, open: false }));
  }, []);

  // Validate flow name
  const validateFlowName = useCallback((name: string): string | null => {
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
  }, [flows]);

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
      showSnackbar('Flow saved successfully', 'success');
    } catch (error) {
      log.error('Error saving flow', error);
      showSnackbar('Failed to save flow', 'error');
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
        setIsEditing(false);
      }
      
      showSnackbar('Flow deleted', 'success');
    } catch (error) {
      log.error('Error deleting flow', error);
      showSnackbar('Failed to delete flow', 'error');
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
      showSnackbar('Flow not found', 'error');
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
      showSnackbar('No flow selected to copy', 'error');
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
    setIsEditing(true);
    showSnackbar(`Created a copy named "${newFlowName}"`, 'success');
  };
  
  const handleNewFlowNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    log.debug('Flow name changed', { name });
    setNewFlowName(name);
    setNameError(validateFlowName(name));
  };
  
  // Create a new flow with a unique name
  const createNewFlow = async () => {
    log.info('Creating new flow');
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
    await handleSaveFlow(newFlow);
    setIsEditing(true); // Switch to editor mode automatically
    showSnackbar('New flow created', 'success');
  };

  // Render content based on state (dashboard or editor)
  const renderContent = () => {
    if (isEditing && selectedFlow) {
      const selectedFlowData = flows.find((f: Flow) => f.id === selectedFlow);
      if (!selectedFlowData) {
        return (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h6" color="error">
              Selected flow not found
            </Typography>
            <Button 
              variant="contained" 
              onClick={handleBackToDashboard}
              sx={{ mt: 2 }}
            >
              Back to Dashboard
            </Button>
          </Box>
        );
      }
      
      return (
        <Fade in={true} timeout={300}>
          <Box sx={{ height: '100%' }}>
            <FlowBuilder
              key={selectedFlow}
              initialFlow={selectedFlowData}
              onSave={handleSaveFlow}
              onDelete={handleDeleteFlow}
              allFlows={flows}
              onSelectFlow={setSelectedFlow}
            />
          </Box>
        </Fade>
      );
    }
    
    return (
      <Fade in={true} timeout={300}>
        <Box sx={{ height: '100%' }}>
          <FlowDashboard
            flows={flows}
            selectedFlow={selectedFlow}
            onSelectFlow={handleSelectFlow}
            onDeleteFlow={handleDeleteFlow}
            onCopyFlow={handleCopyFlow}
            onCreateFlow={createNewFlow}
            isLoading={isLoading}
          />
        </Box>
      </Fade>
    );
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header with breadcrumbs and actions */}
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
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          {isEditing && selectedFlow && (
            <IconButton 
              color="primary" 
              onClick={handleBackToDashboard}
              sx={{ mr: 1 }}
            >
              <ArrowBackIcon />
            </IconButton>
          )}
          
          <Box>
            <Breadcrumbs aria-label="breadcrumb" sx={{ mb: 1 }}>
              {/* Home link is always present */}
              <Link 
                color="inherit" 
                href="/"
                sx={{ display: 'flex', alignItems: 'center' }}
              >
                <HomeIcon sx={{ mr: 0.5 }} fontSize="inherit" />
                Home
              </Link>
              
              {/* Conditionally render either just "Flows" or "Flows" + "Editor" */}
              {isEditing && selectedFlow ? (
                <Link 
                  color="inherit"
                  component="button"
                  onClick={handleBackToDashboard}
                >
                  Flows
                </Link>
              ) : (
                <Typography color="text.primary">Flows</Typography>
              )}
              
              {/* Add flow name as final breadcrumb when editing */}
              {isEditing && selectedFlow && (
                <Typography color="text.primary">
                  {flows.find(f => f.id === selectedFlow)?.name || 'Editor'}
                </Typography>
              )}
            </Breadcrumbs>
            <Typography variant="h5">
              {isEditing && selectedFlow 
                ? `Editing: ${flows.find(f => f.id === selectedFlow)?.name || 'Flow'}`
                : 'Flow Dashboard'
              }
            </Typography>
          </Box>
        </Box>
        
        {!isEditing && (
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Tooltip title="Create a new flow with a starter template">
              <Button
                variant="contained"
                color="primary"
                startIcon={<AddIcon />}
                onClick={createNewFlow}
              >
                New Flow
              </Button>
            </Tooltip>
          </Box>
        )}
      </Box>
      
      {/* Main content area - switches between dashboard and editor */}
      <Box sx={{ flex: 1, overflow: 'hidden' }}>
        {renderContent()}
      </Box>
      
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
      
      {/* Snackbar for notifications */}
      <Snackbar 
        open={snackbar.open} 
        autoHideDuration={6000} 
        onClose={handleSnackbarClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert onClose={handleSnackbarClose} severity={snackbar.severity} sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default FlowsPage;
