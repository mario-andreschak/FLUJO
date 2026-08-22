"use client";

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { styled, useTheme } from '@mui/material/styles';
import {
  Box,
  Button,
  Menu,
  MenuItem,
  TextField,
  Paper,
  Typography,
  Divider,
  IconButton,
  Tooltip,
  Chip,
  CircularProgress,
  FormControlLabel,
  Switch,
  useMediaQuery,
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import { validateFlowDisplayName } from '@/utils/shared/flowNamePolicy';
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
  Edge, 
  NodeChange, 
  EdgeChange, 
  ReactFlowInstance, 
  applyNodeChanges,
  applyEdgeChanges
} from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import { Flow, FlowNode, HistoryEntry, NodeType } from '@/shared/types/flow';
import { flowService } from '@/frontend/services/flow';
import { mcpService } from '@/frontend/services/mcp';
import { modelService } from '@/frontend/services/model';
import {
  BIG_TUTORIAL_EVENT,
  emitBigTutorialEvent,
  isBigTutorialEvent,
} from '@/frontend/components/Tour/bigTutorialEvents';
import { createEdgeFromConnection, validateConnection } from './Canvas/utils/edgeUtils';
import { defaultTargetHandleFor } from './Canvas/utils/connectionRules';
import { computeAutoLayout } from './Canvas/utils/autoLayout';
import { computeTidyLayout } from './Canvas/utils/tidyLayout';
import { migrateHandoffPills } from './utils/handoffPillMigration';
import { reconcileStaticToolConnections } from './utils/staticToolConnections';
import { Canvas } from './Canvas/index';
import { NodePalette } from './NodePalette';
import { getNodeTypes } from './nodeTypeCatalog';
import { FlowValidationButton } from './FlowValidationButton';
import InspectorPanel from './InspectorPanel';
import type { InspectorMcpServerOption } from './InspectorMcpServers';
import GuidedFlowComposer from './GuidedFlowComposer';
import type { GuidedAgentConnection } from './GuidedAgentConnections';
import FlowAssistanceDialog from './FlowAssistanceDialog';
import ProcessNodePropertiesModal from './Modals/ProcessNodePropertiesModal';
import MCPNodePropertiesModal from './Modals/MCPNodePropertiesModal';
import StartNodePropertiesModal from './Modals/StartNodePropertiesModal';
import FinishNodePropertiesModal from './Modals/FinishNodePropertiesModal';
import EdgePropertiesModal from './Modals/EdgePropertiesModal';
import NodeTechnicalDetailsModal from './Modals/NodeTechnicalDetailsModal';
import SubflowNodePropertiesModal from './Modals/SubflowNodePropertiesModal';
import ResourceNodePropertiesModal from './Modals/ResourceNodePropertiesModal';
import SignalNodePropertiesModal from './Modals/SignalNodePropertiesModal';
import StaticNodePropertiesModal from './Modals/StaticNodePropertiesModal';
import TriggerNodePropertiesModal from './Modals/TriggerNodePropertiesModal';
import FlowVersionHistoryDialog from './Modals/FlowVersionHistoryDialog';
import ConvertProcessToSubflowDialog from './Modals/ConvertProcessToSubflowDialog';
import type { ProcessToSubflowDraft } from './utils/convertProcessToSubflow';
import SaveIcon from '@mui/icons-material/Save';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import AddIcon from '@mui/icons-material/Add';
import ImproveFlowDialog, { ImprovedFlowInfo } from '../ImproveFlowDialog';
import { autoRepairFlow } from '@/utils/shared/flowAutoRepair';
import { EdgeCondition } from '@/utils/shared/edgeConditions';
import { Collapse } from '@mui/material';
import AutoAwesomeMotionRoundedIcon from '@mui/icons-material/AutoAwesomeMotionRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloudOffRoundedIcon from '@mui/icons-material/CloudOffRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import { useWorkspaceUiPreference } from '@/frontend/hooks/useUiPreference';
import {
  flowUsesAdvancedFeatures,
  type FlowAuthoringMode,
} from '@/utils/shared/flowAuthoringProfile';
import type { Model } from '@/shared/types/model';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { FlowNamesContext } from './CustomNodes/flowNamesContext';
import {
  configureGuidedSubagentEdge,
  configureGuidedSubagentNode,
  getGuidedSubagentLinks,
} from '@/utils/shared/guidedSubagents';
import { reconcileHandoffPromptForTopologyChange } from '@/utils/shared/handoffPrompt';
import { resolveAutoNodeLabel } from '@/shared/utils/nodeLabel';
import { useAskFlujoPage } from '@/frontend/contexts/AskFlujoContext';
import type { AskFlujoUiAction } from '@/frontend/types/askFlujo';
import {
  highlightAskFlujoElement,
  setAskFlujoValueAtPath,
} from '@/frontend/utils/askFlujoActions';

const FlowBuilderContainer = styled(Box)(({ theme }) => ({
  display: 'flex',
  height: '100%',
  minHeight: 0,
  gap: '12px',
  padding: '12px',
  overflow: 'hidden',
  backgroundColor: 'transparent',
  [theme.breakpoints.down('md')]: {
    flexDirection: 'column',
    gap: '8px',
    padding: '8px',
    height: 'auto',
    overflow: 'visible',
  },
}));

const ToolbarContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(1.1),
  display: 'flex',
  flexWrap: 'wrap',
  gap: theme.spacing(1),
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: 14,
  alignItems: 'center',
  marginBottom: theme.spacing(1),
  backgroundColor: theme.palette.mode === 'dark'
    ? 'rgba(17, 22, 41, 0.86)'
    : 'rgba(255, 255, 255, 0.9)',
  boxShadow: theme.palette.mode === 'dark'
    ? '0 16px 45px rgba(0,0,0,.25)'
    : '0 16px 45px rgba(49,45,99,.1)',
  backdropFilter: 'blur(20px) saturate(140%)',
}));

const MainContent = styled(Box)(({ theme }) => ({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  overflow: 'hidden',
  minWidth: 0,
  minHeight: 0,
  [theme.breakpoints.down('md')]: {
    flex: '0 0 640px',
    height: 640,
    overflow: 'hidden',
  },
  [theme.breakpoints.down('sm')]: {
    flexBasis: 'auto',
    height: 'auto',
    minHeight: 0,
    overflow: 'visible',
  },
}));

interface FlowBuilderProps {
  initialFlow?: Flow;
  /**
   * Explicit view requested by the entry action. This takes precedence over
   * automatic Expert detection for the initial render (for example, the AI
   * generator's "Continue to simple builder" action).
   */
  initialAuthoringMode?: FlowAuthoringMode;
  /**
   * Resolves false when persistence failed. The builder only clears its dirty
   * state after this promise succeeds.
   */
  onSave: (flow: Flow) => boolean | void | Promise<boolean | void>;
  onDelete: (flowId: string) => void;
  onConversionCommitted?: (parentFlow: Flow, childFlow: Flow) => void;
  allFlows: Flow[];
  relatedDraftFlows?: Flow[];
  onRelatedDraftFlowsChange?: (flows: Flow[]) => void;
  isDraft?: boolean;
  onTry?: () => void;
  onNavigateToFlow?: (flowId: string) => void;
}

// Imperative handle for the parent page: navigation away from the builder
// (e.g. back to the dashboard) must go through requestNavigation so unsaved
// changes get a Save/Discard dialog instead of being silently dropped.
export interface FlowBuilderHandle {
  requestNavigation: (navigate: () => void) => void;
}

// Dialog types for save/copy/rename
type DialogType = 'none' | 'duplicate' | 'rename' | 'unsaved';

// What handleSave actually did — callers that navigate afterwards must only
// proceed on 'saved' ('rename-dialog' means the save was diverted into the
// rename dialog, 'invalid-name' means nothing was saved).
type SaveResult = 'saved' | 'invalid-name' | 'failed';
type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

const GUIDED_CONTROL_TYPES = new Set<NodeType>(['start', 'process', 'finish', 'subflow', 'signal']);
const isPlaceholderGuidedName = (name: string, localizedUntitled?: string) => {
  const normalized = name.trim();
  return /^(?:NewFlow\d*|Untitled (?:assistant|agent)(?: \d+)?)$/i.test(normalized)
    || (!!localizedUntitled
      && normalized.toLocaleLowerCase() === localizedUntitled.trim().toLocaleLowerCase());
};

const getPreferredGuidedModelId = (models: Model[]): string | null =>
  (models.find(model => model.favorite) ?? models[0])?.id ?? null;

/**
 * Guided mode is intentionally a lossless view over one linear control path.
 * Attachment edges are ignored, while branches, cycles, duplicate endpoints,
 * and disconnected control steps are handed off to the expert editor.
 */
const analyzeGuidedGraph = (nodes: FlowNode[], edges: Edge[]) => {
  const subagentNodeIds = new Set(
    getGuidedSubagentLinks(nodes, edges).map(link => link.subflowNodeId),
  );
  const controlNodes = nodes.filter(node =>
    GUIDED_CONTROL_TYPES.has(node.data.type as NodeType)
    && !subagentNodeIds.has(node.id)
  );
  const controlNodeIds = new Set(controlNodes.map(node => node.id));
  const controlEdges = edges.filter(edge =>
    controlNodeIds.has(edge.source)
    && controlNodeIds.has(edge.target)
    && (edge.data as { edgeType?: string } | undefined)?.edgeType !== 'resource'
  );
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();

  controlEdges.forEach((edge) => {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  });

  const startNodes = controlNodes.filter(node => node.data.type === 'start');
  const finishNodes = controlNodes.filter(node => node.data.type === 'finish');
  let unsafe = startNodes.length !== 1 || finishNodes.length > 1;

  controlNodes.forEach((node) => {
    const incomingCount = incoming.get(node.id)?.length ?? 0;
    const outgoingCount = outgoing.get(node.id)?.length ?? 0;
    if (node.data.type === 'start') {
      unsafe ||= incomingCount !== 0 || outgoingCount > 1;
    } else if (node.data.type === 'finish') {
      unsafe ||= incomingCount !== 1 || outgoingCount !== 0;
    } else {
      unsafe ||= incomingCount !== 1 || outgoingCount > 1;
    }
  });

  const orderedNodeIds: string[] = [];
  const visited = new Set<string>();
  let currentId = startNodes[0]?.id;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    orderedNodeIds.push(currentId);
    const nextEdges = outgoing.get(currentId) ?? [];
    if (nextEdges.length !== 1) break;
    currentId = nextEdges[0].target;
  }

  unsafe ||= controlNodes.length === 0 || visited.size !== controlNodes.length;
  return { unsafe, orderedNodeIds, subagentNodeIds };
};

export const FlowBuilder = React.forwardRef<FlowBuilderHandle, FlowBuilderProps>(({ initialFlow, initialAuthoringMode, onSave, onDelete, onConversionCommitted, allFlows, relatedDraftFlows = [], onRelatedDraftFlowsChange, isDraft = false, onTry, onNavigateToFlow }, ref) => {
  log.debug('FlowBuilder rendered with initialFlow:', initialFlow);
  const { t, tp, formatList } = useI18n();
  const theme = useTheme();
  const isMobileBuilder = useMediaQuery(theme.breakpoints.down('md'), { noSsr: true });

  const [nodes, setNodes] = useState<FlowNode[]>(initialFlow?.nodes || []);

  useEffect(() => {
    const listener = (event: Event) => {
      if (!isBigTutorialEvent(event) || event.detail.type !== 'prepare-app-picker') return;
      const { processNodeId, query } = event.detail;
      setNodes(current => current.map(node => ({
        ...node,
        selected: node.id === processNodeId,
      })));
      window.setTimeout(() => emitBigTutorialEvent({
        type: 'filter-app-picker',
        query,
      }), 150);
    };
    window.addEventListener(BIG_TUTORIAL_EVENT, listener);
    return () => window.removeEventListener(BIG_TUTORIAL_EVENT, listener);
  }, []);
  // Initialize with the *filtered* edges (same rule the init effect applies)
  // so the very first render already matches what history is seeded with —
  // otherwise an unfiltered→filtered diff could itself mark the flow dirty.
  const [edges, setEdges] = useState<Edge[]>(
    (initialFlow?.edges || []).filter(
      edge => edge.source && edge.target && edge.sourceHandle && edge.targetHandle
    )
  );
  const [flowName, setFlowName] = useState<string>(initialFlow?.name || t('flows.page.untitled'));
  const flowNameRef = useRef(flowName);
  flowNameRef.current = flowName;
  const [flowNameError, setFlowNameError] = useState<string | null>(null);
  // Optional free-text description shown on the Flow Card (#70).
  const [flowDescription, setFlowDescription] = useState<string>(initialFlow?.description || '');
  const flowNames = useMemo(
    () => new Map(allFlows.map((flow) => [flow.id, flow.name])),
    [allFlows],
  );
  const initialFlowRequiresExpert = !!initialFlow && (
    flowUsesAdvancedFeatures({
      nodes: initialFlow.nodes || [],
      edges: initialFlow.edges || [],
    })
    || analyzeGuidedGraph(initialFlow.nodes || [], initialFlow.edges || []).unsafe
  );
  const [persistedAuthoringMode, setPersistedAuthoringMode] = useWorkspaceUiPreference<FlowAuthoringMode>(
    'flujo-ui:flow-builder:mode',
    'guided',
  );
  const [authoringMode, setLocalAuthoringMode] = useState<FlowAuthoringMode>(
    () => initialAuthoringMode ?? (initialFlowRequiresExpert ? 'advanced' : persistedAuthoringMode),
  );
  const setAuthoringMode = useCallback((mode: FlowAuthoringMode) => {
    setLocalAuthoringMode(mode);
    setPersistedAuthoringMode(mode);
  }, [setPersistedAuthoringMode]);
  const hasHiddenAdvancedFeatures = flowUsesAdvancedFeatures({
    nodes,
    edges,
  });
  const guidedGraph = analyzeGuidedGraph(nodes, edges);
  const hasUnsafeGuidedGraph = hasHiddenAdvancedFeatures || guidedGraph.unsafe;

  // Dialog states
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [dialogType, setDialogType] = useState<DialogType>('none');
  const [newFlowName, setNewFlowName] = useState<string>('');
  const [newFlowNameError, setNewFlowNameError] = useState<string | null>(null);
  
  // Modal states
  const [processModalOpen, setProcessModalOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [quickMcpServerPicker, setQuickMcpServerPicker] = useState(false);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [finishModalOpen, setFinishModalOpen] = useState(false);
  const [subflowModalOpen, setSubflowModalOpen] = useState(false);
  const [resourceModalOpen, setResourceModalOpen] = useState(false);
  const [signalModalOpen, setSignalModalOpen] = useState(false);
  const [staticModalOpen, setStaticModalOpen] = useState(false);
  const [triggerModalOpen, setTriggerModalOpen] = useState(false);
  // Read-only technical details for the selected node (issue #412). Only the
  // node id is stored so the dialog always reflects the live node data.
  const [technicalDetailsNodeId, setTechnicalDetailsNodeId] = useState<string | null>(null);
  // Compact, non-blocking feedback for rejected quick-authoring actions.
  const [builderNotice, setBuilderNotice] = useState<string | null>(null);
  const [nodeToEdit, setNodeToEdit] = useState<FlowNode | null>(null);
  const [processNodeModalMode, setProcessNodeModalMode] = useState<'create' | 'edit'>('edit');
  // The edge whose properties (Tier 2b routing condition) are being edited.
  const [editingEdge, setEditingEdge] = useState<Edge | null>(null);
  const [conversionProcessId, setConversionProcessId] = useState<string | null>(null);

  // AI-Improve (issue #99): the dialog that revises the current flow, plus a transient
  // notice summarizing the last improvement (validation counts / installed servers).
  const [improveDialogOpen, setImproveDialogOpen] = useState(false);
  const [improveNotice, setImproveNotice] = useState<
    { severity: 'success' | 'info' | 'warning'; message: string } | null
  >(null);
  // Secondary toolbar actions are grouped into accessible overflow menus.
  // AI repair still reuses the Improve dialog with a pre-filled instruction.
  const [addNodeMenuAnchor, setAddNodeMenuAnchor] = useState<null | HTMLElement>(null);
  const [moreActionsMenuAnchor, setMoreActionsMenuAnchor] = useState<null | HTMLElement>(null);
  const [improveInitialDescription, setImproveInitialDescription] = useState('');

  // Version history: browse/preview/restore archived versions of a saved flow.
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  
  // History for undo/redo functionality
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isHistoryAction, setIsHistoryAction] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(isDraft ? 'unsaved' : 'saved');
  const [guidedModels, setGuidedModels] = useState<Model[]>([]);
  const [guidedModelsLoaded, setGuidedModelsLoaded] = useState(false);
  const [guidedSelectedModelId, setGuidedSelectedModelId] = useState<string | null>(null);
  const [guidedAiAssistance, setGuidedAiAssistance] = useState<'unasked' | 'manual' | 'assisted'>(
    () => isDraft && !(initialFlow?.nodes ?? []).some(node => node.data.type === 'process') ? 'unasked' : 'manual',
  );
  const [assistanceOpen, setAssistanceOpen] = useState(false);
  const [assistanceNodeId, setAssistanceNodeId] = useState<string | null>(null);
  const [assistanceFocus, setAssistanceFocus] = useState<'apps' | 'agents' | 'review'>('apps');
  const fallbackFlowId = useRef(initialFlow?.id ?? uuidv4());
  const editRevisionRef = useRef(0);
  const savePromiseRef = useRef<Promise<SaveResult> | null>(null);
  // Synchronous reservation closes the gap between rapid creation events and
  // React's next render, so two quick clicks cannot enqueue two Trigger nodes.
  const triggerCreationReservedRef = useRef(nodes.some(node => node.type === 'trigger'));
  triggerCreationReservedRef.current = nodes.some(node => node.type === 'trigger');
  // Navigation deferred by the unsaved-changes dialog; runs on Save/Discard,
  // cleared on Cancel.
  const pendingNavigationRef = useRef<(() => void) | null>(null);
  // True while a node drag is in flight — history snapshots wait for the end
  // of the gesture.
  const isDraggingRef = useRef(false);
  // True until the initial flow state has been seeded into history. Stops the
  // history-tracking effect from treating that initial seed as a user edit,
  // which otherwise marks a freshly-opened flow as "dirty" and forces the
  // Save/Discard dialog on navigate-away even when nothing was changed (#69).
  const isInitializingRef = useRef(true);

  useEffect(() => {
    let active = true;
    void modelService.loadModels().then((models) => {
      if (!active) return;
      setGuidedModels(models);
      setGuidedModelsLoaded(true);
      setGuidedSelectedModelId(current =>
        current && models.some(model => model.id === current)
          ? current
          : getPreferredGuidedModelId(models)
      );
      if (models.length === 0) {
        setGuidedAiAssistance(current => current === 'unasked' ? 'manual' : current);
      }
    }).catch((error) => {
      log.warn('Could not load connected AIs for Guided mode', error);
      if (active) {
        setGuidedModels([]);
        setGuidedModelsLoaded(true);
        setGuidedAiAssistance(current => current === 'unasked' ? 'manual' : current);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  
  // Filter out invalid edges (missing source/target handles)
  const filterInvalidEdges = useCallback((edges: Edge[]): Edge[] => {
    return edges
      .filter(edge =>
        edge.source &&
        edge.target &&
        edge.sourceHandle &&
        edge.targetHandle
      )
      // Resilience for previously-saved / AI-generated flows (issue #223):
      // rendering keys off `edge.type` but every logic path discriminates on
      // `data.edgeType`. If a legacy payload marked an edge as a resource
      // (data-flow) edge in its data but missed the matching `type`, it would
      // render as a plain control edge. Coerce the render type in memory only
      // — the persisted file is never rewritten — so resource edges always show
      // the resource styling regardless of edge age.
      .map(edge =>
        (edge.data as { edgeType?: string } | undefined)?.edgeType === 'resource' &&
        edge.type !== 'resourceEdge'
          ? { ...edge, type: 'resourceEdge' }
          : edge
      );
  }, []);

  // Initialize history with initial state
  useEffect(() => {
    // Re-arm the initialization guard so the state updates this effect makes
    // (nodes/edges/history) don't register as a user edit in the
    // history-tracking effect below.
    isInitializingRef.current = true;
    editRevisionRef.current = 0;
    setHasUnsavedChanges(false);
    setSaveStatus(isDraft ? 'unsaved' : 'saved');
    if (initialFlow) {
      const rawNodes = initialFlow.nodes || [];
      // Filter out invalid edges before layout so the mobile arrangement only
      // follows connections that can actually render.
      const validEdges = filterInvalidEdges(initialFlow.edges || []);
      const shouldAutoAlignForMobile = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 899.95px)').matches;
      // A phone-sized canvas is especially hard to recover when saved nodes
      // are far apart. Treat this layout as the in-memory opening baseline so
      // it neither creates an Undo step nor marks the untouched flow dirty.
      const openingNodes = shouldAutoAlignForMobile
        ? computeAutoLayout(rawNodes, validEdges, {
            rankSep: 90,
            nodeSep: 48,
            mcpOffsetX: 270,
            mcpStackY: 100,
          })
        : rawNodes;
      const seededNodes = isDraft
        ? openingNodes.map(node => ({ ...node, selected: false }))
        : openingNodes;
      setNodes(seededNodes);
      
      if (validEdges.length !== initialFlow.edges.length) {
        console.warn(`Filtered out ${initialFlow.edges.length - validEdges.length} invalid edges`);
      }
      setEdges(validEdges);
      setFlowName(initialFlow.name);
      setFlowDescription(initialFlow.description || '');
      // Guided mode cannot safely author every graph shape or runtime option.
      // Open those flows directly in Expert view unless the action that opened
      // the builder explicitly requested a view. The guided composer can still
      // present an advanced-feature warning without breaking that handoff.
      const requiresExpert = flowUsesAdvancedFeatures({
        nodes: rawNodes,
        edges: validEdges,
      }) || analyzeGuidedGraph(rawNodes, validEdges).unsafe;
      if (initialAuthoringMode) {
        setAuthoringMode(initialAuthoringMode);
      } else if (requiresExpert) {
        setAuthoringMode('advanced');
      }

      // Initialize history with initial state
      const initialState: HistoryEntry = {
        nodes: seededNodes,
        edges: validEdges
      };
      setHistory([initialState]);
      setHistoryIndex(0);
    } else {
      // Create a new flow with a Start node
      const startNode = flowService.createStartNode();

      setNodes([startNode]);
      setEdges([]);
      setFlowName(t('flows.page.untitled'));
      setFlowDescription('');
      // Initialize history with the Start node
      const emptyState: HistoryEntry = {
        nodes: [startNode],
        edges: []
      };
      setHistory([emptyState]);
      setHistoryIndex(0);
    }
  // The builder owns edits for the lifetime of a selected flow. Parent state may
  // receive a freshly saved object (including new timestamps) without resetting
  // undo history; only switching to a different flow reinitializes the canvas.
  }, [initialFlow?.id, initialAuthoringMode, setAuthoringMode]);
  
  // Keys that don't represent a real edit: selection/drag/measurement state
  // must create neither an undo step nor "unsaved changes".
  const serializeForHistory = (entry: HistoryEntry) =>
    JSON.stringify(entry, (key, value) =>
      key === 'selected' || key === 'dragging' || key === 'measured' ||
      key === 'width' || key === 'height' || key === 'positionAbsolute' || key === 'resizing'
        ? undefined
        : value
    );

  // Add to history when nodes or edges change. While a node is being dragged
  // this is suppressed (React Flow emits a position change per pointer move);
  // one entry is recorded when the drag ends, so Undo rewinds whole gestures
  // instead of a few pixels at a time and large flows don't stutter on drag.
  useEffect(() => {
    if (isHistoryAction) {
      setIsHistoryAction(false);
      return;
    }
    // Initial seed of the history entry is done by the init effect above; don't
    // let it count as an edit (that would spuriously mark the flow dirty). #69
    if (isInitializingRef.current) {
      isInitializingRef.current = false;
      return;
    }
    if (isDraggingRef.current) {
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
      serializeForHistory(newEntry) !== serializeForHistory(newHistory[historyIndex])
    ) {
      setHistory([...newHistory, newEntry]);
      setHistoryIndex(historyIndex + 1);
      setHasUnsavedChanges(true);
      editRevisionRef.current += 1;
      setSaveStatus('unsaved');
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
      return t('flows.page.nameEmpty');
    }
    
    // Human-facing names may contain spaces; IDs remain the stable machine key.
    if (validateFlowDisplayName(name) !== null) {
      return t('flows.page.nameCharacters');
    }
    
    // Check for duplicate names (only if it's a new flow or the name has changed)
    if (!initialFlow || (initialFlow && initialFlow.name !== name)) {
      const isDuplicate = allFlows.some(flow => 
        flow.id !== (initialFlow?.id || '') && 
        flow.name.trim().toLowerCase() === name.trim().toLowerCase()
      );
      
      if (isDuplicate) {
        return t('flows.page.nameDuplicate');
      }
    }
    
    return null;
  };

  const markDirty = useCallback(() => {
    setHasUnsavedChanges(true);
    editRevisionRef.current += 1;
    setSaveStatus('unsaved');
  }, []);

  // Handle save flow
  const handleSave = useCallback((): Promise<SaveResult> => {
    // Keyboard shortcuts and pointer actions share this promise. This matters
    // most for a new draft, where duplicate in-flight POSTs could create two
    // flows before the parent has received the first saved result.
    if (savePromiseRef.current) return savePromiseRef.current;

    const savePromise = (async (): Promise<SaveResult> => {
      log.debug(`handleSave: Attempting to save flow "${flowName}"`);

      // Validate flow name
      const error = validateFlowName(flowName);
      if (error) {
        log.warn(`handleSave: Invalid flow name - ${error}`);
        setFlowNameError(error);
        return 'invalid-name';
      }
      // Ensure there's at least a Start node in the flow
      let flowNodes = [...nodes];

      // If there are no nodes, add a Start node
      if (flowNodes.length === 0) {
        log.debug(`handleSave: No nodes found, adding a default Start node`);
        flowNodes = [flowService.createStartNode()];
        setNodes(flowNodes);
      }

      const flow: Flow = {
        id: initialFlow?.id || uuidv4(),
        name: flowName.trim(),
        description: flowDescription,
        nodes: flowNodes,
        edges,
        folder: initialFlow?.folder,    // Preserve folder assignment
        favorite: initialFlow?.favorite, // Preserve favorite status
      };

      log.info(`handleSave: Saving flow "${flowName}" with ${flowNodes.length} nodes and ${edges.length} edges`);
      const submittedRevision = editRevisionRef.current;
      setSaveStatus('saving');
      try {
        const result = await onSave(flow);
        if (result === false) {
          setSaveStatus('error');
          return 'failed';
        }
        // If the user changed the canvas while the request was in flight, the
        // submitted snapshot is saved but the newer working state remains dirty.
        if (editRevisionRef.current === submittedRevision) {
          setHasUnsavedChanges(false);
          setSaveStatus('saved');
        } else {
          setHasUnsavedChanges(true);
          setSaveStatus('unsaved');
        }
        return 'saved';
      } catch (error) {
        log.error('handleSave: Persistence failed', error);
        setSaveStatus('error');
        setHasUnsavedChanges(true);
        return 'failed';
      }
    })();

    savePromiseRef.current = savePromise;
    void savePromise.finally(() => {
      if (savePromiseRef.current === savePromise) {
        savePromiseRef.current = null;
      }
    });
    return savePromise;
  }, [flowName, flowDescription, nodes, edges, initialFlow, onSave]);

  const handleTry = useCallback(async () => {
    if (!onTry) return;
    if (isDraft || hasUnsavedChanges || saveStatus !== 'saved') {
      const result = await handleSave();
      if (result !== 'saved') return;
    }
    onTry();
  }, [onTry, isDraft, hasUnsavedChanges, saveStatus, handleSave]);

  // Navigation guard: the parent must route "leave the builder" actions
  // (back to dashboard, switching flows) through here so unsaved changes get
  // a Save/Discard dialog instead of being silently dropped.
  const requestNavigation = useCallback((navigate: () => void) => {
    if (hasUnsavedChanges) {
      pendingNavigationRef.current = navigate;
      setDialogType('unsaved');
      setDialogOpen(true);
    } else {
      navigate();
    }
  }, [hasUnsavedChanges]);

  React.useImperativeHandle(ref, () => ({ requestNavigation }), [requestNavigation]);

  // Handle delete flow
  const handleDelete = useCallback(() => {
    if (initialFlow) {
      log.info(`handleDelete: Deleting flow "${initialFlow.name}" (ID: ${initialFlow.id})`);
      onDelete(initialFlow.id);
    } else {
      log.warn('handleDelete: Attempted to delete flow but no initialFlow is available');
    }
  }, [initialFlow, onDelete]);
  
  // AI-Improve result (issue #99): the model returned a revised flow. Apply it to the
  // canvas as an UNSAVED, undoable change — replacing nodes/edges triggers the history
  // snapshot (so Undo reverts the AI change) and the unsaved-changes guard; name/description
  // are flagged dirty explicitly since the history effect only watches nodes/edges. Nothing
  // is persisted until the user hits Save.
  const handleImproved = useCallback((info: ImprovedFlowInfo) => {
    log.info('Applying AI-improved flow to the canvas', {
      flowId: info.flow.id,
      attempts: info.attempts,
      errors: info.errorCount,
      warnings: info.warningCount,
    });
    setImproveDialogOpen(false);
    setNodes(info.flow.nodes || []);
    setEdges(filterInvalidEdges(info.flow.edges || []));
    setFlowName(info.flow.name);
    setFlowDescription(info.flow.description || '');
    setFlowNameError(validateFlowName(info.flow.name));
    setHasUnsavedChanges(true);

    const freshInstalls = info.installedServers.filter((s) => !s.alreadyExisted);
    const installNote = freshInstalls.length > 0
      ? t('flows.builder.installNote', { servers: formatList(freshInstalls.map((server) => server.name)) })
      : '';
    if (info.errorCount > 0) {
      setImproveNotice({
        severity: 'warning',
        message: t('flows.builder.revisedIssues', {
          errors: tp('flows.validation.error', info.errorCount),
          warnings: tp('flows.validation.warning', info.warningCount),
          installNote,
        }),
      });
    } else if (info.warningCount > 0) {
      setImproveNotice({
        severity: 'info',
        message: t('flows.builder.revisedWarnings', {
          warnings: tp('flows.validation.warning', info.warningCount),
          installNote,
        }),
      });
    } else {
      setImproveNotice({
        severity: 'success',
        message: t('flows.builder.revisedClean', { installNote }),
      });
    }
  }, [filterInvalidEdges, formatList, t, tp]);

  // Restore an archived version (issue: version history): apply the chosen
  // version's definition to the canvas as an UNSAVED, undoable change — exactly
  // like AI-Improve. The user reviews it and hits Save to persist (which archives
  // the definition being replaced, so restoring is itself reversible); Undo
  // reverts the restore. The node id set is preserved from the archived version,
  // so name/description are flagged dirty explicitly (the history effect only
  // watches nodes/edges).
  const handleRestoreVersion = useCallback((restored: Flow) => {
    log.info('Restoring an archived flow version to the canvas', {
      flowId: restored.id,
      nodes: restored.nodes?.length ?? 0,
      edges: restored.edges?.length ?? 0,
    });
    setVersionHistoryOpen(false);
    setNodes(restored.nodes || []);
    setEdges(filterInvalidEdges(restored.edges || []));
    setFlowName(restored.name);
    setFlowDescription(restored.description || '');
    setFlowNameError(validateFlowName(restored.name));
    setHasUnsavedChanges(true);
    setImproveNotice({
      severity: 'info',
      message: t('flows.builder.restored'),
    });
  }, [filterInvalidEdges, t]);

  // Static auto-repair: deterministically add a missing Start/Finish and connect
  // disconnected nodes, reading the current canvas layout as intent (vertical = sequential,
  // same row = parallel). Runs entirely client-side (no model), applied as an unsaved,
  // undoable change just like AI-Improve. No-op flows report "nothing to repair".
  const handleRepairStatic = useCallback(() => {
    setMoreActionsMenuAnchor(null);
    const currentFlow: Flow = {
      id: initialFlow?.id || '',
      name: flowName,
      description: flowDescription,
      nodes,
      edges,
      folder: initialFlow?.folder,
      favorite: initialFlow?.favorite,
    };
    const { flow: repaired, changes } = autoRepairFlow(currentFlow);
    if (changes.length === 0) {
      setImproveNotice({ severity: 'info', message: t('flows.builder.nothingRepair') });
      return;
    }
    log.info(`Applying static auto-repair to the canvas (${changes.length} change(s))`);
    setNodes(repaired.nodes || []);
    setEdges(filterInvalidEdges(repaired.edges || []));
    setHasUnsavedChanges(true);
    const added = changes.filter((c) => c.code === 'auto-added-start' || c.code === 'auto-added-finish').length;
    const wired = changes.length - added;
    const parts: string[] = [];
    if (changes.some((c) => c.code === 'auto-added-start')) parts.push(t('flows.builder.repairAddedStart'));
    if (changes.some((c) => c.code === 'auto-added-finish')) parts.push(t('flows.builder.repairAddedFinish'));
    if (wired > 0) parts.push(tp('flows.builder.repairConnected', wired));
    setImproveNotice({
      severity: 'success',
      message: t('flows.builder.repaired', { changes: formatList(parts) }),
    });
  }, [initialFlow, flowName, flowDescription, nodes, edges, filterInvalidEdges, formatList, t, tp]);

  // AI-supported repair: pre-seed the AI-Improve dialog with the repair instruction and open
  // it, so model selection / install opt-in / result handling are all reused.
  const handleRepairWithAI = useCallback(() => {
    setMoreActionsMenuAnchor(null);
    setImproveInitialDescription(t('flows.builder.aiRepairPrompt'));
    setImproveDialogOpen(true);
  }, [t]);

  // Handle copy flow
  const handleCopyFlow = useCallback(async (flowToCopy: Flow, newName: string) => {
    log.debug(`handleCopyFlow: Copying flow "${flowToCopy.name}" to "${newName}"`);
    
    // Create a new flow with the same nodes and edges but a new ID and name
    const newFlow: Flow = {
      id: uuidv4(), // Generate a new ID
      name: newName,
      description: flowToCopy.description,
      nodes: flowToCopy.nodes,
      edges: flowToCopy.edges,
      folder: flowToCopy.folder,    // Preserve folder assignment
      favorite: flowToCopy.favorite, // Preserve favorite status
    };
    
    log.info(`handleCopyFlow: Created copy of flow "${flowToCopy.name}" with new name "${newName}" (${flowToCopy.nodes.length} nodes, ${flowToCopy.edges.length} edges)`);
    return (await onSave(newFlow)) !== false;
  }, [onSave]);
  
  // Run and clear the navigation deferred by the unsaved-changes dialog.
  const runPendingNavigation = () => {
    const navigate = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    if (navigate) {
      navigate();
    }
  };

  // Handle dialog close (cancel): a deferred navigation is abandoned.
  const handleDialogClose = () => {
    pendingNavigationRef.current = null;
    setDialogOpen(false);
    setDialogType('none');
    setNewFlowName('');
    setNewFlowNameError(null);
  };

  // Handle dialog confirm
  const handleDialogConfirm = async () => {
    // Validate new flow name
    const error = validateFlowName(newFlowName);
    if (error) {
      setNewFlowNameError(error);
      return;
    }

    if (dialogType === 'duplicate') {
      // Copy the flow with a new name
      if (initialFlow) {
        const saved = await handleCopyFlow(initialFlow, newFlowName);
        if (!saved) return;
      }
    } else if (dialogType === 'rename') {
      // Save the flow with the new name
      const flow: Flow = {
        id: initialFlow?.id || uuidv4(),
        name: newFlowName,
        description: flowDescription,
        nodes,
        edges,
        folder: initialFlow?.folder,
        favorite: initialFlow?.favorite,
      };
      const saved = (await onSave(flow)) !== false;
      if (!saved) {
        setSaveStatus('error');
        return;
      }
      setHasUnsavedChanges(false);
      setSaveStatus('saved');
      // If the rename was reached from "Save Changes" in the unsaved-changes
      // dialog, the save is now done — continue the interrupted navigation.
      runPendingNavigation();
    }

    handleDialogClose();
  };

  // Handle discard changes and continue
  const handleDiscardAndContinue = () => {
    setHasUnsavedChanges(false);
    runPendingNavigation();
    handleDialogClose();
  };

  // Handle save and continue: only navigate when something was actually
  // saved — an invalid name or a rename diversion must not lose the edits.
  const handleSaveAndContinue = async () => {
    const result = await handleSave();
    if (result === 'saved') {
      runPendingNavigation();
      handleDialogClose();
    } else if (result === 'invalid-name') {
      // Nothing saved; keep the user in the builder so they can fix the
      // name (the error is shown on the flow-name field).
      handleDialogClose();
    }
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
      log.debug(`handleUndo: Performing undo operation, moving from history index ${historyIndex} to ${historyIndex - 1}`);
      setIsHistoryAction(true);
      const newIndex = historyIndex - 1;
      const prevState = history[newIndex];
      setNodes(prevState.nodes);
      setEdges(prevState.edges);
      setHistoryIndex(newIndex);
      markDirty();
      log.info(`handleUndo: Restored flow state to previous version (${prevState.nodes.length} nodes, ${prevState.edges.length} edges)`);
    }
  }, [history, historyIndex, canUndo, markDirty]);
  
  const handleRedo = useCallback(() => {
    if (canRedo) {
      log.debug(`handleRedo: Performing redo operation, moving from history index ${historyIndex} to ${historyIndex + 1}`);
      setIsHistoryAction(true);
      const newIndex = historyIndex + 1;
      const nextState = history[newIndex];
      setNodes(nextState.nodes);
      setEdges(nextState.edges);
      setHistoryIndex(newIndex);
      markDirty();
      log.info(`handleRedo: Restored flow state to next version (${nextState.nodes.length} nodes, ${nextState.edges.length} edges)`);
    }
  }, [history, historyIndex, canRedo, markDirty]);

  useEffect(() => {
    const handleBuilderShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (modifier && key === 's') {
        event.preventDefault();
        void handleSave();
        return;
      }
      if (!isTyping && modifier && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (!isTyping && modifier && key === 'y') {
        event.preventDefault();
        handleRedo();
        return;
      }
      if (!isTyping && ((modifier && key === 'k') || (!modifier && (key === 'a' || event.key === '/')))) {
        event.preventDefault();
        document.dispatchEvent(new CustomEvent('openFlowQuickAdd'));
      }
    };

    document.addEventListener('keydown', handleBuilderShortcut);
    return () => document.removeEventListener('keydown', handleBuilderShortcut);
  }, [handleSave, handleUndo, handleRedo]);

  const handleAcceptProcessConversion = useCallback(async (draft: ProcessToSubflowDraft) => {
    if (!initialFlow || !conversionProcessId || !draft.parentFlow || !draft.childFlow) {
      throw new Error('Save the parent flow before converting a Process node.');
    }
    const result = await flowService.convertProcessToSubflow(
      draft.parentFlow,
      draft.childFlow,
      conversionProcessId,
      initialFlow.updatedAt,
    );
    if (!result.success) throw new Error(result.error);

    // Install the returned graph and its history entry together. Suppressing the
    // normal effect avoids a duplicate entry; Undo then restores the exact
    // pre-conversion snapshot and Redo reapplies the conversion.
    const entry: HistoryEntry = { nodes: result.parentFlow.nodes, edges: result.parentFlow.edges };
    const nextHistory = [...history.slice(0, historyIndex + 1), entry];
    setIsHistoryAction(true);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
    setNodes(result.parentFlow.nodes);
    setEdges(result.parentFlow.edges);
    setHasUnsavedChanges(false);
    setSaveStatus('saved');
    setConversionProcessId(null);
    onConversionCommitted?.(result.parentFlow, result.childFlow);
  }, [initialFlow, conversionProcessId, history, historyIndex, onConversionCommitted]);

  // Memoized handlers for better performance
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Track drag state so the history effect snapshots once per gesture.
    for (const change of changes) {
      if (change.type === 'position') {
        isDraggingRef.current = change.dragging === true;
      }
    }
    setNodes((nds) => applyNodeChanges(changes, nds) as FlowNode[]);
  }, []);

  // Persist a Tier 2b routing condition edited in the EdgePropertiesModal.
  // When a condition is provided it is spread into the edge's data; when
  // cleared, the `condition` key is DELETED (not set to undefined) so a plain
  // edge stays byte-identical to the compiler's control-edge output. Runs
  // through setEdges, so it lands in undo history and flags unsaved changes
  // just like any other edit.
  const handleSaveEdgeCondition = useCallback((edgeId: string, condition?: EdgeCondition) => {
    setEdges((eds) => eds.map((edge) => {
      if (edge.id !== edgeId) return edge;
      const data = { ...(edge.data ?? {}) } as Record<string, unknown>;
      if (condition) {
        data.condition = condition;
      } else {
        delete data.condition;
      }
      return { ...edge, data };
    }));
    log.info(`handleSaveEdgeCondition: ${condition ? 'set' : 'cleared'} condition on edge ${edgeId}`);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    log.debug(`onEdgesChange: Processing ${changes.length} edge changes`);
    
    // Log specific change types
    changes.forEach(change => {
      if (change.type === 'remove') {
        log.info(`onEdgesChange: Edge ${change.id} removed`);
      } else if (change.type === 'select') {
        log.debug(`onEdgesChange: Edge ${change.id} selection changed to ${change.selected}`);
      }
    });
    
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance<FlowNode, Edge> | null>(null);

  const showBuilderNotice = useCallback((message: string) => {
    setBuilderNotice(message);
    setTimeout(() => setBuilderNotice(current => current === message ? null : current), 5000);
  }, []);

  const handleCreateNode = useCallback((
    nodeType: NodeType,
    position: { x: number; y: number },
    preparedNode?: FlowNode,
  ): FlowNode | null => {
    if (nodeType === 'trigger' && triggerCreationReservedRef.current) {
      showBuilderNotice(t('flows.builder.triggerExists'));
      return null;
    }
    if (nodeType === 'trigger') triggerCreationReservedRef.current = true;

    const newNode = preparedNode ?? flowService.createNode(nodeType, position);
    setNodes(current => [
      ...current.map(node => ({ ...node, selected: false })),
      { ...newNode, selected: true },
    ]);
    return newNode;
  }, [showBuilderNotice, t]);

  const handleQuickAddNode = useCallback((nodeType: NodeType): FlowNode | null => {
    const selected = nodes.find(node => node.selected)
      ?? (nodes.length === 1 && nodes[0].data.type === 'start' ? nodes[0] : undefined);
    const wrapperRect = reactFlowWrapper.current?.getBoundingClientRect();
    const viewportCenter = wrapperRect && reactFlowInstance
      ? reactFlowInstance.screenToFlowPosition({
          x: wrapperRect.left + wrapperRect.width / 2,
          y: wrapperRect.top + wrapperRect.height / 2,
        })
      : { x: 250, y: 180 };

    let position = selected && !['mcp', 'resource', 'trigger'].includes(nodeType)
      ? { x: selected.position.x, y: selected.position.y + 180 }
      : viewportCenter;

    // Repeated one-click additions fan out instead of stacking on the same
    // coordinates. The loop is intentionally bounded for very large graphs.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const collides = nodes.some(node =>
        Math.abs(node.position.x - position.x) < 90 &&
        Math.abs(node.position.y - position.y) < 70
      );
      if (!collides) break;
      position = { x: position.x + 36, y: position.y + 36 };
    }

    // When a control-flow step is selected, one-click Add means "append after
    // this step". Attachment nodes remain unconnected so their semantic MCP /
    // resource handle can be chosen deliberately.
    const controlSources: Partial<Record<NodeType, string>> = {
      start: 'start-bottom',
      process: 'process-bottom',
      subflow: 'subflow-bottom',
      signal: 'signal-bottom',
    };
    const controlTargets: NodeType[] = ['process', 'finish', 'subflow', 'signal'];
    const shouldAppend = !!selected && controlTargets.includes(nodeType);
    const preparedNode = flowService.createNode(nodeType, position);

    if (selected && shouldAppend) {
      const sourceHandle = controlSources[selected.type as NodeType];
      if (!sourceHandle) {
        showBuilderNotice(
          t('flows.builder.selectedCannotLead', { node: selected.data.label || t('flows.builder.selectedNode') }),
        );
        return null;
      }
      const connection = {
        source: selected.id,
        sourceHandle,
        target: preparedNode.id,
        targetHandle: defaultTargetHandleFor(nodeType, sourceHandle),
      };
      const graphWithCandidate = [...nodes, preparedNode];
      if (!validateConnection(connection, graphWithCandidate, edges)) {
        showBuilderNotice(t('flows.builder.cannotAppend'));
        return null;
      }
      const newNode = handleCreateNode(nodeType, position, preparedNode);
      if (!newNode) return null;
      const edge = createEdgeFromConnection(connection, graphWithCandidate);
      setEdges(current => [...current, edge]);
      return newNode;
    }

    return handleCreateNode(nodeType, position, preparedNode);
  }, [nodes, edges, reactFlowInstance, handleCreateNode, showBuilderNotice, t]);

  const handleAddGuidedTask = useCallback((prompt: string) => {
    if (hasUnsafeGuidedGraph) {
      showBuilderNotice(t('flows.builder.customWiring'));
      return;
    }

    const start = nodes.find(node => node.data.type === 'start');
    const existingFinish = nodes.find(node => node.data.type === 'finish');
    const orderedControls = guidedGraph.orderedNodeIds
      .map(nodeId => nodes.find(node => node.id === nodeId))
      .filter((node): node is FlowNode => !!node);
    const source = [...orderedControls]
      .reverse()
      .find(node => ['start', 'process', 'subflow', 'signal'].includes(node.data.type))
      ?? start;
    if (!source) {
      showBuilderNotice(t('flows.builder.missingStart'));
      return;
    }

    const sourceHandles: Partial<Record<NodeType, string>> = {
      start: 'start-bottom',
      process: 'process-bottom',
      subflow: 'subflow-bottom',
      signal: 'signal-bottom',
    };
    const sourceHandle = sourceHandles[source.data.type as NodeType];
    if (!sourceHandle) {
      showBuilderNotice(t('flows.builder.addExpert'));
      return;
    }

    const isFirstProcessStep = !nodes.some(node => node.data.type === 'process');
    const processNode = flowService.createNode('process', {
      x: source.position.x,
      y: source.position.y + 180,
    });
    processNode.data = {
      ...processNode.data,
      label: t('flows.builder.aiTask'),
      properties: {
        ...(processNode.data.properties ?? {}),
        promptTemplate: prompt,
        inputMode: 'full-history',
        outputMode: 'latest-message',
        ...(guidedAiAssistance === 'assisted' && guidedSelectedModelId
          ? { boundModel: guidedSelectedModelId }
          : {}),
      },
    };

    const finishNode = existingFinish ?? flowService.createNode('finish', {
      x: source.position.x,
      y: source.position.y + 360,
    });
    const nextNodes = [
      ...nodes
        .filter(node => node.id !== finishNode.id)
        .map(node => ({ ...node, selected: false })),
      { ...processNode, selected: true },
      {
        ...finishNode,
        position: { x: source.position.x, y: source.position.y + 360 },
        selected: false,
      },
    ];

    // A Guided sequence is linear. Inserting a step replaces the last direct
    // hop to Finish, then owns the two new "then" connections.
    const remainingEdges = edges.filter(edge =>
      !(existingFinish && edge.source === source.id && edge.target === existingFinish.id)
    );
    const intoTask = {
      source: source.id,
      sourceHandle,
      target: processNode.id,
      targetHandle: defaultTargetHandleFor('process', sourceHandle),
    };
    const intoFinish = {
      source: processNode.id,
      sourceHandle: 'process-bottom',
      target: finishNode.id,
      targetHandle: defaultTargetHandleFor('finish', 'process-bottom'),
    };
    const nextEdges = [
      ...remainingEdges,
      createEdgeFromConnection(intoTask, nextNodes),
      createEdgeFromConnection(intoFinish, nextNodes),
    ];
    const reconciledNodes = source.data.type === 'process'
      ? nextNodes.map((candidate) => candidate.id === source.id ? {
          ...candidate,
          data: {
            ...candidate.data,
            properties: {
              ...(candidate.data.properties ?? {}),
              promptTemplate: reconcileHandoffPromptForTopologyChange({
                prompt: String(source.data.properties?.promptTemplate ?? ''),
                nodeId: source.id,
                previous: { nodes, edges },
                next: { nodes: nextNodes, edges: nextEdges },
              }),
            },
          },
        } : candidate)
      : nextNodes;
    setNodes(reconciledNodes);
    setEdges(nextEdges);

    if (isFirstProcessStep && !flowDescription.trim()) {
      setFlowDescription(prompt);
    }
    if (guidedAiAssistance === 'assisted' && guidedSelectedModelId) {
      if (isFirstProcessStep && isPlaceholderGuidedName(flowName, t('flows.page.untitled'))) {
        const requestedName = flowName;
        const draftForName: Flow = {
          ...(initialFlow ?? {
            id: fallbackFlowId.current,
            name: requestedName,
            nodes: [],
            edges: [],
          }),
          id: initialFlow?.id ?? fallbackFlowId.current,
          name: requestedName,
          // Naming follows the goal the user just submitted, even when this
          // draft inherited an older card description.
          description: prompt,
          nodes: reconciledNodes,
          edges: nextEdges,
        };
        void flowService.generateNameForFlow({
          flow: draftForName,
          modelId: guidedSelectedModelId,
          existingNames: allFlows
            .filter((flow) => flow.id !== draftForName.id)
            .map((flow) => flow.name),
        }).then(({ name }) => {
          if (
            flowNameRef.current !== requestedName
            || !isPlaceholderGuidedName(flowNameRef.current, t('flows.page.untitled'))
          ) return;
          const error = validateFlowName(name);
          if (error) return;
          flowNameRef.current = name;
          setFlowName(name);
          setFlowNameError(null);
          markDirty();
        }).catch((error) => {
          log.warn('Could not auto-generate a Guided flow name', error);
        });
      }
      setAssistanceNodeId(processNode.id);
      setAssistanceFocus('apps');
      setAssistanceOpen(true);
    } else if (!guidedSelectedModelId) {
      showBuilderNotice(t('flows.builder.connectModel'));
    }
  }, [
    nodes,
    edges,
    guidedAiAssistance,
    guidedSelectedModelId,
    guidedGraph.orderedNodeIds,
    hasUnsafeGuidedGraph,
    showBuilderNotice,
    flowDescription,
    flowName,
    initialFlow,
    allFlows,
    markDirty,
    t,
  ]);

  const selectedNode = nodes.find(node => node.selected) ?? null;

  // The technical-details dialog follows the Inspector selection: it retargets
  // when another node is selected and closes when the selection is cleared or
  // the node is deleted, so stale details can never stay on screen (#412).
  const technicalDetailsNode = useMemo(
    () => (technicalDetailsNodeId
      ? nodes.find(node => node.id === technicalDetailsNodeId) ?? null
      : null),
    [nodes, technicalDetailsNodeId],
  );
  useEffect(() => {
    if (!technicalDetailsNodeId) return;
    if (!selectedNode) {
      setTechnicalDetailsNodeId(null);
      return;
    }
    if (selectedNode.id !== technicalDetailsNodeId) {
      setTechnicalDetailsNodeId(selectedNode.id);
    }
  }, [selectedNode, technicalDetailsNodeId]);

  const addableNodeTypes = useMemo(() => getNodeTypes(t), [t]);
  const mcpConnectionsByProcess = useMemo(() => {
    const result = new Map<string, Array<{ nodeId: string; serverName: string }>>();
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    edges.forEach((edge) => {
      if ((edge.data as { edgeType?: string } | undefined)?.edgeType !== 'mcp') return;
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      const process = source?.data.type === 'process' ? source : target?.data.type === 'process' ? target : null;
      const mcp = source?.data.type === 'mcp' ? source : target?.data.type === 'mcp' ? target : null;
      const serverName = mcp?.data.properties?.boundServer;
      if (!process || !mcp || typeof serverName !== 'string' || !serverName) return;
      result.set(process.id, [
        ...(result.get(process.id) ?? []),
        { nodeId: mcp.id, serverName },
      ]);
    });
    return result;
  }, [edges, nodes]);
  const connectedInspectorMcpServers = selectedNode?.data.type === 'process'
    ? mcpConnectionsByProcess.get(selectedNode.id) ?? []
    : [];
  const agentConnectionsByProcess = useMemo(() => {
    const result = new Map<string, GuidedAgentConnection[]>();
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const flowNameById = new Map(allFlows.map(flow => [flow.id, flow.name]));
    getGuidedSubagentLinks(nodes, edges).forEach((link) => {
      const subflowNode = nodeById.get(link.subflowNodeId);
      const flowId = subflowNode?.data.properties?.subflowId;
      if (typeof flowId !== 'string' || !flowId) return;
      result.set(link.processNodeId, [
        ...(result.get(link.processNodeId) ?? []),
        {
          nodeId: link.subflowNodeId,
          flowId,
          flowName: flowNameById.get(flowId) ?? subflowNode?.data.label ?? flowId,
        },
      ]);
    });
    return result;
  }, [allFlows, edges, nodes]);
  const hasGuidedTask = nodes.some(node => ['process', 'subflow'].includes(node.data.type));
  const guidedModelsReady = nodes
    .filter(node => node.data.type === 'process')
    .every(node => typeof node.data.properties?.boundModel === 'string' && !!node.data.properties.boundModel);
  const hasFriendlyFlowName = !!flowName.trim()
    && !/^(?:NewFlow\d*|Untitled (?:assistant|agent)(?: \d+)?)$/i.test(flowName.trim())
    && !flowNameError;
  const canTryGuided = hasGuidedTask
    && guidedModelsReady
    && hasFriendlyFlowName
    && !hasUnsafeGuidedGraph
    && saveStatus !== 'saving';

  const handleSelectGuidedNode = useCallback((nodeId: string) => {
    setNodes(current => current.map(node => ({ ...node, selected: node.id === nodeId })));
  }, []);

  const currentFlow = useMemo<Flow>(() => ({
    ...(initialFlow ?? { id: fallbackFlowId.current, name: flowName, nodes: [], edges: [] }),
    id: initialFlow?.id ?? fallbackFlowId.current,
    name: flowName,
    ...(flowDescription.trim() ? { description: flowDescription } : {}),
    nodes,
    edges,
  }), [
    edges,
    flowDescription,
    flowName,
    initialFlow,
    nodes,
  ]);

  const highlightAskFlowNode = useCallback((nodeId: string) => {
    const node = nodes.find(candidate => candidate.id === nodeId);
    if (!node) return false;
    setNodes(current => current.map(candidate => ({
      ...candidate,
      selected: candidate.id === nodeId,
    })));
    reactFlowInstance?.setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 450 });
    window.requestAnimationFrame(() => {
      const element = [...document.querySelectorAll('.react-flow__node')]
        .find(candidate => candidate.getAttribute('data-id') === nodeId) ?? null;
      highlightAskFlujoElement(element);
    });
    return true;
  }, [nodes, reactFlowInstance]);

  const handleAskFlujoAction = useCallback((action: AskFlujoUiAction) => {
    if (action.target.kind === 'flow-node' && action.target.id && action.type === 'highlight') {
      const highlighted = highlightAskFlowNode(action.target.id);
      return {
        success: highlighted,
        message: highlighted ? 'Highlighted the matching flow step.' : 'That flow step is no longer on screen.',
      };
    }

    if (action.target.kind === 'flow-field' && action.target.field) {
      const field = action.target.field;
      if (field !== 'name' && field !== 'description') {
        return { success: false, message: `The flow field "${field}" is not editable here.` };
      }
      if (action.type === 'highlight') {
        const target = document.querySelector(`[data-ask-flujo-flow-field="${field}"]`);
        const highlighted = highlightAskFlujoElement(target);
        return { success: highlighted, message: highlighted ? `Highlighted flow ${field}.` : `Could not find flow ${field}.` };
      }
      if (typeof action.value !== 'string') {
        return { success: false, message: `Flow ${field} must be text.` };
      }
      if (field === 'name') {
        flowNameRef.current = action.value;
        setFlowName(action.value);
        setFlowNameError(validateFlowName(action.value));
      } else {
        setFlowDescription(action.value);
      }
      markDirty();
      return { success: true, message: `Updated flow ${field} in the unsaved editor.` };
    }

    if (action.target.kind === 'flow-node-field' && action.target.id) {
      const nodeId = action.target.id;
      if (action.type === 'highlight') {
        const highlighted = highlightAskFlowNode(nodeId);
        return { success: highlighted, message: highlighted ? 'Highlighted the matching flow step.' : 'That flow step is no longer on screen.' };
      }
      const path = action.target.path;
      if (!path || (!path.startsWith('data.') && !path.startsWith('/data/'))) {
        return { success: false, message: 'Only advertised node data fields are editable.' };
      }
      const existingNode = nodes.find(node => node.id === nodeId);
      if (!existingNode) return { success: false, message: 'That flow step is no longer on screen.' };
      let updatedNode: FlowNode;
      try {
        updatedNode = setAskFlujoValueAtPath(existingNode, path, action.value);
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'The node field could not be changed.',
        };
      }
      setNodes(current => current.map(node => node.id === nodeId ? updatedNode : node));
      markDirty();
      window.requestAnimationFrame(() => highlightAskFlowNode(nodeId));
      return { success: true, message: 'Updated the step in the unsaved flow. Review it, then Save.' };
    }

    return { success: false, message: 'That flow UI target is not supported.' };
  }, [highlightAskFlowNode, markDirty, nodes, validateFlowName]);

  useAskFlujoPage({
    scopeId: `flow:${currentFlow.id}`,
    pageType: 'flow',
    route: '/flows',
    title: currentFlow.name,
    identifiers: { flowId: currentFlow.id },
    data: {
      flow: currentFlow,
      selectedNodeId: selectedNode?.id ?? null,
      authoringMode,
      isDraft,
      hasUnsavedChanges,
    },
    capabilities: {
      highlightTargets: currentFlow.nodes.map(node => ({
        kind: 'flow-node',
        id: node.id,
        label: node.data.label,
        nodeType: node.data.type,
      })),
      editableTargets: [
        { kind: 'flow-field', field: 'name' },
        { kind: 'flow-field', field: 'description' },
        ...currentFlow.nodes.flatMap(node => (
          [
            'data.label',
            ...Object.keys(node.data.properties ?? {}).map(key => `data.properties.${key}`),
          ].map(path => ({
            kind: 'flow-node-field',
            id: node.id,
            path,
          }))
        )),
      ],
      notes: [
        'This is the live Flow Builder state, including unsaved edits and full node prompts/configuration.',
        'Screen changes remain unsaved until the user presses the normal Save button.',
      ],
    },
  }, handleAskFlujoAction, 100);

  const assistanceModelId = useMemo(() => {
    if (assistanceNodeId) {
      const node = nodes.find(candidate => candidate.id === assistanceNodeId);
      const bound = node?.data.properties?.boundModel;
      if (typeof bound === 'string' && bound) return bound;
    }
    if (guidedSelectedModelId) return guidedSelectedModelId;
    const bound = nodes.find(candidate =>
      candidate.data.type === 'process'
      && typeof candidate.data.properties?.boundModel === 'string'
      && !!candidate.data.properties.boundModel
    )?.data.properties?.boundModel;
    return typeof bound === 'string' ? bound : null;
  }, [assistanceNodeId, guidedSelectedModelId, nodes]);

  const applyAssistedFlow = useCallback((flow: Flow) => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
    if (flow.description !== undefined) setFlowDescription(flow.description);
    markDirty();
  }, [markDirty]);

  const handleClearNodeSelection = useCallback(() => {
    const changes = nodes
      .filter(node => node.selected)
      .map(node => ({ type: 'select' as const, id: node.id, selected: false }));
    if (changes.length > 0) onNodesChange(changes);
  }, [nodes, onNodesChange]);

  // Tidy up (issue #373 fix for #100's Auto-Align): a bounded, position-
  // preserving pass that keeps every node roughly where the user put it and
  // only resolves actual collisions (dragging MCP/resource satellites along
  // with their parent). This is now the DEFAULT toolbar action so a clean,
  // hand-arranged flow is no longer scrambled by a click. Uses the functional
  // setNodes so it stacks on the latest state; because positions change
  // outside a drag gesture, the history effect records it as a single
  // undoable step and flags the flow unsaved. Nothing is persisted until the
  // user hits Save. The user's viewport is already meaningful for a
  // position-preserving pass, so this intentionally does NOT fitView (unlike
  // the destructive re-layout below).
  const handleTidyLayout = useCallback(() => {
    log.debug('handleTidyLayout: resolving node overlaps in place');
    setNodes(prev => computeTidyLayout(prev, edges));
  }, [edges]);

  // Re-layout top-to-bottom (issue #100, fixed for #373): discard existing
  // coordinates and repack the graph into a clean layered layout. Explicit,
  // opt-in action (kept out of the primary toolbar; reachable from the
  // overflow "more actions" menu) since it no longer doubles as the default
  // de-overlap action. fitView re-frames after the new positions are applied.
  const handleRelayout = useCallback(() => {
    log.debug('handleRelayout: re-arranging flow nodes top-to-bottom');
    setNodes(prev => computeAutoLayout(prev, edges));
    requestAnimationFrame(() => reactFlowInstance?.fitView({ padding: 0.2 }));
  }, [edges, reactFlowInstance]);

  const updateNodeData = useCallback((nodeId: string, data: FlowNode['data']) => {
    log.debug(`handleNodeUpdate: Updating node ${nodeId} properties`);
    setNodes((nds) => {
      const nextNodes = nds.map((node) => {
        if (node.id === nodeId) {
          log.info(`handleNodeUpdate: Node ${nodeId} properties updated`);
          return { ...node, data };
        }
        return node;
      });
      // If this edit renamed a handoff-target node, rewrite the handoff pills
      // referencing it in every predecessor's promptTemplate — as part of THIS
      // same state update, so the rewrite and the rename are one undo step
      // (issue #178). No-op when nothing was renamed.
      return migrateHandoffPills(nds, nextNodes, edges);
    });
  }, [edges]);

  const handleNodeUpdate = useCallback((nodeId: string, data: FlowNode['data']) => {
    updateNodeData(nodeId, data);
    // Close any open modals
    setProcessModalOpen(false);
    setProcessNodeModalMode('edit');
    setMcpModalOpen(false);
    setStartModalOpen(false);
    setFinishModalOpen(false);
    setSubflowModalOpen(false);
    setResourceModalOpen(false);
    setSignalModalOpen(false);
    setStaticModalOpen(false);
    setTriggerModalOpen(false);
    setNodeToEdit(null);
    log.debug(`handleNodeUpdate: Closed property modals`);
  }, [updateNodeData]);

  const handleStaticNodeUpdate = useCallback((nodeId: string, data: FlowNode['data']) => {
    const renamedNodes = nodes.map((candidate) => candidate.id === nodeId
      ? { ...candidate, data }
      : candidate);
    const updatedNodes = migrateHandoffPills(nodes, renamedNodes, edges);
    const reconciled = reconcileStaticToolConnections({
      staticNodeId: nodeId,
      entries: Array.isArray(data.properties?.entries) ? data.properties.entries : [],
      nodes: updatedNodes,
      edges,
      createMcpNode: (serverName, position) => {
        const created = flowService.createNode('mcp', position);
        created.data.label = serverName;
        return created;
      },
    });
    setNodes(reconciled.nodes);
    setEdges(reconciled.edges);
    setStaticModalOpen(false);
    setNodeToEdit(null);
  }, [edges, nodes]);
  
  // Connect-a-server shortcut from the Process node properties modal: create
  // an MCP node bound to the server, place it next to the process node, and
  // wire it via the MCP handles — without the user leaving the modal.
  const handleConnectMcpServer = useCallback(async (processNodeId: string, serverName: string) => {
    const processNode = nodes.find(n => n.id === processNodeId);
    if (!processNode) {
      log.warn(`handleConnectMcpServer: process node ${processNodeId} not found`);
      return;
    }

    // Enable every tool the server currently provides (the same default the
    // MCP node properties modal applies when it first loads a bound server).
    let enabledTools: string[] = [];
    try {
      const result = await mcpService.listServerTools(serverName);
      if (!result.error && Array.isArray(result.tools)) {
        enabledTools = result.tools.map((t: { name: string }) => t.name);
      }
    } catch (error) {
      log.warn(`handleConnectMcpServer: could not load tools for ${serverName}`, error);
    }

    // Stack additional servers below the previous one on the right side.
    const connectedMcpEdgeCount = edges.filter(e =>
      (e.data as { edgeType?: string } | undefined)?.edgeType === 'mcp' &&
      (e.source === processNodeId || e.target === processNodeId)
    ).length;
    const mcpNode = flowService.createNode('mcp', {
      x: processNode.position.x + 350,
      y: processNode.position.y + connectedMcpEdgeCount * 120,
    });
    mcpNode.data.label = serverName;
    mcpNode.data.properties = { ...(mcpNode.data.properties ?? {}), boundServer: serverName, enabledTools };

    const edge = createEdgeFromConnection({
      source: processNodeId,
      sourceHandle: 'process-right-mcp',
      target: mcpNode.id,
      targetHandle: 'mcp-left',
    }, [...nodes, mcpNode]);

    setNodes(nds => [...nds, mcpNode]);
    setEdges(eds => [...eds, edge]);
    log.info(`Connected MCP server "${serverName}" to process node ${processNodeId}`);
  }, [nodes, edges]);

  const handleSelectMcpNodeServer = useCallback(async (mcpNode: FlowNode, serverName: string) => {
    if (mcpNode.data.type !== 'mcp') return;

    let enabledTools: string[] = [];
    try {
      const result = await mcpService.listServerTools(serverName);
      if (!result.error && Array.isArray(result.tools)) {
        enabledTools = result.tools.map((tool: { name: string }) => tool.name);
      }
    } catch (error) {
      log.warn(`handleSelectMcpNodeServer: could not load tools for ${serverName}`, error);
    }

    const previousProperties = mcpNode.data.properties ?? {};
    const { enabledResources: _enabledResources, ...retainedProperties } = previousProperties;
    updateNodeData(mcpNode.id, {
      ...mcpNode.data,
      label: resolveAutoNodeLabel({
        currentLabel: mcpNode.data.label,
        nameIsCustom: previousProperties.nameIsCustom === true,
        defaultLabel: 'MCP Node',
        previousAutoLabel: typeof previousProperties.boundServer === 'string'
          ? previousProperties.boundServer
          : undefined,
        nextAutoLabel: serverName,
      }),
      properties: {
        ...retainedProperties,
        boundServer: serverName,
        enabledTools,
      },
    });
  }, [updateNodeData]);

  const handleRemoveMcpServer = useCallback((processNodeId: string, mcpNodeId: string) => {
    const isTargetConnection = (edge: Edge) =>
      (edge.data as { edgeType?: string } | undefined)?.edgeType === 'mcp'
      && (
        (edge.source === processNodeId && edge.target === mcpNodeId)
        || (edge.source === mcpNodeId && edge.target === processNodeId)
      );
    if (!edges.some(isTargetConnection)) return;

    const remainingEdges = edges.filter(edge => !isTargetConnection(edge));
    const mcpNodeIsStillWired = remainingEdges.some(
      edge => edge.source === mcpNodeId || edge.target === mcpNodeId,
    );
    setEdges(remainingEdges);
    if (!mcpNodeIsStillWired) {
      setNodes(current => current.filter(node => node.id !== mcpNodeId));
    }
    log.info(`Removed MCP node ${mcpNodeId} from process node ${processNodeId}`);
  }, [edges]);

  const handleConnectGuidedAgent = useCallback((processNodeId: string, childFlowId: string) => {
    const processNode = nodes.find(node => node.id === processNodeId && node.data.type === 'process');
    const childFlow = allFlows.find(flow => flow.id === childFlowId);
    const currentFlowId = initialFlow?.id ?? fallbackFlowId.current;
    if (!processNode || !childFlow || childFlow.id === currentFlowId) return;

    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const links = getGuidedSubagentLinks(nodes, edges);
    const duplicate = links.some(link =>
      link.processNodeId === processNodeId
      && nodeById.get(link.subflowNodeId)?.data.properties?.subflowId === childFlowId
    );
    if (duplicate) return;

    const connectionCount = links.filter(link => link.processNodeId === processNodeId).length;
    const preparedNode = flowService.createNode('subflow', {
      // Apps already occupy the right attachment lane in Expert view. Keep
      // callable agents on the left so switching editors never reveals a stack
      // of overlapping hidden nodes.
      x: processNode.position.x - 350,
      y: processNode.position.y + connectionCount * 150,
    });
    const subagentNode = configureGuidedSubagentNode(preparedNode, childFlow);
    const connection = {
      source: processNodeId,
      sourceHandle: 'process-bottom',
      target: subagentNode.id,
      targetHandle: defaultTargetHandleFor('subflow', 'process-bottom'),
    };
    if (!validateConnection(connection, [...nodes, subagentNode], edges)) return;
    const edge = configureGuidedSubagentEdge(
      createEdgeFromConnection(connection, [...nodes, subagentNode]),
    );
    const nextNodes = [...nodes, subagentNode];
    const nextEdges = [...edges, edge];
    const reconciledPrompt = reconcileHandoffPromptForTopologyChange({
      prompt: String(processNode.data.properties?.promptTemplate ?? ''),
      nodeId: processNodeId,
      previous: { nodes, edges },
      next: { nodes: nextNodes, edges: nextEdges },
    });
    setNodes(nextNodes.map((candidate) => candidate.id === processNodeId ? {
      ...candidate,
      data: {
        ...candidate.data,
        properties: {
          ...(candidate.data.properties ?? {}),
          promptTemplate: reconciledPrompt,
        },
      },
    } : candidate));
    setEdges(nextEdges);
    log.info(`Connected agent "${childFlow.name}" to process node ${processNodeId}`);
  }, [allFlows, edges, initialFlow?.id, nodes]);

  const handleRemoveGuidedAgent = useCallback((processNodeId: string, subflowNodeId: string) => {
    const isTargetConnection = (edge: Edge) => {
      const bidirectional = (edge.data as { bidirectional?: boolean } | undefined)?.bidirectional === true;
      return bidirectional && (
        (edge.source === processNodeId && edge.target === subflowNodeId)
        || (edge.source === subflowNodeId && edge.target === processNodeId)
      );
    };
    if (!edges.some(isTargetConnection)) return;

    const remainingEdges = edges.filter(edge => !isTargetConnection(edge));
    const subflowIsStillWired = remainingEdges.some(
      edge => edge.source === subflowNodeId || edge.target === subflowNodeId,
    );
    const nextNodes = subflowIsStillWired
      ? nodes
      : nodes.filter(node => node.id !== subflowNodeId);
    const processNode = nodes.find(node => node.id === processNodeId && node.data.type === 'process');
    const reconciledPrompt = processNode
      ? reconcileHandoffPromptForTopologyChange({
          prompt: String(processNode.data.properties?.promptTemplate ?? ''),
          nodeId: processNodeId,
          previous: { nodes, edges },
          next: { nodes: nextNodes, edges: remainingEdges },
        })
      : null;
    setEdges(remainingEdges);
    setNodes(nextNodes.map((candidate) => candidate.id === processNodeId && reconciledPrompt !== null ? {
      ...candidate,
      data: {
        ...candidate.data,
        properties: {
          ...(candidate.data.properties ?? {}),
          promptTemplate: reconciledPrompt,
        },
      },
    } : candidate));
    log.info(`Removed agent node ${subflowNodeId} from process node ${processNodeId}`);
  }, [edges, nodes]);

  const loadInspectorMcpServers = useCallback(async (): Promise<InspectorMcpServerOption[]> => {
    const result = await mcpService.loadServerConfigs();
    if (!Array.isArray(result)) {
      throw new Error(result?.error || t('flows.inspector.mcpLoadError'));
    }

    return Promise.all((result as MCPServerConfig[]).map(async server => {
      const statusResult = await mcpService.getServerStatus(server.name);
      const status = typeof statusResult === 'string' ? statusResult : statusResult.status;
      return { ...server, status };
    }));
  }, [t]);

  // Open the appropriate properties modal based on node type
  const openNodeProperties = useCallback((node: FlowNode, mode: 'create' | 'edit' = 'edit') => {
    log.debug('Opening properties for node:', node);
    setNodeToEdit(node);
    setQuickMcpServerPicker(false);
    if (node.data.type === 'process') {
      setProcessNodeModalMode(mode);
    }

    if (node.data.type === 'mcp') {
      setMcpModalOpen(true);
    } else if (node.data.type === 'start') {
      setStartModalOpen(true);
    } else if (node.data.type === 'finish') {
      setFinishModalOpen(true);
    } else if (node.data.type === 'subflow') {
      setSubflowModalOpen(true);
    } else if (node.data.type === 'resource') {
      setResourceModalOpen(true);
    } else if (node.data.type === 'signal') {
      setSignalModalOpen(true);
    } else if (node.data.type === 'static') {
      setStaticModalOpen(true);
    } else if (node.data.type === 'trigger') {
      setTriggerModalOpen(true);
    } else {
      setProcessModalOpen(true);
    }
  }, []);

  const configureQuickCreatedAttachment = useCallback((node: FlowNode) => {
    setNodeToEdit(node);
    if (node.data.type === 'mcp') {
      setQuickMcpServerPicker(true);
      setMcpModalOpen(true);
    } else if (node.data.type === 'resource') {
      setResourceModalOpen(true);
    }
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      log.debug('onDrop: Node dropped on canvas');
      event.preventDefault();
      
      // Get the node type from the data transfer
      const type = event.dataTransfer.getData('application/reactflow');
      log.debug(`onDrop: Node type from data transfer: ${type}`);
      
      // Check if we have all the required data to create a node
      if (!type || !reactFlowInstance) {
        log.debug(`onDrop: Missing required data - type: ${!!type}, reactFlowInstance: ${!!reactFlowInstance}`);
        return;
      }
      
      // Calculate the position where the node should be placed
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      log.debug(`onDrop: Calculated position: (${position.x}, ${position.y})`);
      
      // Create the new node using flowService
      const newNode = handleCreateNode(type as NodeType, position);
      if (!newNode) return;
      log.info(`onDrop: Created new ${type} node with ID: ${newNode.id}`);
      log.debug(`onDrop: Selected new node ${newNode.id} in the inspector`);
    },
    [reactFlowInstance, handleCreateNode]
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // We don't need to log every dragover event as it would be too verbose
  }, []);

  const onInit = useCallback((instance: unknown) => {
    log.debug('onInit: ReactFlow instance initialized');
    setReactFlowInstance(instance as ReactFlowInstance<FlowNode, Edge>);
  }, []);

  return (
    <FlowBuilderContainer data-tour="flow-builder" data-tutorial-save-status={saveStatus}>
      {authoringMode === 'advanced' && !isMobileBuilder && (
        <Box sx={{ flex: '0 0 auto', height: '100%', minHeight: 0 }}>
          <NodePalette authoringMode={authoringMode} onAddNode={handleQuickAddNode} />
        </Box>
      )}
      <FlowNamesContext.Provider value={flowNames}>
        <ReactFlowProvider>
        <MainContent>
          <ToolbarContainer elevation={1}>
            <Box sx={{ minWidth: 0, flex: '1 1 180px', display: { xs: 'none', md: 'block' } }}>
              <Typography data-ask-flujo-flow-field="name" variant="subtitle2" fontWeight={850} noWrap>{flowName}</Typography>
              <Typography variant="caption" color="text.secondary">
                {authoringMode === 'guided'
                  ? tp('flows.builder.step', nodes.filter(node => ['process', 'subflow', 'signal'].includes(node.data.type)).length)
                  : `${tp('flows.builder.node', nodes.length)} · ${tp('flows.builder.connection', edges.length)}`}
              </Typography>
            </Box>

            <Chip
              size="small"
              variant="outlined"
              color={saveStatus === 'error' ? 'error' : saveStatus === 'saved' ? 'success' : 'default'}
              icon={
                saveStatus === 'saving'
                  ? <CircularProgress size={14} />
                  : saveStatus === 'error'
                    ? <CloudOffRoundedIcon />
                    : saveStatus === 'saved'
                      ? <CheckCircleRoundedIcon />
                      : undefined
              }
              label={
                saveStatus === 'saving'
                  ? t('flows.builder.saving')
                  : saveStatus === 'error'
                    ? t('flows.builder.saveFailed')
                    : saveStatus === 'unsaved'
                      ? (isDraft && !hasUnsavedChanges ? t('flows.builder.draft') : t('flows.builder.unsaved'))
                      : t('flows.builder.saved')
              }
              aria-label={t('flows.builder.saveStatus', {
                status: saveStatus === 'saving'
                  ? t('flows.builder.saving')
                  : saveStatus === 'error'
                    ? t('flows.builder.saveFailed')
                    : hasUnsavedChanges
                      ? t('flows.builder.unsaved')
                      : t('flows.builder.saved'),
              })}
            />

            <FormControlLabel
              sx={{ m: 0, whiteSpace: 'nowrap' }}
              control={
                <Switch
                  size="small"
                  checked={authoringMode === 'advanced'}
                  onChange={(event) => setAuthoringMode(event.target.checked ? 'advanced' : 'guided')}
                  inputProps={{ 'aria-label': t('flows.builder.expertView') }}
                />
              }
              label={authoringMode === 'advanced' ? t('flows.builder.expert') : t('flows.builder.easy')}
            />

            {authoringMode === 'advanced' && (
              <>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={(event) => setAddNodeMenuAnchor(event.currentTarget)}
                  aria-label={t('flows.builder.addNode')}
                  aria-controls={addNodeMenuAnchor ? 'add-node-menu' : undefined}
                  aria-haspopup="menu"
                  aria-expanded={addNodeMenuAnchor ? 'true' : undefined}
                  title={t('flows.builder.addNodeHelp')}
                >
                  {t('flows.builder.addNode')}
                </Button>
                <Menu
                  id="add-node-menu"
                  anchorEl={addNodeMenuAnchor}
                  open={!!addNodeMenuAnchor}
                  onClose={() => setAddNodeMenuAnchor(null)}
                  MenuListProps={{ 'aria-label': t('flows.builder.addNode') }}
                >
                  {addableNodeTypes.map((nodeType) => (
                    <MenuItem
                      key={nodeType.type}
                      onClick={() => {
                        setAddNodeMenuAnchor(null);
                        handleQuickAddNode(nodeType.type);
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2" fontWeight={750}>{nodeType.label}</Typography>
                        <Typography variant="caption" color="text.secondary">{nodeType.description}</Typography>
                      </Box>
                    </MenuItem>
                  ))}
                </Menu>

                <FlowValidationButton nodes={nodes} edges={edges} />

                <Tooltip title={t('flows.builder.autoAlign')}>
                  <span>
                    <IconButton
                      aria-label={t('flows.builder.autoAlign')}
                      onClick={handleTidyLayout}
                      disabled={nodes.length <= 1}
                      color="primary"
                      size="small"
                    >
                      <AutoAwesomeMotionRoundedIcon />
                    </IconButton>
                  </span>
                </Tooltip>

                <Divider orientation="vertical" flexItem />

                <Tooltip title={`${t('flows.builder.undo')} · Ctrl/⌘ Z`}>
                  <span>
                    <IconButton aria-label={t('flows.builder.undo')} onClick={handleUndo} disabled={!canUndo} color="primary" size="small">
                      <UndoIcon />
                    </IconButton>
                  </span>
                </Tooltip>

                <Tooltip title={`${t('flows.builder.redo')} · Ctrl/⌘ Shift Z`}>
                  <span>
                    <IconButton aria-label={t('flows.builder.redo')} onClick={handleRedo} disabled={!canRedo} color="primary" size="small">
                      <RedoIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              </>
            )}

            <Button
              data-tour="flow-save"
              variant={authoringMode === 'guided' ? 'outlined' : 'contained'}
              color="primary"
              onClick={() => void handleSave()}
              startIcon={saveStatus === 'saving' ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
              disabled={!!flowNameError || saveStatus === 'saving'}
              aria-label={t('flows.builder.saveFlow')}
            >
              {t('flows.builder.save')}
            </Button>

            {authoringMode === 'guided' && onTry && (
              <Button
                variant="contained"
                color="primary"
                onClick={() => void handleTry()}
                startIcon={<PlayArrowRoundedIcon />}
                disabled={!canTryGuided}
              >
                {t('flows.builder.try')}
              </Button>
            )}

            {(authoringMode === 'advanced' || (initialFlow && !isDraft)) && (
              <>
                <Tooltip title={t('flows.builder.moreCommands')}>
                  <IconButton
                    id="more-actions-button"
                    data-tour="improve-flow"
                    aria-label={t('flows.builder.moreActions')}
                    aria-controls={moreActionsMenuAnchor ? 'more-actions-menu' : undefined}
                    aria-haspopup="menu"
                    aria-expanded={moreActionsMenuAnchor ? 'true' : undefined}
                    onClick={(event) => setMoreActionsMenuAnchor(event.currentTarget)}
                    color="primary"
                    size="small"
                  >
                    <MoreHorizIcon />
                  </IconButton>
                </Tooltip>
                <Menu
                  id="more-actions-menu"
                  anchorEl={moreActionsMenuAnchor}
                  open={!!moreActionsMenuAnchor}
                  onClose={() => setMoreActionsMenuAnchor(null)}
                  MenuListProps={{ 'aria-labelledby': 'more-actions-button' }}
                >
              {authoringMode === 'advanced' && (
                <MenuItem
                  disabled={nodes.length <= 1}
                  onClick={() => {
                    setMoreActionsMenuAnchor(null);
                    handleTidyLayout();
                  }}
                >
                  {t('flows.builder.autoAlign')}
                </MenuItem>
              )}
              {authoringMode === 'advanced' && (
                <MenuItem
                  disabled={nodes.length <= 1}
                  onClick={() => {
                    setMoreActionsMenuAnchor(null);
                    handleRelayout();
                  }}
                >
                  {t('flows.builder.relayout')}
                </MenuItem>
              )}
              {authoringMode === 'advanced' && (
                <MenuItem disabled={nodes.length === 0} onClick={handleRepairStatic}>
                  {t('flows.builder.repairAutomatic')}
                </MenuItem>
              )}
              {authoringMode === 'advanced' && (
                <MenuItem disabled={nodes.length === 0} onClick={handleRepairWithAI}>
                  {t('flows.builder.repairAi')}
                </MenuItem>
              )}
              {initialFlow && !isDraft && <Divider />}
              {initialFlow && !isDraft && authoringMode === 'advanced' && (
                <MenuItem
                  onClick={() => {
                    setMoreActionsMenuAnchor(null);
                    setImproveInitialDescription('');
                    setImproveDialogOpen(true);
                  }}
                >
                  {t('flows.builder.improveAi')}
                </MenuItem>
              )}
              {initialFlow && !isDraft && (
                <MenuItem
                  onClick={() => {
                    setMoreActionsMenuAnchor(null);
                    setVersionHistoryOpen(true);
                  }}
                >
                  {authoringMode === 'guided' ? t('flows.builder.previousVersions') : t('flows.builder.history')}
                </MenuItem>
              )}
              {initialFlow && !isDraft && (
                <MenuItem
                  onClick={() => {
                    setMoreActionsMenuAnchor(null);
                    setDialogType('duplicate');
                    setNewFlowName(t('flows.page.copyName', { name: initialFlow.name }));
                    setDialogOpen(true);
                  }}
                >
                  {authoringMode === 'guided' ? t('flows.builder.duplicateAgent') : t('flows.builder.duplicateFlow')}
                </MenuItem>
              )}
              {initialFlow && !isDraft && (
                <MenuItem
                  sx={{ color: 'error.main' }}
                  onClick={() => {
                    setMoreActionsMenuAnchor(null);
                    handleDelete();
                  }}
                >
                  {authoringMode === 'guided' ? t('flows.builder.deleteAgent') : t('flows.builder.deleteFlow')}
                </MenuItem>
              )}
                </Menu>
              </>
            )}
          </ToolbarContainer>

          <Collapse in={!!builderNotice} unmountOnExit>
            {builderNotice && (
              <Alert
                severity="warning"
                onClose={() => setBuilderNotice(null)}
                sx={{ mb: 1 }}
              >
                {builderNotice}
              </Alert>
            )}
          </Collapse>

          {/* AI-Improve result notice (issue #99) — dismissible summary of the last revision. */}
          <Collapse in={!!improveNotice} unmountOnExit>
            {improveNotice && (
              <Alert
                severity={improveNotice.severity}
                onClose={() => setImproveNotice(null)}
                sx={{ mb: 1 }}
              >
                {improveNotice.message}
              </Alert>
            )}
          </Collapse>
          
          {authoringMode === 'guided' ? (
            <GuidedFlowComposer
              nodes={nodes}
              orderedStepIds={guidedGraph.orderedNodeIds}
              subagentNodeIds={guidedGraph.subagentNodeIds}
              selectedNodeId={selectedNode?.id}
              flowName={flowName}
              flowNameError={flowNameError}
              onFlowNameChange={(value) => {
                flowNameRef.current = value;
                setFlowName(value);
                setFlowNameError(validateFlowName(value));
                markDirty();
              }}
              onSelectNode={handleSelectGuidedNode}
              onOpenNode={(node) => openNodeProperties(node)}
              onAddTask={handleAddGuidedTask}
              onTry={onTry ? () => { void handleTry(); } : undefined}
              isSaving={saveStatus === 'saving'}
              hasAdvancedFeatures={hasUnsafeGuidedGraph}
              readyToTry={canTryGuided}
              needsAIConnection={!guidedModelsReady}
              onSwitchAdvanced={() => setAuthoringMode('advanced')}
              models={guidedModels}
              modelsLoading={!guidedModelsLoaded}
              aiAssistance={guidedAiAssistance}
              selectedModelId={guidedSelectedModelId}
              onChooseAssistance={(choice) => {
                setGuidedAiAssistance(choice);
                setGuidedSelectedModelId(current => choice === 'manual'
                  ? null
                  : current ?? getPreferredGuidedModelId(guidedModels));
              }}
              onModelChange={setGuidedSelectedModelId}
              onCheckPlausibility={() => {
                setAssistanceNodeId(null);
                setAssistanceFocus('review');
                setAssistanceOpen(true);
              }}
              currentFlowId={initialFlow?.id ?? fallbackFlowId.current}
              availableAgents={allFlows}
              mcpConnectionsByNode={mcpConnectionsByProcess}
              agentConnectionsByNode={agentConnectionsByProcess}
              onConnectMcpServer={handleConnectMcpServer}
              onRemoveMcpServer={handleRemoveMcpServer}
              loadMcpServers={loadInspectorMcpServers}
              onConnectAgent={handleConnectGuidedAgent}
              onRemoveAgent={handleRemoveGuidedAgent}
            />
          ) : (
            <Box
              sx={{
                flex: 1,
                width: '100%',
                minWidth: 0,
                minHeight: 0,
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {isMobileBuilder && (
                <Box sx={{ mb: 1 }}>
                  <NodePalette authoringMode={authoringMode} onAddNode={handleQuickAddNode} />
                </Box>
              )}
              <Canvas
                ref={reactFlowWrapper}
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onInit={onInit}
                reactFlowWrapper={reactFlowWrapper}
                onEditNode={openNodeProperties}
                onCreateNode={handleCreateNode}
                onConfigureNode={configureQuickCreatedAttachment}
                onConvertProcessToSubflow={initialFlow ? node => setConversionProcessId(node.id) : undefined}
                onEditEdge={(edge) => setEditingEdge(edge)}
              />
            </Box>
          )}
        </MainContent>
        </ReactFlowProvider>
      </FlowNamesContext.Provider>

      {(authoringMode === 'advanced' || selectedNode) && (
        <InspectorPanel
          selectedNode={selectedNode}
          onClearSelection={handleClearNodeSelection}
          onCommitNode={updateNodeData}
          onOpenAdvanced={openNodeProperties}
          onOpenTechnicalDetails={(node) => setTechnicalDetailsNodeId(node.id)}
          flowName={flowName}
          flowNameError={flowNameError}
          onFlowNameChange={(value) => {
            flowNameRef.current = value;
            setFlowName(value);
            setFlowNameError(validateFlowName(value));
            markDirty();
          }}
          flowDescription={flowDescription}
          onFlowDescriptionChange={(value) => {
            setFlowDescription(value);
            markDirty();
          }}
          authoringMode={authoringMode}
          beginnerMode={authoringMode === 'guided'}
          onAuthoringModeChange={setAuthoringMode}
          onSuggestTools={(node) => {
            setAssistanceNodeId(node.id);
            setAssistanceFocus('apps');
            setAssistanceOpen(true);
          }}
          onSuggestAgents={(node) => {
            setAssistanceNodeId(node.id);
            setAssistanceFocus('agents');
            setAssistanceOpen(true);
          }}
          onImprovePrompt={async (node) => {
            const boundModel = node.data.properties?.boundModel;
            const legacyModel = node.data.properties?.modelId;
            const promptModelId = typeof boundModel === 'string' && boundModel
              ? boundModel
              : typeof legacyModel === 'string' && legacyModel
                ? legacyModel
                : guidedSelectedModelId;
            if (!promptModelId) throw new Error(t('flows.inspector.chooseAiToImprove'));
            const flowWithCommittedNode: Flow = {
              ...currentFlow,
              nodes: currentFlow.nodes.map((candidate) => candidate.id === node.id ? node : candidate),
            };
            const result = await flowService.improvePromptForStep({
              flow: flowWithCommittedNode,
              relatedFlows: relatedDraftFlows,
              nodeId: node.id,
              modelId: promptModelId,
            });
            return result.prompt;
          }}
          onCheckPlausibility={() => {
            setAssistanceNodeId(null);
            setAssistanceFocus('review');
            setAssistanceOpen(true);
          }}
          connectedMcpServers={connectedInspectorMcpServers}
          onConnectMcpServer={handleConnectMcpServer}
          onRemoveMcpServer={handleRemoveMcpServer}
          loadMcpServers={loadInspectorMcpServers}
          onSelectMcpNodeServer={handleSelectMcpNodeServer}
          currentFlowId={initialFlow?.id ?? fallbackFlowId.current}
          availableAgents={allFlows}
          connectedAgents={selectedNode?.data.type === 'process'
            ? agentConnectionsByProcess.get(selectedNode.id) ?? []
            : []}
          onConnectAgent={handleConnectGuidedAgent}
          onRemoveAgent={handleRemoveGuidedAgent}
          models={guidedModels}
          onNavigateToFlow={onNavigateToFlow
            ? (targetFlowId) => requestNavigation(() => onNavigateToFlow(targetFlowId))
            : undefined}
        />
      )}
      
      {/* Node Properties Modals */}
      <ProcessNodePropertiesModal
        open={processModalOpen}
        node={nodeToEdit}
        onClose={() => {
          setProcessModalOpen(false);
          setProcessNodeModalMode('edit');
        }}
        onSave={handleNodeUpdate}
        mode={processNodeModalMode}
        flowEdges={edges}
        flowNodes={nodes}
        flowId={initialFlow?.id}
        onConnectMcpServer={(serverName) => {
          if (nodeToEdit) {
            handleConnectMcpServer(nodeToEdit.id, serverName);
          }
        }}
        authoringMode={authoringMode}
      />

      <FlowAssistanceDialog
        open={assistanceOpen}
        flow={currentFlow}
        relatedFlows={relatedDraftFlows}
        nodeId={assistanceNodeId}
        initialFocus={assistanceFocus}
        modelId={assistanceModelId}
        models={guidedModels}
        onApply={applyAssistedFlow}
        onApplyRelatedFlows={onRelatedDraftFlowsChange}
        onClose={() => setAssistanceOpen(false)}
      />
      
      <MCPNodePropertiesModal 
        open={mcpModalOpen}
        node={nodeToEdit}
        onClose={() => {
          setMcpModalOpen(false);
          setQuickMcpServerPicker(false);
        }}
        onSave={handleNodeUpdate}
        authoringMode={authoringMode}
        serverPickerInitiallyOpen={quickMcpServerPicker}
        onQuickServerSelect={quickMcpServerPicker ? async (node, serverName) => {
          await handleSelectMcpNodeServer(node, serverName);
          setQuickMcpServerPicker(false);
        } : undefined}
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

      <SubflowNodePropertiesModal
        open={subflowModalOpen}
        node={nodeToEdit}
        onClose={() => setSubflowModalOpen(false)}
        onSave={handleNodeUpdate}
        onNavigateToFlow={onNavigateToFlow ? (targetFlowId) => {
          setSubflowModalOpen(false);
          requestNavigation(() => onNavigateToFlow(targetFlowId));
        } : undefined}
        flowId={initialFlow?.id}
        authoringMode={authoringMode}
      />

      <ResourceNodePropertiesModal
        open={resourceModalOpen}
        node={nodeToEdit}
        onClose={() => setResourceModalOpen(false)}
        onSave={handleNodeUpdate}
        flowNodes={nodes}
      />

      <SignalNodePropertiesModal
        open={signalModalOpen}
        node={nodeToEdit}
        onClose={() => setSignalModalOpen(false)}
        onSave={handleNodeUpdate}
      />

      <StaticNodePropertiesModal
        open={staticModalOpen}
        node={nodeToEdit}
        onClose={() => setStaticModalOpen(false)}
        onSave={handleStaticNodeUpdate}
      />

      <TriggerNodePropertiesModal
        open={triggerModalOpen}
        node={nodeToEdit}
        flowId={initialFlow?.id || ''}
        onClose={() => { setTriggerModalOpen(false); setNodeToEdit(null); }}
        onSave={handleNodeUpdate}
      />

      {/* Node technical details (issue #412): read-only, sanitized view that
          replaced the inline accordion on every canvas node. */}
      <NodeTechnicalDetailsModal
        open={!!technicalDetailsNode}
        node={technicalDetailsNode}
        flowNames={flowNames}
        onClose={() => setTechnicalDetailsNodeId(null)}
      />

      <EdgePropertiesModal
        open={!!editingEdge}
        edge={editingEdge}
        onClose={() => setEditingEdge(null)}
        onSave={handleSaveEdgeCondition}
      />

      <ConvertProcessToSubflowDialog
        open={!!conversionProcessId}
        processNodeId={conversionProcessId}
        parentFlow={{
          id: initialFlow?.id || '',
          name: flowName,
          description: flowDescription,
          folder: initialFlow?.folder,
          favorite: initialFlow?.favorite,
          createdAt: initialFlow?.createdAt,
          updatedAt: initialFlow?.updatedAt,
          nodes,
          edges,
        }}
        existingFlowNames={allFlows.map(flow => flow.name)}
        onClose={() => setConversionProcessId(null)}
        onAccept={handleAcceptProcessConversion}
      />

      {/* Version history: browse/preview/restore archived versions of this flow. */}
      <FlowVersionHistoryDialog
        open={versionHistoryOpen}
        flowId={initialFlow?.id}
        onClose={() => setVersionHistoryOpen(false)}
        onRestore={handleRestoreVersion}
      />

      {/* AI-Improve dialog (issue #99): revises the CURRENT canvas state (incl. unsaved edits). */}
      <ImproveFlowDialog
        open={improveDialogOpen}
        onClose={() => setImproveDialogOpen(false)}
        currentFlow={{
          id: initialFlow?.id || '',
          name: flowName,
          description: flowDescription,
          nodes,
          edges,
        }}
        onImproved={handleImproved}
        initialDescription={improveInitialDescription}
      />
      {/* Dialog for Copy/Rename/Unsaved Changes */}
      <Dialog open={dialogOpen} onClose={handleDialogClose}>
        <DialogTitle>
          {dialogType === 'duplicate' 
            ? authoringMode === 'guided' ? t('flows.builder.copyAgent') : t('flows.builder.copyFlow')
            : dialogType === 'rename' 
              ? authoringMode === 'guided' ? t('flows.builder.renameAgent') : t('flows.builder.renameFlow')
              : t('flows.builder.unsavedChanges')}
        </DialogTitle>
        <DialogContent>
          {dialogType === 'unsaved' ? (
            <DialogContentText>
              {t('flows.builder.unsavedQuestion')}
            </DialogContentText>
          ) : (
            <>
              <DialogContentText>
                {dialogType === 'duplicate' 
                  ? t('flows.builder.copyPrompt')
                  : t('flows.builder.renameQuestion')}
              </DialogContentText>
              <TextField
                autoFocus
                margin="dense"
                label={authoringMode === 'guided' ? t('flows.builder.agentName') : t('flows.builder.flowName')}
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
          <Button onClick={handleDialogClose}>{t('flows.builder.cancel')}</Button>
          
          {dialogType === 'unsaved' && (
            <>
              <Button 
                onClick={handleDiscardAndContinue}
                color="error"
              >
                {t('flows.builder.discard')}
              </Button>
              <Button 
                onClick={handleSaveAndContinue}
                variant="contained" 
                color="primary"
              >
                {t('flows.builder.saveChanges')}
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
                {t('flows.builder.copy')}
              </Button>
              <Button 
                onClick={handleDialogConfirm} 
                variant="contained" 
                color="primary"
                disabled={!!newFlowNameError}
              >
                {t('flows.builder.rename')}
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
              {t('flows.builder.copy')}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </FlowBuilderContainer>
  );
});

FlowBuilder.displayName = 'FlowBuilder';

export default FlowBuilder;
