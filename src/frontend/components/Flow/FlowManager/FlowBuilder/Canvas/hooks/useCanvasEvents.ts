import { useCallback, useState } from 'react';
import { useOnSelectionChange, useReactFlow } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { SelectedElementsState, ContextMenuState } from '../types';
import { canDeleteNode } from '../utils/nodeUtils';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/Canvas/hooks/useCanvasEvents.ts');

/**
 * Custom hook to manage canvas events: selection tracking, the context menu,
 * and context-menu deletion.
 *
 * All deletions are routed through ReactFlow's deleteElements so they pass the
 * onBeforeDelete guard in Canvas (Start-node protection) regardless of whether
 * they come from the context menu, the Delete/Backspace keys, or an edge's
 * delete button.
 */
export function useCanvasEvents(nodes: FlowNode[]) {
  const { deleteElements } = useReactFlow();

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

  // Context menu handlers
  const onContextMenu = useCallback(
    (
      event: MouseEvent | React.MouseEvent<Element, MouseEvent>,
      nodeId?: string,
      edgeId?: string,
      selection?: boolean
    ) => {
      event.preventDefault();

      if (nodeId) {
        log.debug(`Context menu opened for node: ${nodeId}`);
      } else if (edgeId) {
        log.debug(`Context menu opened for edge: ${edgeId}`);
      } else if (selection) {
        log.debug('Context menu opened for the current selection');
      } else {
        log.debug(`Context menu opened on canvas at (${event.clientX}, ${event.clientY})`);
      }

      setContextMenu({
        open: true,
        position: { x: event.clientX, y: event.clientY },
        nodeId,
        edgeId,
        selection,
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
    if (contextMenu.selection) {
      log.debug('handleDelete: Deleting the current selection');
      // The onBeforeDelete guard filters out protected Start nodes.
      deleteElements({
        nodes: selectedElements.nodes.map(id => ({ id })),
        edges: selectedElements.edges.map(id => ({ id })),
      });
    } else if (contextMenu.nodeId) {
      log.debug(`handleDelete: Attempting to delete node ${contextMenu.nodeId}`);

      // Check if the node is a Start node - Start nodes cannot be deleted
      if (!canDeleteNode(contextMenu.nodeId, nodes)) {
        log.warn(`Cannot delete Start node: ${contextMenu.nodeId}`);
        alert("Start nodes cannot be deleted");
        return;
      }

      // deleteElements also removes the node's connected edges and runs the
      // onBeforeDelete guard.
      deleteElements({ nodes: [{ id: contextMenu.nodeId }] });
    } else if (contextMenu.edgeId) {
      log.debug(`handleDelete: Deleting edge ${contextMenu.edgeId}`);
      deleteElements({ edges: [{ id: contextMenu.edgeId }] });
    }
  }, [contextMenu, deleteElements, nodes, selectedElements]);

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

  // Pane (empty canvas) context menu — offers Paste at the click position
  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent<Element, MouseEvent>) => {
      onContextMenu(event);
    },
    [onContextMenu]
  );

  // Right-click on a multi-node selection (ReactFlow renders a selection box
  // over the nodes, so onNodeContextMenu does not fire there)
  const onSelectionContextMenu = useCallback(
    (event: React.MouseEvent) => {
      onContextMenu(event, undefined, undefined, true);
    },
    [onContextMenu]
  );

  return {
    contextMenu,
    selectedElements,
    onContextMenu,
    closeContextMenu,
    handleDelete,
    onNodeContextMenu,
    onEdgeContextMenu,
    onPaneContextMenu,
    onSelectionContextMenu,
  };
}

export default useCanvasEvents;
