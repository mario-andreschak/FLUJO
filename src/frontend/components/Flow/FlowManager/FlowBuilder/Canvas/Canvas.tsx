"use client";

import React, { useCallback, forwardRef, useRef, useEffect, useMemo, useState } from 'react';
import { Modal, Box, Typography } from '@mui/material';
import {
  ReactFlow,
  ConnectionLineType,
  ReactFlowInstance,
  Connection,
  Edge,
  EdgeChange,
  NodeChange,
  MarkerType,
  OnInit,
  OnBeforeDelete,
  useReactFlow,
  useStoreApi,
  OnConnectEnd
} from '@xyflow/react';
import { styled, useTheme } from '@mui/material/styles';
import { v4 as uuidv4 } from 'uuid';
import { FlowNode, NodeType } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import { StartNode, ProcessNode, FinishNode, MCPNode, SubflowNode } from '../CustomNodes';
import ContextMenu from '../ContextMenu';
import { CustomEdge, MCPEdge } from '../CustomEdges';
import { EDGE_WAYPOINT_EVENT, EdgeWaypointEventDetail } from '../CustomEdges/FlowEdgeBase';
import { CanvasProps, EditNodeEventDetail, NodeSelectionModalProps } from './types';
import { useCanvasEvents } from './hooks/useCanvasEvents';
import { validateConnection, createEdgeFromConnection, getReplacedEdgeIds, canConvertToBidirectional } from './utils/edgeUtils';
import { validTargetTypesFor, defaultTargetHandleFor, isMcpHandle } from './utils/connectionRules';
import { findNodeById } from './utils/nodeUtils';
import { CanvasToolbar } from './components/CanvasToolbar';
import { CanvasControls } from './components/CanvasControls';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/Canvas/Canvas.tsx');

// Clipboard for copy/paste of nodes. localStorage backs cross-flow paste (and
// survives reloads); the in-tab variable is the fast path within a session.
const FLOW_CLIPBOARD_KEY = 'flujo:flowClipboard';
interface FlowClipboard {
  nodes: FlowNode[];
  edges: any[];
}
let flowClipboardMemory: FlowClipboard | null = null;

// The single write path for the flow clipboard — every copy source must use
// this so the in-memory and localStorage payloads never diverge.
function writeFlowClipboard(payload: FlowClipboard) {
  flowClipboardMemory = payload;
  try {
    localStorage.setItem(FLOW_CLIPBOARD_KEY, JSON.stringify(payload));
  } catch (err) {
    log.warn('Could not persist flow clipboard to localStorage', err);
  }
}

// Node types for the ReactFlow component
const nodeTypes = {
  start: StartNode,
  process: ProcessNode,
  finish: FinishNode,
  mcp: MCPNode,
  subflow: SubflowNode,
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

  // Valid target node types come from the shared connection rules, so the
  // picker always agrees with validateConnection.
  const validNodeTypes = validTargetTypesFor(sourceNodeType, sourceHandleId);

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
    {
      type: 'subflow',
      label: 'Subflow Node',
      description: 'Run another flow',
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
      case 'subflow':
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.warning.main, borderRadius: '50%' }}></div>;
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
                    : node.type === 'subflow'
                    ? theme.palette.warning.main
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
  const theme = useTheme();
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onDrop,
    onDragOver,
    onInit,
    reactFlowWrapper,
    onEditNode,
  } = props;

  const {
    contextMenu, selectedElements,
    closeContextMenu, handleDelete,
    onNodeContextMenu, onEdgeContextMenu, onPaneContextMenu, onSelectionContextMenu
  } = useCanvasEvents(nodes);

  const { deleteElements } = useReactFlow();
  const storeApi = useStoreApi<FlowNode, Edge>();

  const flowContainerRef = useRef<HTMLDivElement | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance<FlowNode, Edge> | null>(null);

  // State for the node selection modal. It also carries the pending
  // connection source (captured at drop time from xyflow's connection state)
  // so the source survives until the user picks a node type or closes the
  // modal. Deliberately NOT tracked via onConnectStart + component state:
  // xyflow snapshots the onConnectEnd callback at pointerdown, so state set
  // during the drag is invisible to the closure that runs at drop — it would
  // always see the *previous* drag's source.
  const [nodeSelectionModal, setNodeSelectionModal] = useState<{
    open: boolean;
    position: { x: number; y: number } | null;
    sourceNodeId?: string;
    sourceNodeType?: NodeType;
    sourceHandleId?: string;
  }>({ open: false, position: null });

  // Changes that add a node: deselect the current selection, then add the new
  // node selected.
  const buildAddNodeChanges = useCallback(
    (newNode: FlowNode): NodeChange<FlowNode>[] => [
      ...nodes
        .filter(n => n.selected)
        .map(n => ({ type: 'select' as const, id: n.id, selected: false })),
      { type: 'add' as const, item: { ...newNode, selected: true } },
    ],
    [nodes]
  );

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

  // Enhanced onConnect handler with edge type determination and validation.
  // A new edge replaces any edge it logically duplicates (one MCP connection
  // per Process/MCP node pair, one flow-control edge per direction), so users
  // can freely re-draw connections while re-organizing without stacking
  // duplicates. Drawing the REVERSE of an existing flow-control edge merges
  // the two into one bidirectional connector (double arrows) instead of
  // adding a second wire — either by dragging bottom(B) -> top(A), or by
  // retracing the edge backwards from the top handle (top(B) -> bottom(A)).
  const onConnect = useCallback(
    (params: Connection) => {
      // Check for missing source or target handles
      if (!params.sourceHandle || !params.targetHandle) {
        log.error('Invalid connection: Missing source or target handle', params);
        return;
      }

      // ReactFlow normalizes connections: `source`/`target` follow the handle
      // TYPES, not the drag direction, so a drag from B's top (target) handle
      // to A's bottom (source) handle arrives as A -> B — indistinguishable
      // in params from re-drawing the existing forward edge. The gesture
      // origin is still present in the connection state here (it is cleared
      // only after the connect callbacks have run), so read it to tell the
      // two gestures apart.
      const draggedFromTargetHandle =
        storeApi.getState().connection.fromHandle?.type === 'target';

      // Validate the connection
      if (!validateConnection(params, nodes, edges)) {
        // The validateConnection function now logs specific error messages
        return;
      }

      // Create the edge with the appropriate type and options
      const edge = createEdgeFromConnection(params, nodes);

      if ((edge.data as { edgeType?: string })?.edgeType === 'standard') {
        const isStandard = (e: Edge) =>
          (e.data as { edgeType?: string } | undefined)?.edgeType !== 'mcp';
        const isBidirectional = (e: Edge) =>
          !!(e.data as { bidirectional?: boolean } | undefined)?.bidirectional;
        const sameDirection = edges.find(e =>
          isStandard(e) && e.source === params.source && e.target === params.target
        );
        const reverse = edges.find(e =>
          isStandard(e) && e.source === params.target && e.target === params.source
        );

        const mergeToBidirectional = (existing: Edge) => {
          log.info(`Merging reverse connection into bidirectional edge ${existing.id}`);
          onEdgesChange([{
            type: 'replace',
            id: existing.id,
            item: {
              ...existing,
              data: { ...existing.data, bidirectional: true },
              // Arrowheads on both ends; the end marker comes from
              // defaultEdgeOptions already.
              markerStart: {
                type: MarkerType.ArrowClosed,
                width: 20,
                height: 20,
                color: theme.palette.text.secondary,
              },
            } as Edge,
          }]);
        };

        // A drag that started on a top (target-type) handle never creates a
        // new edge — its only meaning is "convert the existing one-way
        // connection between these two nodes into a bidirectional handoff".
        if (draggedFromTargetHandle) {
          const existing = sameDirection ?? reverse;
          if (!existing) {
            log.info('Connection drawn from a top handle is only allowed to convert an existing edge to bidirectional');
            return;
          }
          if (!isBidirectional(existing) && canConvertToBidirectional(existing, nodes, edges)) {
            mergeToBidirectional(existing);
          }
          return;
        }

        // Re-drawing an existing bidirectional connection in either direction
        // is a no-op — it must not downgrade it to one-way.
        if (sameDirection && isBidirectional(sameDirection)) {
          return;
        }

        if (reverse) {
          if (!isBidirectional(reverse) && canConvertToBidirectional(reverse, nodes, edges)) {
            mergeToBidirectional(reverse);
          }
          return;
        }
      }

      const replaced = getReplacedEdgeIds(edge, edges);

      onEdgesChange([
        ...replaced.map(id => ({ type: 'remove' as const, id })),
        { type: 'add' as const, item: edge },
      ]);
    },
    [nodes, edges, onEdgesChange, storeApi, theme.palette.text.secondary]
  );

  // Commit edge re-route gestures (bend drag end, waypoint move/removal)
  // into the controlled store — one undo entry per gesture.
  useEffect(() => {
    const handler = (e: Event) => {
      const { edgeId, waypoints } = (e as CustomEvent<EdgeWaypointEventDetail>).detail;
      const edge = edges.find(ed => ed.id === edgeId);
      if (!edge) return;
      // `waypoint` (singular) was the first iteration's shape — drop it on
      // the way through so edges converge on the array form.
      const { waypoint: _legacy, ...restData } = (edge.data ?? {}) as Record<string, unknown>;
      onEdgesChange([{
        type: 'replace',
        id: edgeId,
        item: { ...edge, data: { ...restData, waypoints: waypoints ?? undefined } } as Edge,
      }]);
    };
    document.addEventListener(EDGE_WAYPOINT_EVENT, handler);
    return () => document.removeEventListener(EDGE_WAYPOINT_EVENT, handler);
  }, [edges, onEdgesChange]);

  // Central deletion guard: every delete path (Delete/Backspace keys, context
  // menu, edge delete buttons, Ctrl+X) runs through deleteElements and lands
  // here. Start nodes are never deleted, and an edge is only deleted when the
  // user selected it directly or one of its endpoints is actually being
  // deleted — so a protected Start node keeps its connections.
  const onBeforeDelete: OnBeforeDelete<FlowNode, Edge> = useCallback(
    async ({ nodes: nodesToDelete, edges: edgesToDelete }: { nodes: FlowNode[]; edges: Edge[] }) => {
      const deletableNodes = nodesToDelete.filter(n => n.type !== 'start');
      const deletableIds = new Set(deletableNodes.map(n => n.id));
      const requestedIds = new Set(nodesToDelete.map(n => n.id));

      const deletableEdges = edgesToDelete.filter(e => {
        if (e.selected) return true;
        if (deletableIds.has(e.source) || deletableIds.has(e.target)) return true;
        // Included only because it touches a protected Start node — keep it.
        return !(requestedIds.has(e.source) || requestedIds.has(e.target));
      });

      if (deletableNodes.length === 0 && deletableEdges.length === 0) {
        return false;
      }
      return { nodes: deletableNodes, edges: deletableEdges };
    },
    []
  );

  // Handle the ReactFlow instance initialization
  const handleInit: OnInit<FlowNode, Edge> = useCallback((instance) => {
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

      // Create the new node
      const newNode = flowService.createNode(nodeType, position);

      onNodesChange(buildAddNodeChanges(newNode));

      // Select the newly created node in the properties panel
      if (onEditNode) {
        onEditNode(newNode);
      }
    };

    document.addEventListener('addNodeFromPalette', handleAddNodeFromPalette);

    return () => {
      document.removeEventListener('addNodeFromPalette', handleAddNodeFromPalette);
    };
  }, [reactFlowInstance, onNodesChange, buildAddNodeChanges, onEditNode]);

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

  // Handle connection end. The drag source comes from xyflow's own
  // connection state for the gesture that just ended — never from component
  // state, which the snapshotted callback would read stale (see the modal
  // state comment above). When the connection is dropped on the empty pane,
  // the node-selection modal opens carrying the source with it.
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      const { fromNode, fromHandle } = connectionState;
      if (!fromNode || !fromHandle?.id || !reactFlowInstance) {
        log.debug('onConnectEnd: No valid connection start data');
        return;
      }

      log.debug(`onConnectEnd: Connection ended from node ${fromNode.id}, handle ${fromHandle.id}`);

      // Drags starting on a top (target-type) flow handle can only convert an
      // existing edge to bidirectional (see onConnect) — dropping one on the
      // pane must not offer to create a node that would hang off a backwards
      // edge. MCP handles are exempt: MCP wiring is non-directional.
      if (fromHandle.type === 'target' && !isMcpHandle(fromHandle.id)) {
        log.debug('onConnectEnd: Drag from a target handle cannot create a new node');
        return;
      }

      // A subflow has a single outgoing path — once it has one, dropping on
      // the pane must not offer to create a second successor. (The same rule
      // is enforced for direct connections in validateConnection.)
      if (fromNode.type === 'subflow' && fromHandle.type === 'source') {
        const hasOutgoing = edges.some(e => {
          const data = e.data as { edgeType?: string; bidirectional?: boolean } | undefined;
          if (data?.edgeType === 'mcp') return false;
          return e.source === fromNode.id || (e.target === fromNode.id && !!data?.bidirectional);
        });
        if (hasOutgoing) {
          log.debug('onConnectEnd: Subflow already has an outgoing connection; not offering a new node');
          return;
        }
      }

      // Check if the target is the pane (not a node). If it isn't, onConnect
      // handled any edge creation and there is nothing to do here.
      const targetIsPane = (event.target as Element).classList.contains('react-flow__pane');
      if (!targetIsPane) {
        return;
      }

      // Convert screen coordinates to flow coordinates. touchend events
      // carry the lifted finger in changedTouches (touches is empty).
      const point = event instanceof MouseEvent ? event : event.changedTouches[0];
      const position = reactFlowInstance.screenToFlowPosition({
        x: point.clientX,
        y: point.clientY,
      });

      log.debug(`onConnectEnd: Connection dropped on pane at position (${position.x}, ${position.y})`);

      // Show the node selection modal with the pending connection source
      setNodeSelectionModal({
        open: true,
        position,
        sourceNodeId: fromNode.id,
        sourceNodeType: fromNode.type as NodeType,
        sourceHandleId: fromHandle.id,
      });
    },
    [reactFlowInstance, edges]
  );

  // Handle node type selection from modal
  const handleNodeTypeSelection = useCallback(
    (nodeType: NodeType, position: { x: number; y: number }) => {
      log.debug(`handleNodeTypeSelection: Selected node type ${nodeType} at position (${position.x}, ${position.y})`);

      // Create a new node of the selected type
      const newNode = flowService.createNode(nodeType, position);

      onNodesChange(buildAddNodeChanges(newNode));

      // Get the pending connection source captured when the drag was dropped
      const { sourceNodeId, sourceHandleId } = nodeSelectionModal;
      const sourceNode = sourceNodeId ? findNodeById(sourceNodeId, nodes) : undefined;

      if (sourceNode && sourceHandleId) {
        const targetHandle = defaultTargetHandleFor(nodeType);

        // Create a connection from the source node to the new node
        const connection = {
          source: sourceNode.id,
          sourceHandle: sourceHandleId,
          target: newNode.id,
          targetHandle,
        };

        log.debug(`handleNodeTypeSelection: Creating connection from ${connection.source} to ${connection.target}`);

        // Create and add the edge if the connection is valid
        if (validateConnection(connection, [...nodes, newNode], edges)) {
          const edge = createEdgeFromConnection(connection, [...nodes, newNode]);
          const replaced = getReplacedEdgeIds(edge, edges);
          onEdgesChange([
            ...replaced.map(id => ({ type: 'remove' as const, id })),
            { type: 'add' as const, item: edge },
          ]);

          log.debug(`handleNodeTypeSelection: Edge created with id ${edge.id}`);
        }
      }

      // Close the modal; this also discards the consumed connection source.
      setNodeSelectionModal({ open: false, position: null });

      // Select the newly created node in the properties panel
      if (onEditNode) {
        onEditNode(newNode);
      }
    },
    [nodeSelectionModal, nodes, edges, buildAddNodeChanges, onNodesChange, onEdgesChange, onEditNode]
  );

  // Close the node selection modal, abandoning the pending connection.
  const handleCloseNodeSelectionModal = useCallback(() => {
    log.debug('handleCloseNodeSelectionModal: Closing node selection modal');
    setNodeSelectionModal({ open: false, position: null });
  }, []);

  // --- Copy / paste of nodes (within a flow and across flows) ---
  // Copy the current selection (its nodes + any edges fully inside it) to the
  // clipboard. Returns false when there is nothing copyable so the key event
  // can fall through. Start nodes are excluded (unique per flow).
  const handleCopySelection = useCallback(() => {
    const selectedSet = new Set(selectedElements.nodes);
    const copyNodes = nodes.filter(n => selectedSet.has(n.id) && n.type !== 'start');
    if (copyNodes.length === 0) return false;
    const copyIds = new Set(copyNodes.map(n => n.id));
    const copyEdges = edges.filter(e => copyIds.has(e.source) && copyIds.has(e.target));
    writeFlowClipboard({
      nodes: JSON.parse(JSON.stringify(copyNodes)),
      edges: JSON.parse(JSON.stringify(copyEdges)),
    });
    log.debug(`Copied ${copyNodes.length} node(s) and ${copyEdges.length} edge(s)`);
    return true;
  }, [selectedElements, nodes, edges]);

  // Paste clipboard contents as new, independent nodes/edges (regenerated ids,
  // offset position), emitted as 'add' changes to the parent store.
  const handlePaste = useCallback(() => {
    let payload = flowClipboardMemory;
    if (!payload) {
      try {
        const raw = localStorage.getItem(FLOW_CLIPBOARD_KEY);
        if (raw) payload = JSON.parse(raw) as FlowClipboard;
      } catch (err) {
        log.warn('Could not read flow clipboard from localStorage', err);
      }
    }
    if (!payload || !payload.nodes || payload.nodes.length === 0) {
      log.debug('Paste requested but clipboard is empty');
      return;
    }

    const idMap = new Map<string, string>();
    payload.nodes.forEach(n => idMap.set(n.id, uuidv4()));
    const OFFSET = 40;

    const newNodes: FlowNode[] = payload.nodes.map(n => ({
      ...n,
      id: idMap.get(n.id)!,
      position: { x: (n.position?.x ?? 0) + OFFSET, y: (n.position?.y ?? 0) + OFFSET },
      selected: true,
      data: { ...n.data },
    }));

    const newEdges = (payload.edges || [])
      .filter(e => idMap.has(e.source) && idMap.has(e.target))
      .map(e => ({
        ...e,
        id: uuidv4(),
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        selected: false,
      }));

    onNodesChange([
      ...nodes
        .filter(n => n.selected)
        .map(n => ({ type: 'select' as const, id: n.id, selected: false })),
      ...newNodes.map(n => ({ type: 'add' as const, item: n })),
    ]);
    if (newEdges.length > 0) {
      onEdgesChange(newEdges.map(e => ({ type: 'add' as const, item: e })) as EdgeChange[]);
    }

    log.info(`Pasted ${newNodes.length} node(s) and ${newEdges.length} edge(s)`);
  }, [nodes, onNodesChange, onEdgesChange]);

  // Keyboard handler for copy/cut/paste shortcuts. Delete/Backspace are
  // handled by ReactFlow itself and guarded by onBeforeDelete.
  const handleCanvasKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'c') {
        if (handleCopySelection()) event.preventDefault();
        return;
      }
      if (mod && key === 'x') {
        if (handleCopySelection()) {
          event.preventDefault();
          // Delete through the guarded pipeline (protects Start nodes).
          deleteElements({
            nodes: selectedElements.nodes.map(id => ({ id })),
            edges: selectedElements.edges.map(id => ({ id })),
          });
        }
        return;
      }
      if (mod && key === 'v') {
        event.preventDefault();
        handlePaste();
        return;
      }
    },
    [handleCopySelection, handlePaste, deleteElements, selectedElements]
  );

  // Context-menu "Copy": if the right-clicked node isn't part of the current
  // selection, copy just that node; otherwise copy the whole selection.
  const handleContextCopy = useCallback(() => {
    if (contextMenu.nodeId && !selectedElements.nodes.includes(contextMenu.nodeId)) {
      const node = nodes.find(n => n.id === contextMenu.nodeId);
      if (node && node.type !== 'start') {
        writeFlowClipboard({ nodes: JSON.parse(JSON.stringify([node])), edges: [] });
        log.debug('Copied right-clicked node to clipboard');
      }
      return;
    }
    handleCopySelection();
  }, [contextMenu.nodeId, selectedElements, nodes, handleCopySelection]);

  // Whether there is anything to paste (re-checked each time the menu opens).
  const canPaste = useMemo(() => {
    if (flowClipboardMemory) return true;
    try {
      return !!localStorage.getItem(FLOW_CLIPBOARD_KEY);
    } catch {
      return false;
    }
  }, [contextMenu.open]);

  // Whether the context-menu target can be copied: Start nodes cannot (they
  // are unique per flow), and a selection is copyable when it contains at
  // least one non-Start node.
  const canCopy = useMemo(() => {
    if (contextMenu.selection) {
      const selectedSet = new Set(selectedElements.nodes);
      return nodes.some(n => selectedSet.has(n.id) && n.type !== 'start');
    }
    if (contextMenu.nodeId) {
      const node = nodes.find(n => n.id === contextMenu.nodeId);
      return !!node && node.type !== 'start';
    }
    return false;
  }, [contextMenu.selection, contextMenu.nodeId, selectedElements, nodes]);

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
      <ReactFlow<FlowNode, Edge>
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
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onBeforeDelete={onBeforeDelete}
        deleteKeyCode={['Backspace', 'Delete']}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onInit={handleInit}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onKeyDown={handleCanvasKeyDown}
        onNodeDoubleClick={onNodeDoubleClick}
        onConnectEnd={onConnectEnd}
        tabIndex={0}
        fitView
        attributionPosition="bottom-right"
        minZoom={0.1}
        maxZoom={2}
        snapToGrid={true}
        snapGrid={[15, 15]}
        // Click-to-connect is off (default is on): a stray click on a handle
        // would silently arm a connection that survives waypoint editing and
        // completes on the next handle click — and the edges' 20px grab path
        // overlaps the handles at the endpoints, making stray clicks easy.
        connectOnClick={false}
      >
        <CanvasToolbar />
        <CanvasControls />
      </ReactFlow>

      <ContextMenu
        open={contextMenu.open}
        position={contextMenu.position}
        onClose={closeContextMenu}
        onDelete={handleDelete}
        onEditProperties={handleEditProperties}
        onCopy={handleContextCopy}
        onPaste={handlePaste}
        canPaste={canPaste}
        canCopy={canCopy}
        nodeId={contextMenu.nodeId}
        selection={contextMenu.selection}
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
