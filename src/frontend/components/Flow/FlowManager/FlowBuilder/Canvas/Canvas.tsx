"use client";

import React, { useCallback, forwardRef, useRef, useEffect, useMemo, useState } from 'react';
import { Modal, Box, Typography } from '@mui/material';
import {
  ReactFlow,
  ConnectionLineType,
  ReactFlowInstance,
  addEdge,
  Connection,
  MarkerType,
  OnInit,
  useReactFlow,
  OnConnectStart,
  OnConnectEnd,
  NodeMouseHandler,
  OnConnectStartParams
} from '@xyflow/react';
import { styled, useTheme } from '@mui/material/styles';
import { FlowNode, NodeType } from '@/frontend/types/flow/flow';
import { StartNode, ProcessNode, FinishNode, MCPNode } from '../CustomNodes';
import ContextMenu from '../ContextMenu';
import { CustomEdge, MCPEdge } from '../CustomEdges';
import { CanvasProps, EditNodeEventDetail, NodeSelectionModalProps } from './types';
import { useCanvasState } from './hooks/useCanvasState';
import { useCanvasEvents } from './hooks/useCanvasEvents';
import { validateConnection, createEdgeFromConnection } from './utils/edgeUtils';
import { findNodeById } from './utils/nodeUtils';
import { CanvasToolbar } from './components/CanvasToolbar';
import { CanvasControls } from './components/CanvasControls';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/Canvas/Canvas.tsx');

// Node types for the ReactFlow component
const nodeTypes = {
  start: StartNode,
  process: ProcessNode,
  finish: FinishNode,
  mcp: MCPNode,
};

const edgeTypes = {
  custom: CustomEdge,
  mcpEdge: MCPEdge,
};

// NodeSelectionModal component
const NodeSelectionModal: React.FC<NodeSelectionModalProps> = ({
  open,
  position,
  onClose,
  onSelectNodeType,
  sourceNodeType,
  sourceHandleId,
}) => {
  const theme = useTheme();
  
  // Helper function to determine valid target node types based on source node type and handle ID
  const getValidNodeTypes = (): Array<NodeType> => {
    if (!sourceNodeType || !sourceHandleId) {
      return ['process', 'finish', 'mcp'] as Array<NodeType>;
    }
    
    // If source is an MCP node, only allow connecting to process nodes
    if (sourceNodeType === 'mcp') {
      return ['process'] as Array<NodeType>;
    }
    
    // If source is a process node and the handle is an MCP handle, only allow connecting to MCP nodes
    if (sourceNodeType === 'process' && (
      sourceHandleId.includes('mcp') || 
      sourceHandleId.includes('left') || 
      sourceHandleId.includes('right')
    )) {
      return ['mcp'] as Array<NodeType>;
    }
    
    // For normal connections from process or start nodes, allow process and finish nodes
    return ['process', 'finish'] as Array<NodeType>;
  };
  
  // Get valid node types based on source node type and handle ID
  const validNodeTypes = getValidNodeTypes();
  
  // Log the validation for debugging
  log.debug(`NodeSelectionModal: Source node type: ${sourceNodeType}, Source handle ID: ${sourceHandleId}`);
  log.debug(`NodeSelectionModal: Valid node types: ${validNodeTypes.join(', ')}`);
  
  // All possible node types
  const allNodeTypes: Array<{
    type: NodeType;
    label: string;
    description: string;
  }> = [
    {
      type: 'process',
      label: 'Process Node',
      description: 'Let a LLM do your work',
    },
    {
      type: 'finish',
      label: 'Finish Node',
      description: 'End your flow here',
    },
    {
      type: 'mcp',
      label: 'MCP Node',
      description: 'Add functionality',
    },
  ];
  
  // Filter node types based on validation
  const availableNodeTypes = allNodeTypes.filter(node => validNodeTypes.includes(node.type));

  // Helper function to get the appropriate icon for each node type
  const getNodeIcon = (type: NodeType) => {
    switch (type) {
      case 'process':
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.secondary.main, borderRadius: '50%' }}></div>;
      case 'finish':
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.success.main, borderRadius: '50%' }}></div>;
      case 'mcp':
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.info.main, borderRadius: '50%' }}></div>;
      default:
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.secondary.main, borderRadius: '50%' }}></div>;
    }
  };

  if (!position) return null;
  
  return (
    <Modal
      open={open}
      onClose={onClose}
      aria-labelledby="node-selection-modal"
    >
      <Box
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 300,
          bgcolor: 'background.paper',
          borderRadius: 2,
          boxShadow: 24,
          p: 4,
        }}
      >
        <Typography variant="h6" component="h2" gutterBottom>
          Select Node Type
        </Typography>
        <Box display="flex" flexDirection="column" gap={2}>
          {availableNodeTypes.map((node) => (
            <Box
              key={node.type}
              sx={{
                padding: 2,
                borderRadius: 1,
                border: `2px solid ${
                  node.type === 'process'
                    ? theme.palette.secondary.main
                    : node.type === 'finish'
                    ? theme.palette.success.main
                    : theme.palette.info.main
                }`,
                cursor: 'pointer',
                '&:hover': {
                  boxShadow: 3,
                },
              }}
              onClick={() => onSelectNodeType(node.type, position)}
            >
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                {getNodeIcon(node.type)}
                <Typography variant="subtitle1" fontWeight="bold">
                  {node.label}
                </Typography>
              </Box>
              <Typography variant="body2" color="text.secondary">
                {node.description}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>
    </Modal>
  );
};

const FlowContainer = styled('div')(({ theme }) => ({
  width: '100%',
  height: '80vh',
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: '4px',
  background: theme.palette.background.paper,
  position: 'relative',
}));


export const Canvas = forwardRef<HTMLDivElement, CanvasProps>((props, ref) => {
  const { flowService } = require('@/frontend/services/flow');
  const theme = useTheme();
  const {
    initialNodes = [],
    initialEdges = [],
    onNodesChange: onNodesChangeCallback,
    onEdgesChange: onEdgesChangeCallback,
    onDrop,
    onDragOver,
    onInit,
    reactFlowWrapper,
    onEditNode,
  } = props;

  // Use custom hooks
  const {
    nodes, edges, setNodes, setEdges, onNodesChange, onEdgesChange,
    lastAddedEdge, setLastAddedEdge
  } = useCanvasState(initialNodes, initialEdges);
  
  const {
    contextMenu, selectedElements, handleNodesChange, handleEdgesChange,
    onContextMenu, closeContextMenu, handleDelete, 
    onNodeContextMenu, onEdgeContextMenu, onPaneContextMenu, handleKeyDown
  } = useCanvasEvents(
    nodes, edges, onNodesChange, onEdgesChange, 
    onNodesChangeCallback, onEdgesChangeCallback
  );

  const flowContainerRef = useRef<HTMLDivElement | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  
  // State for connection tracking
  const [connectionStart, setConnectionStart] = useState<{
    nodeId: string | null;
    handleId: string | null;
  }>({ nodeId: null, handleId: null });

  // State for node selection modal
  const [nodeSelectionModal, setNodeSelectionModal] = useState<{
    open: boolean;
    position: { x: number; y: number } | null;
    sourceNodeType?: NodeType;
    sourceHandleId?: string;
  }>({ open: false, position: null });

  // Effect to notify parent about edge changes after render is complete
  useEffect(() => {
    if (lastAddedEdge && onEdgesChangeCallback) {
      onEdgesChangeCallback([{ type: 'add', item: lastAddedEdge }]);
      setLastAddedEdge(null);
    }
  }, [lastAddedEdge, onEdgesChangeCallback, setLastAddedEdge]);

  // Add event listener for edit node from custom button
  useEffect(() => {
    if (!onEditNode) return;
    
    const handleEditNodeEvent = (e: Event) => {
      const customEvent = e as CustomEvent<EditNodeEventDetail>;
      if (customEvent.detail && customEvent.detail.nodeId) {
        const node = findNodeById(customEvent.detail.nodeId, nodes);
        if (node) {
          onEditNode(node);
        }
      }
    };
    
    document.addEventListener('editNode', handleEditNodeEvent);
    
    return () => {
      document.removeEventListener('editNode', handleEditNodeEvent);
    };
  }, [nodes, onEditNode]);

  // Enhanced onConnect handler with edge type determination and validation
  const onConnect = useCallback(
    (params: Connection) => {
      // Check for missing source or target handles
      if (!params.sourceHandle || !params.targetHandle) {
        console.error('Invalid connection: Missing source or target handle', params);
        return;
      }
      
      // Validate the connection
      if (!validateConnection(params, nodes)) {
        // The validateConnection function now logs specific error messages
        return;
      }
      
      // Create the edge with the appropriate type and options
      const edge = createEdgeFromConnection(params, nodes);
      
      setEdges((eds) => {
        const newEdges = addEdge(edge, eds);
        if (newEdges.length > eds.length) {
          // Store the new edge to be processed in the effect
          const newEdge = newEdges[newEdges.length - 1];
          setLastAddedEdge(newEdge);
        }
        return newEdges;
      });
    },
    [setEdges, nodes, setLastAddedEdge]
  );

  // Handle the ReactFlow instance initialization
  const handleInit: OnInit = useCallback((instance) => {
    setReactFlowInstance(instance);
    if (onInit) {
      onInit(instance);
    }
  }, [onInit]);
  
  // Add event listener for adding nodes from palette via double-click
  useEffect(() => {
    const handleAddNodeFromPalette = (e: Event) => {
      const customEvent = e as CustomEvent<{ nodeType: string; position: { x: number; y: number } }>;
      if (!customEvent.detail || !reactFlowInstance) return;
      
      const { nodeType, position } = customEvent.detail;
      
      // Create a new node
      
      // Create the new node
      const newNode = flowService.createNode(nodeType, position);
      
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
      
      // Notify parent about the node change
      if (onNodesChangeCallback) {
        onNodesChangeCallback([{ type: 'add', item: newNode }]);
      }
      
      // Select the newly created node in the properties panel
      if (onEditNode) {
        onEditNode(newNode);
      }
    };
    
    document.addEventListener('addNodeFromPalette', handleAddNodeFromPalette);
    
    return () => {
      document.removeEventListener('addNodeFromPalette', handleAddNodeFromPalette);
    };
  }, [reactFlowInstance, setNodes, onNodesChangeCallback, onEditNode]);

  // Handle edit properties from context menu
  const handleEditProperties = useCallback(() => {
    if (contextMenu.nodeId && onEditNode) {
      const node = findNodeById(contextMenu.nodeId, nodes);
      if (node) {
        onEditNode(node);
      }
    }
  }, [contextMenu.nodeId, nodes, onEditNode]);

  // Handle double-click on nodes to open edit properties
  const onNodeDoubleClick = useCallback(
    (event: React.MouseEvent, node: any) => {
      // Prevent default behavior
      event.preventDefault();
      
      // Call the edit function if provided
      if (onEditNode) {
        const flowNode = node as FlowNode;
        onEditNode(flowNode);
      }
    },
    [onEditNode]
  );

  // Handle connection start
  const onConnectStart: OnConnectStart = useCallback(
    (event, params: OnConnectStartParams) => {
      const { nodeId, handleId } = params;
      log.debug(`onConnectStart: Connection started from node ${nodeId}, handle ${handleId}`);
      setConnectionStart({ nodeId, handleId });
    },
    []
  );

  // Handle connection end
  const onConnectEnd: OnConnectEnd = useCallback(
    (event) => {
      if (!connectionStart.nodeId || !connectionStart.handleId || !reactFlowInstance) {
        log.debug('onConnectEnd: No valid connection start data');
        return;
      }
      
      log.debug(`onConnectEnd: Connection ended from node ${connectionStart.nodeId}`);
      
      // Check if the target is the pane (not a node)
      const targetIsPane = (event.target as Element).classList.contains('react-flow__pane');
      
      if (targetIsPane) {
        // Convert screen coordinates to flow coordinates
        const position = reactFlowInstance.screenToFlowPosition({
          x: event instanceof MouseEvent ? event.clientX : event.touches[0].clientX,
          y: event instanceof MouseEvent ? event.clientY : event.touches[0].clientY,
        });
        
        log.debug(`onConnectEnd: Connection dropped on pane at position (${position.x}, ${position.y})`);
        
        // Get the source node type
        const sourceNode = findNodeById(connectionStart.nodeId!, nodes);
        const sourceNodeType = sourceNode ? sourceNode.type as NodeType : undefined;
        
        // Show the node selection modal with source node type and handle ID
        setNodeSelectionModal({
          open: true,
          position,
          sourceNodeType,
          sourceHandleId: connectionStart.handleId!
        });
      }
      
      // Reset connection tracking
      setConnectionStart({ nodeId: null, handleId: null });
    },
    [connectionStart, reactFlowInstance, nodes]
  );

  // Handle node type selection from modal
  const handleNodeTypeSelection = useCallback(
    (nodeType: NodeType, position: { x: number; y: number }) => {
      log.debug(`handleNodeTypeSelection: Selected node type ${nodeType} at position (${position.x}, ${position.y})`);
      
      // Create a new node of the selected type
      const newNode = flowService.createNode(nodeType, position);
      
      // Add the new node
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
      
      // Get the source node
      const sourceNode = findNodeById(connectionStart.nodeId!, nodes);
      
      if (sourceNode) {
        // Determine the appropriate target handle based on node type
        const targetHandle = nodeType === 'process' ? 'process-top' : 
                            nodeType === 'finish' ? 'finish-top' : 
                            nodeType === 'mcp' ? 'mcp-top' : '';
        
        // Create a connection from the source node to the new node
        const connection = {
          source: connectionStart.nodeId!,
          sourceHandle: connectionStart.handleId!,
          target: newNode.id,
          targetHandle,
        };
        
        log.debug(`handleNodeTypeSelection: Creating connection from ${connection.source} to ${connection.target}`);
        
        // Create and add the edge if the connection is valid
        if (validateConnection(connection, [...nodes, newNode])) {
          const edge = createEdgeFromConnection(connection, [...nodes, newNode]);
          setEdges((eds) => [...eds, edge]);
          setLastAddedEdge(edge);
          
          log.debug(`handleNodeTypeSelection: Edge created with id ${edge.id}`);
        }
      }
      
      // Notify parent components
      if (onNodesChangeCallback) {
        onNodesChangeCallback([{ type: 'add', item: newNode }]);
      }
      
      // Close the modal
      setNodeSelectionModal({ open: false, position: null });
      
      // Select the newly created node in the properties panel
      if (onEditNode) {
        onEditNode(newNode);
      }
    },
    [connectionStart, nodes, setNodes, setEdges, setLastAddedEdge, onNodesChangeCallback, onEditNode]
  );

  // Close the node selection modal
  const handleCloseNodeSelectionModal = useCallback(() => {
    log.debug('handleCloseNodeSelectionModal: Closing node selection modal');
    setNodeSelectionModal({ open: false, position: null, sourceNodeType: undefined, sourceHandleId: undefined });
  }, []);

  return (
    <FlowContainer 
      ref={(el) => {
        // Set both refs
        if (ref) {
          if (typeof ref === 'function') {
            ref(el);
          } else {
            ref.current = el;
          }
        }
        
        if (reactFlowWrapper) {
          reactFlowWrapper.current = el;
        }
        
        flowContainerRef.current = el;
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={useMemo(() => ({
          type: 'custom',
          animated: true,
          style: { stroke: theme.palette.text.secondary, strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 20,
            height: 20,
            color: theme.palette.text.secondary,
          },
        }), [theme.palette.text.secondary])}
        connectionLineType={ConnectionLineType.SmoothStep}
        onNodesChange={handleNodesChange as any}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onInit={handleInit}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onKeyDown={handleKeyDown}
        onNodeDoubleClick={onNodeDoubleClick}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        tabIndex={0}
        fitView
        attributionPosition="bottom-right"
        minZoom={0.1}
        maxZoom={2}
        snapToGrid={true}
        snapGrid={[15, 15]}
        connectOnClick={true}
      >
        <CanvasToolbar flowContainerRef={flowContainerRef as React.RefObject<HTMLDivElement>} />
        <CanvasControls />
      </ReactFlow>
      
      <ContextMenu
        open={contextMenu.open}
        position={contextMenu.position}
        onClose={closeContextMenu}
        onDelete={handleDelete}
        onEditProperties={handleEditProperties}
        nodeId={contextMenu.nodeId}
        edgeId={contextMenu.edgeId}
      />
      
      <NodeSelectionModal
        open={nodeSelectionModal.open}
        position={nodeSelectionModal.position}
        onClose={handleCloseNodeSelectionModal}
        onSelectNodeType={handleNodeTypeSelection}
        sourceNodeType={nodeSelectionModal.sourceNodeType}
        sourceHandleId={nodeSelectionModal.sourceHandleId}
      />
    </FlowContainer>
  );
});

Canvas.displayName = 'Canvas';

export default Canvas;
