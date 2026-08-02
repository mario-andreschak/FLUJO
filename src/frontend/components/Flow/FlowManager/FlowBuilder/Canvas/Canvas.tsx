"use client";

import React, { useCallback, forwardRef, useRef, useEffect, useMemo, useState } from 'react';
import {
  Box,
  ClickAwayListener,
  InputAdornment,
  Paper,
  Portal,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import {
  ReactFlow,
  ConnectionLineType,
  ConnectionMode,
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
import { alpha, styled, useTheme } from '@mui/material/styles';
import { v4 as uuidv4 } from 'uuid';
import { FlowNode, NodeType } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import { plannedExecutionsService } from '@/frontend/services/plannedExecutions';
import {
  StartNode,
  ProcessNode,
  FinishNode,
  MCPNode,
  SubflowNode,
  ResourceNode,
  SignalNode,
  TriggerNode,
  RESOURCE_COLOR,
  SIGNAL_COLOR,
  TRIGGER_COLOR,
  FLOW_QUICK_CONNECT_EVENT,
  type FlowQuickConnectEventDetail,
} from '../CustomNodes';
import ContextMenu from '../ContextMenu';
import { CustomEdge, MCPEdge, ResourceEdge } from '../CustomEdges';
import { EDGE_WAYPOINT_EVENT, EdgeWaypointEventDetail } from '../CustomEdges/FlowEdgeBase';
import { CanvasProps, EditNodeEventDetail, NodeSelectionModalProps } from './types';
import { useCanvasEvents } from './hooks/useCanvasEvents';
import { validateConnection, isConnectionAllowed, createEdgeFromConnection, getReplacedEdgeIds, canConvertToBidirectional } from './utils/edgeUtils';
import { validTargetTypesFor, defaultTargetHandleFor } from './utils/connectionRules';
import { shouldOpenNodePicker } from './utils/nodePickerGate';
import { findNodeById } from './utils/nodeUtils';
import { CanvasControls } from './components/CanvasControls';
import { createLogger } from '@/utils/logger';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import { useI18n } from '@/frontend/contexts/I18nContext';

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

// Node types for the ReactFlow component. Exported so the read-only version
// preview (FlowPreview) renders with the exact same node components.
export const nodeTypes = {
  start: StartNode,
  process: ProcessNode,
  finish: FinishNode,
  mcp: MCPNode,
  subflow: SubflowNode,
  resource: ResourceNode,
  signal: SignalNode,
  trigger: TriggerNode,
};

export const edgeTypes = {
  custom: CustomEdge,
  mcpEdge: MCPEdge,
  resourceEdge: ResourceEdge,
};

// NodeSelectionModal component
const NodeSelectionModal: React.FC<NodeSelectionModalProps> = ({
  open,
  position,
  anchorPosition,
  onClose,
  onSelectNodeType,
  sourceNodeType,
  sourceHandleId,
}) => {
  const theme = useTheme();
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

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
      label: t('flows.canvas.processNode'),
      description: t('flows.canvas.processDescription'),
    },
    {
      type: 'finish',
      label: t('flows.canvas.finishNode'),
      description: t('flows.canvas.finishDescription'),
    },
    {
      type: 'mcp',
      label: t('flows.canvas.mcpNode'),
      description: t('flows.canvas.mcpDescription'),
    },
    {
      type: 'subflow',
      label: t('flows.canvas.subflowNode'),
      description: t('flows.canvas.subflowDescription'),
    },
    {
      type: 'resource',
      label: t('flows.canvas.resourceNode'),
      description: t('flows.canvas.resourceDescription'),
    },
    {
      type: 'signal',
      label: t('flows.canvas.signalNode'),
      description: t('flows.canvas.signalDescription'),
    },
    {
      type: 'trigger',
      label: t('flows.canvas.triggerNode'),
      description: t('flows.canvas.triggerDescription'),
    },
  ];

  // Filter node types based on validation
  const availableNodeTypes = allNodeTypes
    .filter(node => validNodeTypes.includes(node.type))
    .filter(node => {
      const normalized = query.trim().toLowerCase();
      return !normalized || `${node.label} ${node.description}`.toLowerCase().includes(normalized);
    });

  // Helper function to get the appropriate icon for each node type
  const getNodeIcon = (type: NodeType) => {
    switch (type) {
      case 'process':
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.primary.main, borderRadius: '50%' }}></div>;
      case 'finish':
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.success.main, borderRadius: '50%' }}></div>;
      case 'mcp':
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.info.main, borderRadius: '50%' }}></div>;
      case 'subflow':
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.warning.main, borderRadius: '50%' }}></div>;
      case 'resource':
        return <div style={{ width: 24, height: 24, backgroundColor: RESOURCE_COLOR, borderRadius: '50%' }}></div>;
      case 'signal':
        return <div style={{ width: 24, height: 24, backgroundColor: SIGNAL_COLOR, borderRadius: '50%' }}></div>;
      case 'trigger':
        return <div style={{ width: 24, height: 24, backgroundColor: TRIGGER_COLOR, borderRadius: '50%' }}></div>;
      default:
        return <div style={{ width: 24, height: 24, backgroundColor: theme.palette.primary.main, borderRadius: '50%' }}></div>;
    }
  };

  if (!open || !position) return null;

  return (
    <Portal>
      <ClickAwayListener onClickAway={onClose}>
        <Paper
        role="dialog"
        aria-modal="false"
        aria-labelledby="node-selection-title"
        elevation={16}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        sx={{
          position: 'fixed',
          top: {
            xs: 'auto',
            sm: anchorPosition
              ? `clamp(12px, ${anchorPosition.y + 10}px, calc(100dvh - 460px))`
              : '50%',
          },
          bottom: { xs: 12, sm: 'auto' },
          left: {
            xs: 12,
            sm: anchorPosition
              ? `clamp(12px, ${anchorPosition.x + 10}px, calc(100vw - 392px))`
              : '50%',
          },
          right: { xs: 12, sm: 'auto' },
          transform: { xs: 'none', sm: anchorPosition ? 'none' : 'translate(-50%, -50%)' },
          zIndex: (muiTheme) => muiTheme.zIndex.modal + 1,
          width: { xs: 'auto', sm: 380 },
          maxHeight: 'min(70dvh, 520px)',
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          borderRadius: 3.5,
          bgcolor: 'background.paper',
          boxShadow: theme.palette.mode === 'dark'
            ? '0 28px 80px rgba(0,0,0,.55)'
            : '0 28px 80px rgba(31,27,74,.22)',
          p: 1.5,
        }}
        >
        <Typography id="node-selection-title" variant="subtitle1" fontWeight={800}>
          {t('flows.canvas.addNext')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t('flows.canvas.autoConnect')}
        </Typography>
        <TextField
          autoFocus
          fullWidth
          size="small"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('flows.canvas.searchTypes')}
          inputProps={{ 'aria-label': t('flows.canvas.searchTypes') }}
          sx={{ my: 1.25 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRoundedIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Box display="flex" flexDirection="column" gap={0.75} sx={{ overflowY: 'auto', maxHeight: 360 }}>
          {availableNodeTypes.map((node) => (
            <Paper
              component="button"
              type="button"
              key={node.type}
              onClick={() => onSelectNodeType(node.type, position)}
              sx={{
                appearance: 'none',
                width: '100%',
                p: 1.1,
                textAlign: 'left',
                color: 'text.primary',
                bgcolor: 'transparent',
                borderRadius: 2.5,
                border: 1,
                borderColor: 'divider',
                cursor: 'pointer',
                transition: 'border-color 160ms ease, background-color 160ms ease, transform 160ms ease',
                '&:hover, &:focus-visible': {
                  outline: 'none',
                  borderColor:
                    node.type === 'finish'
                      ? theme.palette.success.main
                      : node.type === 'subflow'
                      ? theme.palette.warning.main
                      : node.type === 'resource'
                      ? RESOURCE_COLOR
                      : theme.palette.primary.main,
                  bgcolor: alpha(theme.palette.primary.main, 0.06),
                  transform: 'translateX(2px)',
                },
              }}
            >
              <Box display="flex" alignItems="center" gap={1.25}>
                {getNodeIcon(node.type)}
                <Box>
                  <Typography variant="subtitle2" fontWeight={800}>
                    {node.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {node.description}
                  </Typography>
                </Box>
              </Box>
            </Paper>
          ))}
          {availableNodeTypes.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
              {t('flows.canvas.noTypes')}
            </Typography>
          )}
        </Box>
        </Paper>
      </ClickAwayListener>
    </Portal>
  );
};

const FlowContainer = styled('div')(({ theme }) => ({
  flex: '1 1 0',
  height: '100%',
  minHeight: 0,
  width: '100%',
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: '18px',
  overflow: 'hidden',
  backgroundColor: theme.palette.background.paper,
  backgroundImage: `
    linear-gradient(${theme.palette.divider} 1px, transparent 1px),
    linear-gradient(90deg, ${theme.palette.divider} 1px, transparent 1px),
    radial-gradient(circle at 22% 0%, ${alpha(theme.palette.primary.main, 0.1)}, transparent 38%)
  `,
  backgroundSize: '28px 28px, 28px 28px, auto',
  boxShadow: theme.palette.mode === 'dark'
    ? 'inset 0 1px 0 rgba(255,255,255,.035), 0 22px 65px rgba(0,0,0,.24)'
    : 'inset 0 1px 0 rgba(255,255,255,.7), 0 22px 65px rgba(53,48,105,.1)',
  position: 'relative',
  [theme.breakpoints.down('sm')]: {
    flex: 'none',
    height: 440,
    minHeight: 440,
    maxWidth: '100%',
  },
}));


export const Canvas = forwardRef<HTMLDivElement, CanvasProps>((props, ref) => {
  const theme = useTheme();
  const isCompactCanvas = useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
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
    onCreateNode,
    onSelectNode,
    onConvertProcessToSubflow,
    onEditEdge,
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
    screenPosition?: { x: number; y: number } | null;
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

  // Validation and other non-modal surfaces use this event to reveal a node
  // in the persistent inspector. It deliberately selects instead of opening
  // the full properties editor.
  useEffect(() => {
    const handleSelectNodeEvent = (e: Event) => {
      const customEvent = e as CustomEvent<EditNodeEventDetail>;
      const nodeId = customEvent.detail?.nodeId;
      if (!nodeId) return;
      const node = findNodeById(nodeId, nodes);
      if (!node) return;
      onNodesChange([
        ...nodes
          .filter(candidate => candidate.selected && candidate.id !== nodeId)
          .map(candidate => ({ type: 'select' as const, id: candidate.id, selected: false })),
        { type: 'select' as const, id: nodeId, selected: true },
      ]);
      onSelectNode?.(node);
    };
    document.addEventListener('selectNode', handleSelectNodeEvent);
    return () => document.removeEventListener('selectNode', handleSelectNodeEvent);
  }, [nodes, onNodesChange, onSelectNode]);

  // Selected (or deliberately hovered) nodes expose small directional arrows.
  // Clicking one opens the exact same add-and-connect picker as releasing a
  // connection drag on the pane, with a sensible drop position synthesized
  // from that side of the node.
  useEffect(() => {
    const handleQuickConnect = (event: Event) => {
      const detail = (event as CustomEvent<FlowQuickConnectEventDetail>).detail;
      if (!detail?.nodeId || !detail.handleId) return;
      const sourceNode = findNodeById(detail.nodeId, nodes);
      if (!sourceNode) return;

      const sourceType = (sourceNode.type ?? sourceNode.data.type) as NodeType;
      const subflowHasOutgoing = sourceType === 'subflow' && edges.some(edge => {
        const data = edge.data as { edgeType?: string; bidirectional?: boolean } | undefined;
        if (data?.edgeType === 'mcp' || data?.edgeType === 'resource') return false;
        return edge.source === sourceNode.id
          || (edge.target === sourceNode.id && !!data?.bidirectional);
      });
      if (subflowHasOutgoing) return;

      const measured = (sourceNode as { measured?: { width?: number; height?: number } }).measured;
      const width = measured?.width ?? 210;
      const height = measured?.height ?? 90;
      const gap = 120;
      const nextNodeWidth = 210;
      const nextNodeHeight = 90;
      let position = { x: sourceNode.position.x, y: sourceNode.position.y + height + gap };
      if (detail.side === 'top') {
        position = { x: sourceNode.position.x, y: sourceNode.position.y - nextNodeHeight - gap };
      } else if (detail.side === 'right') {
        position = { x: sourceNode.position.x + width + gap, y: sourceNode.position.y };
      } else if (detail.side === 'left') {
        position = { x: sourceNode.position.x - nextNodeWidth - gap, y: sourceNode.position.y };
      }

      setNodeSelectionModal({
        open: true,
        position,
        screenPosition: { x: detail.clientX, y: detail.clientY },
        sourceNodeId: sourceNode.id,
        sourceNodeType: sourceType,
        sourceHandleId: detail.handleId,
      });
    };

    document.addEventListener(FLOW_QUICK_CONNECT_EVENT, handleQuickConnect);
    return () => document.removeEventListener(FLOW_QUICK_CONNECT_EVENT, handleQuickConnect);
  }, [edges, nodes]);

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

  // Live-drag gate. The canvas runs in ConnectionMode.Loose so ReactFlow's
  // built-in source→target handle-type check is off — that is what lets a
  // producer edge be drawn from a Process node's left resource handle to a
  // Resource node (issue #210). With that gate off, THIS callback is the only
  // thing keeping illegal draws invalid, so it defers to the shared
  // connection rules (via the silent isConnectionAllowed) exactly as the
  // commit-time validateConnection does. ReactFlow calls this with a
  // Connection on every pointer move, so the check must stay side-effect free.
  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      isConnectionAllowed(connection as Connection, nodes, edges),
    [nodes, edges]
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

      // Disarm any Trigger node being deleted: set the linked PlannedExecution
      // to enabled=false so the SchedulerService stops firing it, but preserve
      // the record for audit purposes (issue #241, Phase 4.6.3).
      const triggerNodesToDelete = deletableNodes.filter(n => n.type === 'trigger');
      if (triggerNodesToDelete.length > 0) {
        await Promise.all(
          triggerNodesToDelete.map(async (tn) => {
            const execId = tn.data?.properties?.executionId;
            if (typeof execId === 'string' && execId) {
              try {
                await plannedExecutionsService.update(execId, { enabled: false });
              } catch (e) {
                // Best-effort: if the API call fails, still allow the node to be
                // deleted from the canvas. The execution record will remain armed
                // but the canvas-level link is gone.
                console.warn('TriggerNode: failed to disarm PlannedExecution', execId, e);
              }
            }
          })
        );
      }

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

  // Handle edit properties from context menu. Branches on whether the menu
  // targets a node or an edge — an edge opens the EdgePropertiesModal (Tier 2b
  // condition editor) via the onEditEdge callback surfaced from FlowBuilder.
  const handleEditProperties = useCallback(() => {
    if (contextMenu.nodeId && onEditNode) {
      const node = findNodeById(contextMenu.nodeId, nodes);
      if (node) {
        onEditNode(node);
      }
    } else if (contextMenu.edgeId && onEditEdge) {
      const edge = edges.find(e => e.id === contextMenu.edgeId);
      if (edge) {
        onEditEdge(edge);
      }
    }
  }, [contextMenu.nodeId, contextMenu.edgeId, nodes, edges, onEditNode, onEditEdge]);

  const handleConvertToSubflow = useCallback(() => {
    if (!contextMenu.nodeId || !onConvertProcessToSubflow) return;
    const node = findNodeById(contextMenu.nodeId, nodes);
    if (node?.type === 'process' || node?.data?.type === 'process') {
      onConvertProcessToSubflow(node);
    }
  }, [contextMenu.nodeId, nodes, onConvertProcessToSubflow]);

  // Toggle a flow-control edge between one-way and bidirectional from the edge
  // context menu. Reuses the exact marker logic of the bidirectional drag path
  // (add/remove the start arrowhead) and only turns an edge ON when the reverse
  // direction is itself a legal connection (canConvertToBidirectional).
  const handleToggleBidirectional = useCallback(() => {
    if (!contextMenu.edgeId) return;
    const edge = edges.find(e => e.id === contextMenu.edgeId);
    if (!edge) return;
    // Only plain flow-control edges support bidirectional handoff; mcp/resource
    // wiring edges are config, not control flow.
    const isStandard = (edge.data as { edgeType?: string } | undefined)?.edgeType === 'standard';
    if (!isStandard) {
      log.debug(`Toggle bidirectional ignored for non-standard edge ${edge.id}`);
      return;
    }
    const current = !!(edge.data as { bidirectional?: boolean } | undefined)?.bidirectional;
    if (!current && !canConvertToBidirectional(edge, nodes, edges)) {
      log.info(`Edge ${edge.id} cannot be made bidirectional (reverse direction is not a legal connection)`);
      return;
    }
    const nextData = { ...(edge.data ?? {}), bidirectional: !current };
    let item: Edge;
    if (current) {
      // Turning OFF: drop the start arrowhead so only the forward arrow remains.
      const { markerStart: _drop, ...rest } = edge as Edge & { markerStart?: unknown };
      item = { ...rest, data: nextData } as Edge;
    } else {
      item = {
        ...edge,
        data: nextData,
        markerStart: {
          type: MarkerType.ArrowClosed,
          width: 20,
          height: 20,
          color: theme.palette.text.secondary,
        },
      } as Edge;
    }
    onEdgesChange([{ type: 'replace', id: edge.id, item }]);
  }, [contextMenu.edgeId, edges, nodes, onEdgesChange, theme.palette.text.secondary]);

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
      const { fromNode, fromHandle, toHandle } = connectionState;
      if (!fromNode || !fromHandle?.id || !reactFlowInstance) {
        log.debug('onConnectEnd: No valid connection start data');
        return;
      }

      log.debug(`onConnectEnd: Connection ended from node ${fromNode.id}, handle ${fromHandle.id}`);

      // A subflow has a single outgoing path — once it has one, dropping on
      // the pane must not offer to create a second successor. (The same rule
      // is enforced for direct connections in validateConnection.) Attachment
      // (mcp/resource) edges are config wiring, not successors.
      const subflowHasOutgoing =
        fromNode.type === 'subflow' &&
        edges.some(e => {
          const data = e.data as { edgeType?: string; bidirectional?: boolean } | undefined;
          if (data?.edgeType === 'mcp' || data?.edgeType === 'resource') return false;
          return e.source === fromNode.id || (e.target === fromNode.id && !!data?.bidirectional);
        });

      // Robust pane detection: `closest` tolerates the pointer being released
      // over a child/overlay of the pane, and the `toHandle` check ensures a
      // handle→handle drag (owned by onConnect) never opens the picker. Together
      // they fix the popup that appeared while drawing connections (#133).
      const droppedOnPane = !!(event.target as Element | null)?.closest?.('.react-flow__pane');

      if (!shouldOpenNodePicker({
        fromNodeType: fromNode.type,
        fromHandleType: fromHandle.type,
        fromHandleId: fromHandle.id,
        landedOnHandle: !!toHandle,
        droppedOnPane,
        subflowHasOutgoing,
      })) {
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
        screenPosition: { x: point.clientX, y: point.clientY },
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

      // Create through the parent-owned factory so every creation path shares
      // constraints (notably the one-Trigger limit) and selection behavior.
      if (nodeType === 'trigger' && nodes.some(node => node.type === 'trigger')) {
        setNodeSelectionModal({ open: false, position: null });
        return;
      }

      // Validate the proposed edge before committing the node. The picker is a
      // one-click "insert and connect" action; if that insertion is no longer
      // legal (for example because the source gained a successor), it must not
      // leave a disconnected node behind.
      const preparedNode = flowService.createNode(nodeType, position);
      const { sourceNodeId, sourceHandleId } = nodeSelectionModal;
      const sourceNode = sourceNodeId ? findNodeById(sourceNodeId, nodes) : undefined;
      let pendingConnection: Connection | null = null;
      if (sourceNode && sourceHandleId) {
        pendingConnection = {
          source: sourceNode.id,
          sourceHandle: sourceHandleId,
          target: preparedNode.id,
          targetHandle: defaultTargetHandleFor(nodeType, sourceHandleId),
        };
        if (!validateConnection(pendingConnection, [...nodes, preparedNode], edges)) {
          setNodeSelectionModal({ open: false, position: null });
          return;
        }
      }

      const newNode = onCreateNode
        ? onCreateNode(nodeType, position, preparedNode)
        : preparedNode;
      if (!newNode) {
        setNodeSelectionModal({ open: false, position: null });
        return;
      }
      if (!onCreateNode) {
        onNodesChange(buildAddNodeChanges(newNode));
      }

      if (pendingConnection) {
        log.debug(`handleNodeTypeSelection: Creating connection from ${pendingConnection.source} to ${pendingConnection.target}`);
        const edge = createEdgeFromConnection(pendingConnection, [...nodes, newNode]);
        const replaced = getReplacedEdgeIds(edge, edges);
        onEdgesChange([
          ...replaced.map(id => ({ type: 'remove' as const, id })),
          { type: 'add' as const, item: edge },
        ]);

        log.debug(`handleNodeTypeSelection: Edge created with id ${edge.id}`);
      }

      // Close the modal; this also discards the consumed connection source.
      setNodeSelectionModal({ open: false, position: null });

      // The persistent inspector follows selection; no blocking editor opens.
      onSelectNode?.(newNode);
    },
    [
      nodeSelectionModal,
      nodes,
      edges,
      buildAddNodeChanges,
      onNodesChange,
      onEdgesChange,
      onCreateNode,
      onSelectNode,
    ]
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
      style={isCompactCanvas ? {
        flex: 'none',
        width: '100%',
        maxWidth: '100%',
        height: 440,
        minHeight: 440,
      } : undefined}
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
          animated: false,
          style: { stroke: theme.palette.text.secondary, strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 20,
            height: 20,
            color: theme.palette.text.secondary,
          },
        }), [theme.palette.text.secondary])}
        connectionLineType={ConnectionLineType.SmoothStep}
        // Loose mode drops ReactFlow's built-in source→target handle-type gate
        // so a producer edge (Process → Resource) can be drawn from the
        // Process node's left resource handle (issue #210). Legality is
        // re-imposed by isValidConnection, which defers to the shared
        // connection rules.
        connectionMode={ConnectionMode.Loose}
        connectionRadius={isCompactCanvas ? 44 : 30}
        isValidConnection={isValidConnection}
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
        onNodeClick={(_event, node) => onSelectNode?.(node as FlowNode)}
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
        <CanvasControls showMiniMap={!isCompactCanvas} />
      </ReactFlow>

      <ContextMenu
        open={contextMenu.open}
        position={contextMenu.position}
        onClose={closeContextMenu}
        onDelete={handleDelete}
        onEditProperties={handleEditProperties}
        onConvertToSubflow={
          onConvertProcessToSubflow && contextMenu.nodeId && nodes.find(node => node.id === contextMenu.nodeId)?.type === 'process'
            ? handleConvertToSubflow
            : undefined
        }
        onToggleBidirectional={handleToggleBidirectional}
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
        anchorPosition={nodeSelectionModal.screenPosition}
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
