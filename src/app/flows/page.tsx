"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  Collapse,
  Alert,
  Tooltip,
  Paper,
  IconButton,
  Fade,
  Zoom,
  useTheme
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import FlowBuilder, { FlowBuilderHandle } from '@/frontend/components/Flow/FlowManager/FlowBuilder';
import { setNavigationGuard, clearNavigationGuard, NavigationGuard } from '@/frontend/utils/navigationGuard';
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
  const flowBuilderRef = useRef<FlowBuilderHandle>(null);
  
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
  
  // While the editor is open, app-wide navigation (the top menu) must run
  // through the builder's guard too — otherwise switching to Models/MCP/Chat
  // unmounts the editor and silently discards unsaved changes.
  useEffect(() => {
    if (!(isEditing && selectedFlow)) return;
    const guard: NavigationGuard = (navigate) => {
      if (flowBuilderRef.current) {
        flowBuilderRef.current.requestNavigation(navigate);
      } else {
        navigate();
      }
    };
    setNavigationGuard(guard);
    return () => clearNavigationGuard(guard);
  }, [isEditing, selectedFlow]);

  // Handle back to dashboard — routed through the builder's navigation
  // guard so unsaved changes get a Save/Discard dialog first.
  const handleBackToDashboard = useCallback(() => {
    log.debug('Returning to dashboard');
    const leave = () => setIsEditing(false);
    if (flowBuilderRef.current) {
      flowBuilderRef.current.requestNavigation(leave);
    } else {
      leave();
    }
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
  
  // Handle banner close
  const handleSnackbarClose = useCallback(() => {
    setSnackbar(prev => ({ ...prev, open: false }));
  }, []);

  // Auto-dismiss the banner after a few seconds (re-armed whenever a new
  // message is shown). Errors stay until dismissed so they aren't missed.
  useEffect(() => {
    if (!snackbar.open || snackbar.severity === 'error') return;
    const timer = setTimeout(() => {
      setSnackbar(prev => ({ ...prev, open: false }));
    }, 6000);
    return () => clearTimeout(timer);
  }, [snackbar.open, snackbar.message, snackbar.severity]);

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
      // A flow not yet in state is a create (POST); otherwise it's an update (PUT).
      const isNew = !flows.some(f => f.id === flow.id);
      const result = isNew
        ? await flowService.addFlow(flow)
        : await flowService.updateFlow(flow);

      if (!result.success) {
        log.error('Failed to save flow', { error: result.error });
        showSnackbar(result.error || 'Failed to save flow', 'error');
        return;
      }
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
      description: flowToCopy.description,
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
    
    // Create a new flow with the unique name (includes the default Start node)
    const newFlow = flowService.createNewFlow(newName);

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
              ref={flowBuilderRef}
              initialFlow={selectedFlowData}
              onSave={handleSaveFlow}
              onDelete={handleDeleteFlow}
              allFlows={flows}
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
            {/* Breadcrumbs were removed for consistency with the Models/MCP pages;
                the back arrow (left) plus this dynamic title handle editor nav. */}
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
                data-tour="new-flow"
              >
                New Flow
              </Button>
            </Tooltip>
          </Box>
        )}
      </Box>

      {/* Notification banner - shown at the top of the content so it isn't easy
          to miss (replaces the old bottom-right toast/snackbar). */}
      <Collapse in={snackbar.open} unmountOnExit>
        <Alert
          severity={snackbar.severity}
          onClose={handleSnackbarClose}
          sx={{ borderRadius: 0 }}
        >
          {snackbar.message}
        </Alert>
      </Collapse>

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
      
    </Box>
  );
};

export default FlowsPage;
