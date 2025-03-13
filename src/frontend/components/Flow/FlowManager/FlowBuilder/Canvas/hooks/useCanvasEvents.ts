import { useCallback, useState } from 'react';
import { useOnSelectionChange, NodeChange, EdgeChange } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { SelectedElementsState, ContextMenuState } from '../types';
import { getDeleteChanges, canDeleteNode } from '../utils/nodeUtils';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/Canvas/hooks/useCanvasEvents.ts');

/**
 * Custom hook to manage canvas events
 * @param nodes Array of flow nodes
 * @param edges Array of edges
 * @param onNodesChange Node change handler
 * @param onEdgesChange Edge change handler
 * @param onNodesChangeCallback Optional callback for node changes
 * @param onEdgesChangeCallback Optional callback for edge changes
 * @returns Object containing event handlers and state
 */
export function useCanvasEvents(
  nodes: FlowNode[],
  edges: any[],
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void,
  onEdgesChange: (changes: EdgeChange[]) => void,
  onNodesChangeCallback?: (changes: NodeChange<FlowNode>[]) => void,
  onEdgesChangeCallback?: (changes: EdgeChange[]) => void
) {
  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    open: false,
    position: { x: 0, y: 0 },
  });

  // Selected elements state
  const [selectedElements, setSelectedElements] = useState<SelectedElementsState>({
    nodes: [],
    edges: [],
  });

  // Use ReactFlow's selection change hook
  useOnSelectionChange({
    onChange: ({ nodes: selectedNodes, edges: selectedEdges }) => {
      const nodeIds = selectedNodes.map(node => node.id);
      const edgeIds = selectedEdges.map(edge => edge.id);
      
      log.debug(`Selection changed: ${nodeIds.length} nodes, ${edgeIds.length} edges selected`);
      
      setSelectedElements({
        nodes: nodeIds,
        edges: edgeIds,
      });
    },
  });

  // Handle node changes and propagate to parent
  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      log.debug(`handleNodesChange: Processing ${changes.length} node changes`);
      
      // Log specific change types
      changes.forEach(change => {
        if (change.type === 'remove') {
          log.info(`Node removed: ${change.id}`);
        } else if (change.type === 'position') {
          log.debug(`Node position changed: ${change.id}`);
        } else if (change.type === 'select') {
          log.debug(`Node selection changed: ${change.id}, selected: ${change.selected}`);
        }
      });
      
      onNodesChange(changes);
      if (onNodesChangeCallback) {
        onNodesChangeCallback(changes);
      }
    },
    [onNodesChange, onNodesChangeCallback]
  );

  // Handle edge changes and propagate to parent
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      log.debug(`handleEdgesChange: Processing ${changes.length} edge changes`);
      
      // Log specific change types
      changes.forEach(change => {
        if (change.type === 'remove') {
          log.info(`Edge removed: ${change.id}`);
        } else if (change.type === 'select') {
          log.debug(`Edge selection changed: ${change.id}, selected: ${change.selected}`);
        }
      });
      
      onEdgesChange(changes);
      if (onEdgesChangeCallback) {
        onEdgesChangeCallback(changes);
      }
    },
    [onEdgesChange, onEdgesChangeCallback]
  );

  // Context menu handlers
  const onContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent<Element, MouseEvent>, nodeId?: string, edgeId?: string) => {
      event.preventDefault();
      
      if (nodeId) {
        log.debug(`Context menu opened for node: ${nodeId}`);
      } else if (edgeId) {
        log.debug(`Context menu opened for edge: ${edgeId}`);
      } else {
        log.debug(`Context menu opened on canvas at (${event.clientX}, ${event.clientY})`);
      }
      
      setContextMenu({
        open: true,
        position: { x: event.clientX, y: event.clientY },
        nodeId,
        edgeId,
      });
    },
    []
  );

  const closeContextMenu = useCallback(() => {
    log.debug('Context menu closed');
    setContextMenu(prev => ({ ...prev, open: false }));
  }, []);

  // Handle delete action from context menu
  const handleDelete = useCallback(() => {
    if (contextMenu.nodeId) {
      log.debug(`handleDelete: Attempting to delete node ${contextMenu.nodeId}`);
      
      // Check if the node is a Start node - Start nodes cannot be deleted
      if (!canDeleteNode(contextMenu.nodeId, nodes)) {
        log.warn(`Cannot delete Start node: ${contextMenu.nodeId}`);
        alert("Start nodes cannot be deleted");
        return;
      }
      
      // Delete node
      handleNodesChange([{ type: 'remove', id: contextMenu.nodeId }]);
      log.info(`Node deleted: ${contextMenu.nodeId}`);
      
      // Find and delete all connected edges
      const connectedEdges = edges.filter(edge => 
        edge.source === contextMenu.nodeId || 
        edge.target === contextMenu.nodeId
      );
      
      if (connectedEdges.length > 0) {
        log.debug(`Deleting ${connectedEdges.length} edges connected to node ${contextMenu.nodeId}`);
        
        const edgeChanges: EdgeChange[] = connectedEdges.map(edge => ({
          type: 'remove' as const,
          id: edge.id,
        }));
        
        handleEdgesChange(edgeChanges);
      }
    } else if (contextMenu.edgeId) {
      // Delete edge
      log.debug(`handleDelete: Deleting edge ${contextMenu.edgeId}`);
      handleEdgesChange([{ type: 'remove', id: contextMenu.edgeId }]);
    }
  }, [contextMenu, handleNodesChange, handleEdgesChange, edges, nodes]);

  // Handle edit properties from context menu
  const handleEditProperties = useCallback(() => {
    // This will be implemented in the main Canvas component
    // as it requires the onEditNode prop
  }, []);

  // Node context menu handler
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: any) => {
      onContextMenu(event, node.id);
    },
    [onContextMenu]
  );

  // Edge context menu handler
  const onEdgeContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent<Element, MouseEvent>, edge: any) => {
      onContextMenu(event, undefined, edge.id);
    },
    [onContextMenu]
  );

  // Prevent context menu on the canvas background
  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent<Element, MouseEvent>) => {
      closeContextMenu();
    },
    [closeContextMenu]
  );

  // Handler for delete key press
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Delete') {
        log.debug(`Delete key pressed with ${selectedElements.nodes.length} nodes and ${selectedElements.edges.length} edges selected`);
        
        // Only proceed if we have selected elements
        if (selectedElements.nodes.length > 0 || selectedElements.edges.length > 0) {
          const { nodeChanges, edgeChanges } = getDeleteChanges(
            selectedElements.nodes,
            selectedElements.edges,
            nodes,
            edges
          );

          // Apply the changes
          if (nodeChanges.length > 0) {
            log.debug(`Deleting ${nodeChanges.length} nodes via keyboard shortcut`);
            handleNodesChange(nodeChanges);
          }
          
          if (edgeChanges.length > 0) {
            log.debug(`Deleting ${edgeChanges.length} edges via keyboard shortcut`);
            handleEdgesChange(edgeChanges);
          }
        }
      }
    },
    [selectedElements, handleNodesChange, handleEdgesChange, edges, nodes]
  );

  return {
    contextMenu,
    selectedElements,
    handleNodesChange,
    handleEdgesChange,
    onContextMenu,
    closeContextMenu,
    handleDelete,
    handleEditProperties,
    onNodeContextMenu,
    onEdgeContextMenu,
    onPaneContextMenu,
    handleKeyDown
  };
}

export default useCanvasEvents;
