"use client";

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { styled } from '@mui/material/styles';
import { 
  Box, 
  Button, 
  TextField, 
  Paper, 
  Typography, 
  Divider,
  IconButton,
} from '@mui/material';
import { createLogger } from '@/utils/logger';
// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/index.tsx');

import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  FormHelperText,
  Alert
} from '@mui/material';
import { 
  ReactFlowProvider, 
  Node, 
  Edge, 
  NodeChange, 
  EdgeChange, 
  ReactFlowInstance, 
  useReactFlow,
  Panel,
  applyNodeChanges,
  applyEdgeChanges
} from '@xyflow/react';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { Flow, FlowNode, HistoryEntry } from '@/shared/types/flow';
import { flowService } from '@/frontend/services/flow';
import { Canvas } from './Canvas/index';
import NodePalette from './NodePalette';
import PropertiesPanel from './PropertiesPanel';
import ProcessNodePropertiesModal from './Modals/ProcessNodePropertiesModal';
import MCPNodePropertiesModal from './Modals/MCPNodePropertiesModal';
import StartNodePropertiesModal from './Modals/StartNodePropertiesModal';
import FinishNodePropertiesModal from './Modals/FinishNodePropertiesModal';
import SaveIcon from '@mui/icons-material/Save';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';

const FlowBuilderContainer = styled(Box)({
  display: 'flex',
  height: 'calc(100vh - 64px)',
  gap: '16px',
  padding: '16px',
  backgroundColor: '#f8f9fa',
});

const ToolbarContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(1),
  display: 'flex',
  gap: theme.spacing(1),
  borderBottom: '1px solid',
  borderColor: theme.palette.divider,
  alignItems: 'center',
  marginBottom: theme.spacing(1),
  backgroundColor: theme.palette.background.paper,
  boxShadow: theme.shadows[1],
}));

const MainContent = styled(Box)({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  overflow: 'hidden',
});

interface FlowBuilderProps {
  initialFlow?: Flow;
  onSave: (flow: Flow) => void;
  onDelete: (flowId: string) => void;
  allFlows: Flow[];
  onSelectFlow?: (flowId: string | null) => void;
}

// Dialog types for save/copy/rename
type DialogType = 'none' | 'duplicate' | 'rename' | 'unsaved';

export const FlowBuilder = ({ initialFlow, onSave, onDelete, allFlows, onSelectFlow }: FlowBuilderProps) => {
  log.debug('FlowBuilder rendered with initialFlow:', initialFlow);

  const [nodes, setNodes] = useState<FlowNode[]>(initialFlow?.nodes || []);
  const [edges, setEdges] = useState<Edge[]>(initialFlow?.edges || []);
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);
  const [flowName, setFlowName] = useState<string>(initialFlow?.name || 'NewFlow');
  const [flowNameError, setFlowNameError] = useState<string | null>(null);
  
  // Dialog states
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [dialogType, setDialogType] = useState<DialogType>('none');
  const [newFlowName, setNewFlowName] = useState<string>('');
  const [newFlowNameError, setNewFlowNameError] = useState<string | null>(null);
  
  // Modal states
  const [processModalOpen, setProcessModalOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [finishModalOpen, setFinishModalOpen] = useState(false);
  const [nodeToEdit, setNodeToEdit] = useState<FlowNode | null>(null);
  
  // History for undo/redo functionality
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isHistoryAction, setIsHistoryAction] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [pendingFlowId, setPendingFlowId] = useState<string | null>(null);
  
  // Filter out invalid edges (missing source/target handles)
  const filterInvalidEdges = useCallback((edges: Edge[]): Edge[] => {
    return edges.filter(edge => 
      edge.source && 
      edge.target && 
      edge.sourceHandle && 
      edge.targetHandle
    );
  }, []);

  // Initialize history with initial state
  useEffect(() => {
    if (initialFlow) {
      setNodes(initialFlow.nodes || []);
      
      // Filter out invalid edges before setting them
      const validEdges = filterInvalidEdges(initialFlow.edges || []);
      if (validEdges.length !== initialFlow.edges.length) {
        console.warn(`Filtered out ${initialFlow.edges.length - validEdges.length} invalid edges`);
      }
      setEdges(validEdges);
      setFlowName(initialFlow.name);
      
      // Initialize history with initial state
      const initialState: HistoryEntry = {
        nodes: initialFlow.nodes || [],
        edges: validEdges
      };
      setHistory([initialState]);
      setHistoryIndex(0);
    } else {
      // Create a new flow with a Start node
      const startNode = flowService.createNode('start', { x: 250, y: 150 });
      // Ensure properties object exists and set promptTemplate
      if (!startNode.data.properties) {
        startNode.data.properties = {};
      }
      startNode.data.properties.promptTemplate = '';
      
      setNodes([startNode]);
      setEdges([]);
      setFlowName('NewFlow');
      
      // Initialize history with the Start node
      const emptyState: HistoryEntry = {
        nodes: [startNode],
        edges: []
      };
      setHistory([emptyState]);
      setHistoryIndex(0);
    }
  }, [initialFlow]);
  
  // Add to history when nodes or edges change
  useEffect(() => {
    if (isHistoryAction) {
      setIsHistoryAction(false);
      return;
    }
    
    // Create new history entry
    const newEntry: HistoryEntry = {
      nodes: [...nodes],
      edges: [...edges]
    };
    
    // Truncate history if we're not at the end
    const newHistory = history.slice(0, historyIndex + 1);
    
    // Only add to history if there's a real change
    if (
      historyIndex < 0 || 
      JSON.stringify(newEntry) !== JSON.stringify(newHistory[historyIndex])
    ) {
      setHistory([...newHistory, newEntry]);
      setHistoryIndex(historyIndex + 1);
      setHasUnsavedChanges(true);
    }
  }, [nodes, edges]);

  // Add beforeunload event listener to warn when leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        // Standard way to show a confirmation dialog when closing the browser
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasUnsavedChanges]);

  // Validate flow name
  const validateFlowName = (name: string): string | null => {
    // Check if name is empty
    if (!name.trim()) {
      return "Flow name cannot be empty";
    }
    
    // Check if name contains only allowed characters (alphanumeric, underscores, dashes)
    if (!/^[\w-]+$/.test(name)) {
      return "Flow name can only contain letters, numbers, underscores, and dashes";
    }
    
    // Check for duplicate names (only if it's a new flow or the name has changed)
    if (!initialFlow || (initialFlow && initialFlow.name !== name)) {
      const isDuplicate = allFlows.some(flow => 
        flow.id !== (initialFlow?.id || '') && 
        flow.name.toLowerCase() === name.toLowerCase()
      );
      
      if (isDuplicate) {
        return "A flow with this name already exists";
      }
    }
    
    return null;
  };

  // Handle flow name change
  const handleFlowNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setFlowName(newName);
    setFlowNameError(validateFlowName(newName));
  };

  // Handle save flow
  const handleSave = useCallback(() => {
    // Validate flow name
    const error = validateFlowName(flowName);
    if (error) {
      setFlowNameError(error);
      return;
    }
    
    // Ensure there's at least a Start node in the flow
    let flowNodes = [...nodes];
    
    // If there are no nodes, add a Start node
    if (flowNodes.length === 0) {
      const startNode = flowService.createNode('start', { x: 250, y: 150 });
      // Ensure properties object exists and set promptTemplate
      if (!startNode.data.properties) {
        startNode.data.properties = {};
      }
      startNode.data.properties.promptTemplate = '';
      
      flowNodes = [startNode];
      setNodes(flowNodes);
    }
    
    // Check if we're trying to save with a new name for an existing flow
    if (initialFlow && initialFlow.name !== flowName) {
      // Ask if user wants to rename or copy
      setDialogType('rename');
      setNewFlowName(flowName);
      setDialogOpen(true);
      return;
    }
    
    const flow: Flow = {
      id: initialFlow?.id || flowService.createNewFlow().id,
      name: flowName,
      nodes: flowNodes,
      edges,
    };
    onSave(flow);
    setHasUnsavedChanges(false);
  }, [flowName, nodes, edges, initialFlow, onSave, allFlows]);

  // Handle flow selection with unsaved changes check
  const handleFlowSelection = useCallback((flowId: string | null) => {
    if (hasUnsavedChanges) {
      setPendingFlowId(flowId);
      setDialogType('unsaved');
      setDialogOpen(true);
    } else if (onSelectFlow) {
      onSelectFlow(flowId);
    }
  }, [hasUnsavedChanges, onSelectFlow]);

  // Export the handleFlowSelection function to be used by the parent component
  useEffect(() => {
    if (onSelectFlow) {
      // This is a workaround to expose the handleFlowSelection function
      // We're overriding the onSelectFlow prop with our wrapped version
      const originalOnSelectFlow = onSelectFlow;
      (onSelectFlow as any).__wrapped = true;
      
      if (!(originalOnSelectFlow as any).__wrapped) {
        const wrappedOnSelectFlow = (flowId: string | null) => {
          handleFlowSelection(flowId);
        };
        (wrappedOnSelectFlow as any).__wrapped = true;
        onSelectFlow = wrappedOnSelectFlow;
      }
    }
  }, [handleFlowSelection, onSelectFlow]);

  // Handle delete flow
  const handleDelete = useCallback(() => {
    if (initialFlow) {
      onDelete(initialFlow.id);
    }
  }, [initialFlow, onDelete]);
  
  // Handle copy flow
  const handleCopyFlow = useCallback((flowToCopy: Flow, newName: string) => {
    // Create a new flow with the same nodes and edges but a new ID and name
    const newFlow: Flow = {
      id: uuidv4(), // Generate a new ID
      name: newName,
      nodes: flowToCopy.nodes,
      edges: flowToCopy.edges,
    };
    
    onSave(newFlow);
  }, [onSave]);
  
  // Handle dialog close
  const handleDialogClose = () => {
    setDialogOpen(false);
    setDialogType('none');
    setNewFlowName('');
    setNewFlowNameError(null);
  };
  
  // Handle dialog confirm
  const handleDialogConfirm = () => {
    // Validate new flow name
    const error = validateFlowName(newFlowName);
    if (error) {
      setNewFlowNameError(error);
      return;
    }
    
    if (dialogType === 'duplicate') {
      // Copy the flow with a new name
      if (initialFlow) {
        handleCopyFlow(initialFlow, newFlowName);
      }
    } else if (dialogType === 'rename') {
      // Save the flow with the new name
      const flow: Flow = {
        id: initialFlow?.id || flowService.createNewFlow().id,
        name: newFlowName,
        nodes,
        edges,
      };
      onSave(flow);
      setHasUnsavedChanges(false);
    } else if (dialogType === 'unsaved') {
      // User confirmed to discard changes
      if (onSelectFlow && pendingFlowId !== undefined) {
        onSelectFlow(pendingFlowId);
        setHasUnsavedChanges(false);
      }
    }
    
    handleDialogClose();
  };

  // Handle discard changes and continue
  const handleDiscardAndContinue = () => {
    if (onSelectFlow && pendingFlowId !== undefined) {
      onSelectFlow(pendingFlowId);
      setHasUnsavedChanges(false);
    }
    handleDialogClose();
  };

  // Handle save and continue
  const handleSaveAndContinue = () => {
    handleSave();
    if (onSelectFlow && pendingFlowId !== undefined) {
      onSelectFlow(pendingFlowId);
    }
    handleDialogClose();
  };
  
  // Handle new flow name change in dialog
  const handleNewFlowNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    setNewFlowName(name);
    setNewFlowNameError(validateFlowName(name));
  };
  
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;
  
  const handleUndo = useCallback(() => {
    if (canUndo) {
      setIsHistoryAction(true);
      const newIndex = historyIndex - 1;
      const prevState = history[newIndex];
      setNodes(prevState.nodes);
      setEdges(prevState.edges);
      setHistoryIndex(newIndex);
    }
  }, [history, historyIndex, canUndo]);
  
  const handleRedo = useCallback(() => {
    if (canRedo) {
      setIsHistoryAction(true);
      const newIndex = historyIndex + 1;
      const nextState = history[newIndex];
      setNodes(nextState.nodes);
      setEdges(nextState.edges);
      setHistoryIndex(newIndex);
    }
  }, [history, historyIndex, canRedo]);

  // Memoized handlers for better performance
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Handle node selection separately
    changes.forEach((change) => {
      if (change.type === 'select' && change.id) {
        const node = nodes.find((n: FlowNode) => n.id === change.id);
        if (node) {
          setSelectedNode(change.selected ? node : null);
        }
      }
    });
    
    // Update nodes with changes
    setNodes((nds) => applyNodeChanges(changes, nds) as FlowNode[]);
  }, [nodes]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance<FlowNode, Edge> | null>(null);

  const handleNodeUpdate = useCallback((nodeId: string, data: any) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === nodeId) {
          return { ...node, data };
        }
        return node;
      })
    );
    
    // Close any open modals
    setProcessModalOpen(false);
    setMcpModalOpen(false);
    setStartModalOpen(false);
    setFinishModalOpen(false);
    setNodeToEdit(null);
  }, []);
  
  // Open the appropriate properties modal based on node type
  const openNodeProperties = useCallback((node: FlowNode) => {
    log.debug('Opening properties for node:', node);
    setNodeToEdit(node);

    if (node.data.type === 'mcp') {
      setMcpModalOpen(true);
    } else if (node.data.type === 'start') {
      setStartModalOpen(true);
    } else if (node.data.type === 'finish') {
      setFinishModalOpen(true);
    } else {
      setProcessModalOpen(true);
    }
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      
      // Get the node type from the data transfer
      const type = event.dataTransfer.getData('application/reactflow');
      
      // Check if we have all the required data to create a node
      if (!type || !reactFlowInstance) {
        return;
      }
      
      // Calculate the position where the node should be placed
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      
      // Create the new node using flowService
      const newNode = flowService.createNode(type, position);
      
      // Add the new node to the existing nodes
      setNodes((nds) => {
        // Deselect all existing nodes
        const updatedNodes = nds.map(node => ({
          ...node,
          selected: false
        }));
        
        // Add the new node with selected property
        return [
          ...updatedNodes,
          {
            ...newNode,
            selected: true
          }
        ];
      });
      
      // Select the newly created node in the properties panel
      setSelectedNode(newNode);
      
      // Automatically open the edit properties modal for the new node
      openNodeProperties(newNode);
    },
    [reactFlowInstance, openNodeProperties]
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onInit = useCallback((instance: any) => {
    setReactFlowInstance(instance as ReactFlowInstance<FlowNode, Edge>);
  }, []);

  return (
    <FlowBuilderContainer>
      <NodePalette />
      <ReactFlowProvider>
        <MainContent>
          <ToolbarContainer elevation={1}>
            <TextField
              size="small"
              label="Flow Name"
              value={flowName}
              onChange={handleFlowNameChange}
              sx={{ minWidth: 500 }}
              error={!!flowNameError}
              helperText={flowNameError}
            />
            
            <Button 
              variant="contained" 
              color="primary" 
              onClick={handleSave}
              startIcon={<SaveIcon />}
              disabled={!!flowNameError}
            >
              Save Flow
            </Button>
            
            {initialFlow && (
              <>
                <Button 
                  variant="outlined" 
                  color="primary" 
                  onClick={() => {
                    setDialogType('duplicate');
                    setNewFlowName(`${initialFlow.name}_copy`);
                    setDialogOpen(true);
                  }}
                >
                  Copy Flow
                </Button>
                <Button variant="outlined" color="error" onClick={handleDelete}>
                  Delete Flow
                </Button>
              </>
            )}
            
            <Divider orientation="vertical" flexItem />
            
            <IconButton 
              onClick={handleUndo} 
              disabled={!canUndo}
              color="primary"
              size="small"
            >
              <UndoIcon />
            </IconButton>
            
            <IconButton 
              onClick={handleRedo} 
              disabled={!canRedo}
              color="primary"
              size="small"
            >
              <RedoIcon />
            </IconButton>
            
            <Box sx={{ flex: 1 }} />
          </ToolbarContainer>
          
          <Box sx={{ flex: 1, position: 'relative' }}>
            <Canvas
              ref={reactFlowWrapper}
              initialNodes={nodes}
              initialEdges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onInit={onInit}
              reactFlowWrapper={reactFlowWrapper}
              onEditNode={openNodeProperties}
            />
          </Box>
        </MainContent>
      </ReactFlowProvider>
      
      {/* Node Properties Modals */}
      <ProcessNodePropertiesModal 
        open={processModalOpen}
        node={nodeToEdit}
        onClose={() => setProcessModalOpen(false)}
        onSave={handleNodeUpdate}
        flowEdges={edges}
        flowNodes={nodes}
        flowId={initialFlow?.id}
      />
      
      <MCPNodePropertiesModal 
        open={mcpModalOpen}
        node={nodeToEdit}
        onClose={() => setMcpModalOpen(false)}
        onSave={handleNodeUpdate}
      />
      
      <StartNodePropertiesModal
        open={startModalOpen}
        node={nodeToEdit}
        onClose={() => setStartModalOpen(false)}
        onSave={handleNodeUpdate}
      />
      
      <FinishNodePropertiesModal
        open={finishModalOpen}
        node={nodeToEdit}
        onClose={() => setFinishModalOpen(false)}
        onSave={handleNodeUpdate}
      />
      
      {/* Dialog for Copy/Rename/Unsaved Changes */}
      <Dialog open={dialogOpen} onClose={handleDialogClose}>
        <DialogTitle>
          {dialogType === 'duplicate' 
            ? 'Copy Flow' 
            : dialogType === 'rename' 
              ? 'Rename Flow' 
              : 'Unsaved Changes'}
        </DialogTitle>
        <DialogContent>
          {dialogType === 'unsaved' ? (
            <DialogContentText>
              You have unsaved changes in the current flow. What would you like to do?
            </DialogContentText>
          ) : (
            <>
              <DialogContentText>
                {dialogType === 'duplicate' 
                  ? 'Enter a name for the copied flow:' 
                  : 'You are changing the name of this flow. Do you want to rename it or create a copy with the new name?'}
              </DialogContentText>
              <TextField
                autoFocus
                margin="dense"
                label="Flow Name"
                type="text"
                fullWidth
                value={newFlowName}
                onChange={handleNewFlowNameChange}
                error={!!newFlowNameError}
                helperText={newFlowNameError}
                sx={{ mt: 2 }}
              />
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDialogClose}>Cancel</Button>
          
          {dialogType === 'unsaved' && (
            <>
              <Button 
                onClick={handleDiscardAndContinue}
                color="error"
              >
                Discard Changes
              </Button>
              <Button 
                onClick={handleSaveAndContinue}
                variant="contained" 
                color="primary"
              >
                Save Changes
              </Button>
            </>
          )}
          
          {dialogType === 'rename' && (
            <>
              <Button 
                onClick={() => {
                  // Validate new flow name
                  const error = validateFlowName(newFlowName);
                  if (error) {
                    setNewFlowNameError(error);
                    return;
                  }
                  
                  // Copy the flow with a new name
                  if (initialFlow) {
                    handleCopyFlow(initialFlow, newFlowName);
                  }
                  
                  handleDialogClose();
                }}
              >
                Copy
              </Button>
              <Button 
                onClick={handleDialogConfirm} 
                variant="contained" 
                color="primary"
                disabled={!!newFlowNameError}
              >
                Rename
              </Button>
            </>
          )}
          
          {dialogType === 'duplicate' && (
            <Button 
              onClick={handleDialogConfirm} 
              variant="contained" 
              color="primary"
              disabled={!!newFlowNameError}
            >
              Copy
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </FlowBuilderContainer>
  );
};

export default FlowBuilder;
