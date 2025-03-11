"use client";

import React, { useCallback, forwardRef, useRef, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  ConnectionLineType,
  ReactFlowInstance,
  addEdge,
  Connection,
  MarkerType,
  OnInit
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { styled, useTheme } from '@mui/material/styles';
import { FlowNode } from '@/frontend/types/flow/flow';
import { StartNode, ProcessNode, FinishNode, MCPNode } from '../CustomNodes';
import ContextMenu from '../ContextMenu';
import { CustomEdge, MCPEdge } from '../CustomEdges';
import { CanvasProps, EditNodeEventDetail } from './types';
import { useCanvasState } from './hooks/useCanvasState';
import { useCanvasEvents } from './hooks/useCanvasEvents';
import { useProximityConnect } from './hooks/useProximityConnect';
import { validateConnection, createEdgeFromConnection } from './utils/edgeUtils';
import { findNodeById } from './utils/nodeUtils';
import { CanvasToolbar } from './components/CanvasToolbar';
import { CanvasControls } from './components/CanvasControls';

const FlowContainer = styled('div')(({ theme }) => ({
  width: '100%',
  height: '80vh',
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: '4px',
  background: theme.palette.background.paper,
  position: 'relative',
}));

// Define types outside of the component to avoid recreation on each render
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

export const Canvas = forwardRef<HTMLDivElement, CanvasProps>((props, ref) => {
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
  
  const {
    onNodeDrag, onNodeDragStop
  } = useProximityConnect(nodes, setEdges, setLastAddedEdge, onEdgesChangeCallback);

  const flowContainerRef = useRef<HTMLDivElement | null>(null);

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
    if (onInit) {
      onInit(instance);
    }
  }, [onInit]);

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
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        tabIndex={0}
        fitView
        attributionPosition="bottom-right"
        minZoom={0.1}
        maxZoom={2}
        snapToGrid={true}
        snapGrid={[15, 15]}
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
    </FlowContainer>
  );
});

Canvas.displayName = 'Canvas';

export default Canvas;
