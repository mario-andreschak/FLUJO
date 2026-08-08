"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    Box, Typography, List, ListItem, ListItemButton, ListItemText, Button, Paper, CircularProgress, Alert,
    Accordion, AccordionSummary, AccordionDetails, // Import Accordion components
    IconButton, Tooltip, Menu, MenuItem, ListItemIcon, Chip, alpha
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'; // Import icon for Accordion
import CloseIcon from '@mui/icons-material/Close';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import { styled, useTheme } from '@mui/material/styles';
import { ReactFlow, useNodesState, useEdgesState, Node, Edge, ReactFlowProvider } from '@xyflow/react'; // Import ReactFlow components
import { SharedState, DebugStep, ModelInputSnapshot } from '@/backend/execution/flow/types'; // Import backend types
import { Flow } from '@/shared/types/flow'; // Import shared Flow type
import type { ExecutionEvent } from '@/shared/types/execution/events';
import { flowService } from '@/frontend/services/flow'; // Import flow service
import { createLogger } from '@/utils/logger';

// Import custom nodes and edges if needed for display (might need adaptation for read-only)
import { StartNode, ProcessNode, FinishNode, MCPNode, SubflowNode, ResourceNode } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';
import { CustomEdge, MCPEdge, ResourceEdge } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges';
import { LiveActivity, LIVE_HIGHLIGHT_TTL_MS, resourceActivityKey } from '@/utils/shared/liveActivity';
import {
  buildDebuggerFrames,
  debuggerFramePath,
  DEBUGGER_ROOT_FRAME_KEY,
  type DebuggerFrame,
} from '@/utils/shared/debuggerFrames';
import {
  ANY_TOOL_BREAKPOINT,
  nodeBreakpoints,
  toolBreakpointNames,
  toolNodeBreakpointIds,
  TOOL_NODE_BREAKPOINT_PREFIX,
} from '@/utils/shared/debugBreakpoints';
import RunResourcesPanel from './RunResourcesPanel';
import DebuggerConversation from './DebuggerConversation';
import { useI18n } from '@/frontend/contexts/I18nContext';

// Import Canvas components if needed (or create simplified versions)
// import { CanvasControls } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/components/CanvasControls';

const log = createLogger('frontend/components/Chat/DebuggerCanvas');

// Define props for the DebuggerCanvas
interface DebuggerCanvasProps {
  debugState: SharedState;
  conversationId: string;
  onStep: () => void; // Callback for Next Step button
  onStepOver?: () => void; // Callback for Step Over (skip a node's internal iterations)
  onContinue: () => void; // Callback for Continue button
  onCancel: () => void; // Callback for Cancel button
  isLoading: boolean; // To disable buttons during API calls
  breakpoints?: string[]; // Node IDs with active breakpoints (+ `tool:` entries)
  onToggleBreakpoint?: (nodeId: string) => void; // Toggle a breakpoint on node click
  /** Replace the whole breakpoint set — used by the canvas context menu for
   *  bulk actions (clear all, arm/disarm the tool-call breakpoint). */
  onSetBreakpoints?: (breakpoints: string[]) => void;
  onClose?: () => void; // Callback to dismiss/hide the debugger panel
  /** Whether the debugger is currently shown in the large (modal) layout. */
  isExpanded?: boolean;
  /** Toggle between the docked side panel and the large modal layout. */
  onToggleExpand?: () => void;
  /** Live node/resource activity from the SSE stream (Tier 3): highlights the
   *  node currently executing and the artifacts being read/written, fading
   *  over LIVE_HIGHLIGHT_TTL_MS. Absent ⇒ trace-driven highlighting only. */
  liveActivity?: LiveActivity;
  /** Ordered, deduplicated events from the owning SSE subscription. */
  executionEvents?: readonly ExecutionEvent[];
}

// Define node types for React Flow display. Every builder node type must be
// registered here: an unregistered type falls back to React Flow's default
// node, which lacks the named handles the flow's edges reference — so ALL
// edges from/to such a node are silently dropped (this is how subflow nodes
// lost their edges in the debugger).
const nodeTypes = {
  start: StartNode,
  process: ProcessNode,
  finish: FinishNode,
  mcp: MCPNode,
  subflow: SubflowNode,
  resource: ResourceNode,
};

// Define edge types
const edgeTypes = {
  custom: CustomEdge,
  mcpEdge: MCPEdge,
  resourceEdge: ResourceEdge,
};

// Teal, matching RESOURCE_COLOR in CustomNodes.
const RESOURCE_HIGHLIGHT = '#009688';
const EMPTY_EXECUTION_EVENTS: readonly ExecutionEvent[] = [];

type FlowCacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; flow: Flow }
  | { status: 'missing' }
  | { status: 'error'; message: string };

// --- Debugger layout (issue #162) ---------------------------------------------
// The debugger is split into three top-level sections — Conversation,
// Execution Tracker + Canvas, and Detail — each of which can be hidden,
// reordered (moved left/right), and (for the side sections) resized. The chosen
// visibility / order / widths persist in localStorage so the layout survives
// reloads, consistent with how the docked panel width is handled in Chat/index.
type SectionKey = 'conversation' | 'tracker' | 'detail';
const SECTION_KEYS: SectionKey[] = ['conversation', 'tracker', 'detail'];
const CONV_WIDTH_DEFAULT = 480;
const DETAIL_WIDTH_DEFAULT = 320;
const SECTION_MIN_WIDTH = 240;
const SECTION_MAX_WIDTH = 1100;

const LS_ORDER = 'flujo-debugger-section-order';
const LS_VISIBLE = 'flujo-debugger-section-visible';
const LS_CONV_WIDTH = 'flujo-debugger-conv-width';
const LS_DETAIL_WIDTH = 'flujo-debugger-detail-width';

function readOrder(): SectionKey[] {
  if (typeof window === 'undefined') return [...SECTION_KEYS];
  try {
    const raw = JSON.parse(window.localStorage.getItem(LS_ORDER) || 'null');
    if (Array.isArray(raw)) {
      const filtered = raw.filter((k): k is SectionKey => SECTION_KEYS.includes(k));
      // Repair: keep every known key exactly once, preserving saved order.
      const missing = SECTION_KEYS.filter((k) => !filtered.includes(k));
      if (filtered.length + missing.length === SECTION_KEYS.length) return [...filtered, ...missing];
    }
  } catch { /* ignore malformed */ }
  return [...SECTION_KEYS];
}

function readVisible(): Record<SectionKey, boolean> {
  const base: Record<SectionKey, boolean> = { conversation: true, tracker: true, detail: true };
  if (typeof window === 'undefined') return base;
  try {
    const raw = JSON.parse(window.localStorage.getItem(LS_VISIBLE) || 'null');
    if (raw && typeof raw === 'object') {
      for (const k of SECTION_KEYS) if (typeof raw[k] === 'boolean') base[k] = raw[k];
    }
  } catch { /* ignore malformed */ }
  return base;
}

function readWidth(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const saved = Number(window.localStorage.getItem(key));
  return Number.isFinite(saved) && saved >= SECTION_MIN_WIDTH ? saved : fallback;
}

// Styled component for the main container
const DebuggerContainer = styled(Paper)(({ theme }) => ({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
  padding: theme.spacing(1),
}));

const Header = styled(Box)(({ theme }) => ({
  padding: theme.spacing(1, 2),
  borderBottom: `1px solid ${theme.palette.divider}`,
}));

const ContentArea = styled(Box)({
  flexGrow: 1,
  display: 'flex',
  overflow: 'hidden', // Prevent content overflow
  minHeight: 0,
});

const TracePanel = styled(Box)(({ theme }) => ({
  width: '200px', // Fixed width for trace list
  flexShrink: 0,
  borderRight: `1px solid ${theme.palette.divider}`,
  overflowY: 'auto',
  padding: theme.spacing(1),
}));

const FlowDisplayPanel = styled(Box)({
  flexGrow: 1,
  position: 'relative', // Needed for ReactFlow attribution
  height: '100%', // Ensure it takes full height
});

const ControlsPanel = styled(Box)(({ theme }) => ({
    padding: theme.spacing(1, 2),
    borderTop: `1px solid ${theme.palette.divider}`,
    display: 'flex',
    gap: theme.spacing(1),
    justifyContent: 'center',
}));

// A thin draggable divider used to resize the side sections.
const SectionResizer = styled(Box)(({ theme }) => ({
  width: '6px',
  flexShrink: 0,
  cursor: 'col-resize',
  backgroundColor: theme.palette.divider,
  transition: 'background-color 120ms',
  touchAction: 'none',
  '&:hover': { backgroundColor: theme.palette.primary.main },
}));


const DebuggerCanvas: React.FC<DebuggerCanvasProps> = ({
  debugState,
  conversationId,
  onStep,
  onStepOver,
  onContinue,
  onCancel,
  isLoading,
  breakpoints,
  onToggleBreakpoint,
  onSetBreakpoints,
  onClose,
  isExpanded,
  onToggleExpand,
  liveActivity,
  executionEvents = EMPTY_EXECUTION_EVENTS,
}) => {
  const theme = useTheme();
  const { t, tp, formatDate: formatLocalizedDate } = useI18n();
  const sectionTitles: Record<SectionKey, string> = {
    conversation: t('chat.debug.section.conversation'),
    tracker: t('chat.debug.section.tracker'),
    detail: t('chat.debug.section.detail'),
  };
  // Initialize step index safely, defaulting to -1 if no trace
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(
    debugState.executionTrace && debugState.executionTrace.length > 0 ? debugState.executionTrace.length - 1 : -1
  );

  // --- Section layout state (issue #162) ---
  const [order, setOrder] = useState<SectionKey[]>(() => readOrder());
  const [visible, setVisible] = useState<Record<SectionKey, boolean>>(() => readVisible());
  const [convWidth, setConvWidth] = useState<number>(() => readWidth(LS_CONV_WIDTH, CONV_WIDTH_DEFAULT));
  const [detailWidth, setDetailWidth] = useState<number>(() => readWidth(LS_DETAIL_WIDTH, DETAIL_WIDTH_DEFAULT));

  const frameState = useMemo(
    () => buildDebuggerFrames(debugState.flowId ?? '', executionEvents),
    [debugState.flowId, executionEvents],
  );
  const [selectedFrameKey, setSelectedFrameKey] = useState<string>(DEBUGGER_ROOT_FRAME_KEY);
  const [flowCache, setFlowCache] = useState<Record<string, FlowCacheEntry>>({});
  const requestedFlowIdsRef = useRef<Set<string>>(new Set());
  const flowSessionRef = useRef(0);

  // State for React Flow nodes and edges with correct explicit types
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]); // Use Node, not Node[]
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]); // Use Edge, not Edge[]

  // Persist layout preferences so the split survives reloads.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LS_ORDER, JSON.stringify(order));
  }, [order]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LS_VISIBLE, JSON.stringify(visible));
  }, [visible]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LS_CONV_WIDTH, String(Math.round(convWidth)));
  }, [convWidth]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LS_DETAIL_WIDTH, String(Math.round(detailWidth)));
  }, [detailWidth]);

  // Update currentStepIndex when debugState changes (new step added or trace cleared)
  useEffect(() => {
    const traceLength = debugState.executionTrace?.length || 0;
    if (traceLength > 0) {
      // If the current index is now invalid (e.g., trace got shorter?), reset to last step
      setCurrentStepIndex(prevIndex => Math.min(prevIndex, traceLength - 1));
      // If a new step was likely added, update to the last step
      if (currentStepIndex < traceLength -1) {
         setCurrentStepIndex(traceLength - 1);
      }
    } else {
      setCurrentStepIndex(-1); // Set to -1 if trace is empty
    }
    // Depend only on the trace itself, not the index state variable
  }, [debugState.executionTrace]);

  // Follow the most recent qualified event frame. A manual history selection is
  // preserved until another event arrives, at which point live-follow resumes.
  useEffect(() => {
    setSelectedFrameKey(frameState.activeFrameKey);
  }, [frameState.activeFrameKey, executionEvents.length]);

  // Flow definitions are session-scoped: child executions can be ephemeral, so
  // resolve the saved definition by subflowId and cache it for frame history.
  const frameFlowIds = useMemo(
    () => Array.from(new Set(frameState.order.map(key => frameState.frames[key]?.flowId).filter(Boolean))),
    [frameState],
  );

  useEffect(() => {
    flowSessionRef.current += 1;
    requestedFlowIdsRef.current.clear();
    setFlowCache({});
    setSelectedFrameKey(DEBUGGER_ROOT_FRAME_KEY);
  }, [conversationId, debugState.flowId]);

  useEffect(() => {
    const session = flowSessionRef.current;
    for (const flowId of frameFlowIds) {
      if (!flowId || requestedFlowIdsRef.current.has(flowId)) continue;
      requestedFlowIdsRef.current.add(flowId);
      setFlowCache(prev => ({ ...prev, [flowId]: { status: 'loading' } }));
      void flowService.getFlow(flowId).then(flow => {
        if (flowSessionRef.current !== session) return;
        setFlowCache(prev => ({
          ...prev,
          [flowId]: flow ? { status: 'ready', flow } : { status: 'missing' },
        }));
      }).catch(err => {
        if (flowSessionRef.current !== session) return;
        const message = err instanceof Error ? err.message : t('chat.debug.loadFlowFailed', { id: flowId });
        log.error('Error loading debugger flow definition:', err);
        setFlowCache(prev => ({ ...prev, [flowId]: { status: 'error', message } }));
      });
    }
  }, [conversationId, debugState.flowId, frameFlowIds, t]);

  const selectedFrame = frameState.frames[selectedFrameKey]
    ?? frameState.frames[frameState.activeFrameKey]
    ?? frameState.frames[DEBUGGER_ROOT_FRAME_KEY];
  const selectedFlowEntry = flowCache[selectedFrame.flowId];

  // If a child definition is unavailable, keep the nearest loaded parent graph
  // on screen. The child frame remains selectable and its diagnostic stays
  // visible, so a missing graph never makes the parent debugger unusable.
  let canvasFrame: DebuggerFrame = selectedFrame;
  while (flowCache[canvasFrame.flowId]?.status !== 'ready' && canvasFrame.parentKey) {
    canvasFrame = frameState.frames[canvasFrame.parentKey] ?? frameState.frames[DEBUGGER_ROOT_FRAME_KEY];
  }
  const canvasFlowEntry = flowCache[canvasFrame.flowId];
  const flowDefinition = canvasFlowEntry?.status === 'ready' ? canvasFlowEntry.flow : null;
  const rootFlowEntry = flowCache[debugState.flowId ?? ''];
  const flowLoading = !!debugState.flowId && !flowDefinition
    && (!rootFlowEntry || rootFlowEntry.status === 'loading');
  const flowError = !debugState.flowId
    ? t('chat.debug.flowMissingId')
    : rootFlowEntry?.status === 'missing'
      ? t('chat.debug.flowNotFound', { id: debugState.flowId })
      : rootFlowEntry?.status === 'error'
        ? rootFlowEntry.message
        : null;
  const childFlowNotice = selectedFrame.key !== DEBUGGER_ROOT_FRAME_KEY
    && selectedFlowEntry?.status !== 'ready'
      ? selectedFlowEntry?.status === 'loading' || !selectedFlowEntry
        ? t('chat.debug.loadingChild', { agent: selectedFrame.displayName })
        : t('chat.debug.childUnavailable', { agent: selectedFrame.displayName })
      : null;

  // Initialize/Update React Flow nodes and edges when the selected frame's
  // resolved definition changes.
  useEffect(() => {
    if (!flowDefinition) {
      setNodes([]);
      setEdges([]);
      return;
    }
    log.debug(`Setting debugger graph for flow ${flowDefinition.id}`);
    setNodes(flowDefinition.nodes.map(node => ({
      ...node,
      draggable: false,
      selectable: false,
      connectable: false,
    })));
    setEdges(flowDefinition.edges.map(edge => ({ ...edge, selectable: false })));
  }, [flowDefinition, setNodes, setEdges]);

  // NOTE: current-node highlighting + breakpoint markers are applied via a
  // derived `displayNodes` memo (below), not by mutating node state in an
  // effect. The previous effect listed `nodes` in its deps while calling
  // setNodes, which caused a re-render loop.

  const handleStepSelect = (index: number) => {
    // Ensure index is valid before setting
    if (debugState.executionTrace && index >= 0 && index < debugState.executionTrace.length) {
       log.debug(`Trace step selected: ${index}`);
       setCurrentStepIndex(index);
    } else {
       log.warn(`Invalid step index selected: ${index}`);
    }
  };

  // Corrected handlePreviousStep
  const handlePreviousStep = useCallback(() => {
      log.debug(`Previous button clicked. Current index: ${currentStepIndex}`);
      if (currentStepIndex > 0) {
          const newIndex = currentStepIndex - 1;
          log.debug(`Setting current step index to: ${newIndex}`);
          setCurrentStepIndex(newIndex);
      } else {
          log.debug("Already at the first step, cannot go previous.");
      }
  }, [currentStepIndex]); // Dependency on currentStepIndex

  const handleNextStep = useCallback(() => {
      log.debug(`Next button clicked. Current index: ${currentStepIndex}, Trace length: ${debugState.executionTrace?.length}`);
      if (debugState.executionTrace && currentStepIndex < debugState.executionTrace.length - 1) {
          // Just navigate the existing trace
          const newIndex = currentStepIndex + 1;
          log.debug(`Navigating to next trace step: ${newIndex}`);
          setCurrentStepIndex(newIndex);
      } else {
          // If at the end, trigger the actual step execution via callback
          log.info("At end of trace, triggering API call for next step.");
          onStep(); // Call the passed-in onStep function
      }
  }, [currentStepIndex, debugState.executionTrace, onStep]); // Added dependencies

  // Derive the current step data for the inspector
  const currentStepData: DebugStep | undefined = useMemo(() => {
    if (debugState.executionTrace && currentStepIndex >= 0 && currentStepIndex < debugState.executionTrace.length) {
      return debugState.executionTrace[currentStepIndex];
    }
    return undefined; // Explicitly return undefined if conditions aren't met
  }, [debugState.executionTrace, currentStepIndex]); // Added closing parenthesis and dependency array

  // Per-model-call wire snapshots for the selected step (issue #167, Phase 2 of
  // #162). Prefer the plural `modelInputs` array; fall back to the singular
  // `modelInput` for older traces / non-plural producers so nothing regresses.
  const modelInputs: ModelInputSnapshot[] | undefined = useMemo(() => {
    if (currentStepData?.modelInputs && currentStepData.modelInputs.length > 0) {
      return currentStepData.modelInputs;
    }
    return currentStepData?.modelInput ? [currentStepData.modelInput] : undefined;
  }, [currentStepData]);

  // Which model call within the selected step is shown. Reset to the first call
  // whenever the step changes so paging never points past a shorter step.
  const [callIndex, setCallIndex] = useState<number>(0);
  useEffect(() => { setCallIndex(0); }, [currentStepIndex]);

  const safeCallIndex = modelInputs ? Math.min(callIndex, modelInputs.length - 1) : 0;
  const selectedModelInput: ModelInputSnapshot | undefined = modelInputs?.[safeCallIndex];

  // Decay repaint (Tier 3 live highlighting): while any live-activity entry is
  // younger than the TTL, a low-frequency interval bumps `now` so highlights
  // fade out; it self-stops once everything has aged out.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [executionEvents.length]);
  useEffect(() => {
    if (!liveActivity) return;
    const hasYoung = () => {
      const t = Date.now();
      return [
        ...Object.values(liveActivity.byNode),
        ...Object.values(liveActivity.byResource),
        ...Object.values(liveActivity.byResourceName),
      ].some(entry => t - entry.ts < LIVE_HIGHLIGHT_TTL_MS);
    };
    if (!hasYoung()) return;
    const interval = setInterval(() => {
      setNow(Date.now());
      if (!hasYoung()) clearInterval(interval);
    }, 350);
    return () => clearInterval(interval);
  }, [liveActivity]);

  // Resolve a node's live activity: process/subflow nodes match by node id;
  // resource nodes ALSO match by their artifact identity (server+uri for
  // static, runName for run artifacts) since most resource events carry the
  // artifact, not a node id.
  const liveActivityFor = useCallback((node: Node): { kind: 'active' | 'resource-read' | 'resource-write'; ts: number } | null => {
    const qualified = canvasFrame.nodeActivity[node.id];
    if (qualified && now - qualified.ts < LIVE_HIGHLIGHT_TTL_MS) return qualified;

    // The legacy liveActivity map is node-id-only, so use it for the root frame
    // only. Child frames rely on qualified frame activity to prevent identical
    // parent/child node IDs or fan-out lanes from lighting each other up.
    if (canvasFrame.key !== DEBUGGER_ROOT_FRAME_KEY || !liveActivity) return null;
    const byNode = liveActivity.byNode[node.id];
    if (byNode && now - byNode.ts < LIVE_HIGHLIGHT_TTL_MS) return byNode;
    const data = node.data as { type?: string; properties?: Record<string, unknown> } | undefined;
    if ((data?.type ?? node.type) !== 'resource') return null;
    const props = (data?.properties ?? {}) as Record<string, unknown>;
    const entry = props.scope === 'run'
      ? (typeof props.runName === 'string' ? liveActivity.byResourceName[props.runName] : undefined)
      : (typeof props.boundServer === 'string' && typeof props.uri === 'string'
          ? liveActivity.byResource[resourceActivityKey(props.boundServer, props.uri)]
          : undefined);
    if (entry && now - entry.ts < LIVE_HIGHLIGHT_TTL_MS) {
      return { kind: entry.kind === 'read' ? 'resource-read' : 'resource-write', ts: entry.ts };
    }
    return null;
  }, [canvasFrame, liveActivity, now]);

  const breakpointKeyForNode = useCallback((node: Node): string | null => {
    // Child runs currently stream into the parent debugger but execute in their
    // own SharedState. Do not pretend a parent breakpoint can stop them.
    if (canvasFrame.key !== DEBUGGER_ROOT_FRAME_KEY) return null;
    const nodeType = typeof node.data?.type === 'string' ? node.data.type : node.type;
    // MCP nodes are passive attachments. Translate the canvas affordance into
    // "break on any runtime tool supplied by this attachment".
    if (nodeType === 'mcp') return `${TOOL_NODE_BREAKPOINT_PREFIX}${node.id}`;
    // Resource/trigger nodes are data/event wiring, not executable visits.
    if (nodeType === 'resource' || nodeType === 'trigger') return null;
    return node.id;
  }, [canvasFrame.key]);

  // Derived nodes for display: highlight the inspected step's node (warning),
  // live activity (primary/teal, fading by age), and breakpoint nodes (error).
  // Precedence: debug step > live activity > breakpoint. Computed, not
  // stateful, to avoid render loops.
  const displayNodes = useMemo(() => {
    const highlightId = canvasFrame.key === DEBUGGER_ROOT_FRAME_KEY ? currentStepData?.nodeId : undefined;
    return nodes.map((node: Node) => {
      const isCurrent = node.id === highlightId;
      const breakpointKey = breakpointKeyForNode(node);
      const isBreakpoint = !!breakpointKey && !!breakpoints?.includes(breakpointKey);
      const live = isCurrent ? null : liveActivityFor(node);
      const liveOpacity = live ? Math.max(0.25, 1 - (now - live.ts) / LIVE_HIGHLIGHT_TTL_MS) : 0;
      const liveColor = live?.kind === 'active' ? theme.palette.primary.main : RESOURCE_HIGHLIGHT;
      return {
        ...node,
        // A breakpoint used to be a thin dashed border that disappeared under
        // the current-node/live highlights and was easy to miss entirely. It is
        // now a class on the node wrapper: the canvas styles it with a solid
        // red ring, a halo and a red dot marker (like a gutter breakpoint in an
        // IDE), so it stays visible WHILE the node is executing/highlighted.
        className: [node.className, isBreakpoint ? 'flujo-breakpoint' : null]
          .filter(Boolean)
          .join(' ') || undefined,
        style: {
          ...node.style,
          border: isCurrent
            ? `2px solid ${theme.palette.warning.main}`
            : live
              ? `2px solid ${liveColor}`
              : (node.style?.border as string | undefined),
          boxShadow: isCurrent
            ? `0 0 10px ${theme.palette.warning.light}`
            : live
              ? `0 0 ${live.kind === 'resource-write' ? 14 : 10}px ${liveColor}${Math.round(liveOpacity * 255).toString(16).padStart(2, '0')}`
              : undefined,
        },
      };
    });
  }, [nodes, canvasFrame.key, currentStepData, breakpoints, theme, liveActivityFor, now, breakpointKeyForNode]);

  // --- Breakpoint context menu ---------------------------------------------
  // Right-clicking a node (or the empty canvas) opens the breakpoint menu:
  // discoverable, and it also carries the bulk actions that have nowhere else
  // to live (clear all, break on every tool call).
  const [bpMenu, setBpMenu] = useState<{
    x: number;
    y: number;
    breakpointKey?: string;
    nodeLabel?: string;
    unavailableReason?: string;
  } | null>(null);
  const closeBpMenu = useCallback(() => setBpMenu(null), []);
  const activeBreakpoints = breakpoints ?? [];
  const toolBreakOn = activeBreakpoints.includes(ANY_TOOL_BREAKPOINT);

  const handleNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    const label = typeof node.data?.label === 'string' ? node.data.label : node.id;
    const breakpointKey = breakpointKeyForNode(node);
    setBpMenu({
      x: event.clientX,
      y: event.clientY,
      ...(breakpointKey ? { breakpointKey } : {}),
      nodeLabel: label,
      ...(!breakpointKey
        ? { unavailableReason: canvasFrame.key === DEBUGGER_ROOT_FRAME_KEY
            ? t('chat.debug.breakpointPassiveNode')
            : t('chat.debug.breakpointChildRun') }
        : {}),
    });
  }, [breakpointKeyForNode, canvasFrame.key, t]);

  const handlePaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    setBpMenu({ x: (event as React.MouseEvent).clientX, y: (event as React.MouseEvent).clientY });
  }, []);

  const toggleToolBreakpoint = useCallback(() => {
    if (!onSetBreakpoints) return;
    onSetBreakpoints(
      toolBreakOn
        ? activeBreakpoints.filter(b => b !== ANY_TOOL_BREAKPOINT)
        : [...activeBreakpoints, ANY_TOOL_BREAKPOINT],
    );
    closeBpMenu();
  }, [onSetBreakpoints, toolBreakOn, activeBreakpoints, closeBpMenu]);

  const clearAllBreakpoints = useCallback(() => {
    onSetBreakpoints?.([]);
    closeBpMenu();
  }, [onSetBreakpoints, closeBpMenu]);

  const selectedFramePath = useMemo(
    () => debuggerFramePath(frameState, selectedFrame.key),
    [frameState, selectedFrame.key],
  );
  const frameLabel = useCallback((frame: DebuggerFrame) => {
    const cached = flowCache[frame.flowId];
    const base = frame.key === DEBUGGER_ROOT_FRAME_KEY && cached?.status === 'ready'
      ? cached.flow.name
      : frame.displayName;
    return frame.laneIndex == null ? base : `${base} · lane ${frame.laneIndex + 1}`;
  }, [flowCache]);

  // The visible sections, in the user's chosen order.
  const visibleOrder = useMemo(() => order.filter((k) => visible[k]), [order, visible]);

  // Toggle a section's visibility.
  const toggleSection = useCallback((key: SectionKey) => {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Move a section left (-1) or right (+1) within the ordering.
  const moveSection = useCallback((key: SectionKey, dir: -1 | 1) => {
    setOrder((prev) => {
      const i = prev.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  // Resize a fixed-width side section by dragging. `sign` is +1 when dragging
  // right should grow the target (target is on the left of the divider) and -1
  // when it should shrink it (target is on the right of the divider).
  const startResize = useCallback((target: 'conversation' | 'detail', sign: 1 | -1, e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = target === 'conversation' ? convWidth : detailWidth;
    const set = target === 'conversation' ? setConvWidth : setDetailWidth;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      const width = Math.min(Math.max(startWidth + sign * (ev.clientX - startX), SECTION_MIN_WIDTH), SECTION_MAX_WIDTH);
      set(width);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [convWidth, detailWidth]);

  // Per-section header with title + move-left / move-right controls.
  const sectionHeader = (key: SectionKey) => {
    const idx = visibleOrder.indexOf(key);
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Typography variant="subtitle2" noWrap>{sectionTitles[key]}</Typography>
        <Box sx={{ display: 'flex' }}>
          <Tooltip title={t('chat.debug.moveLeft', { section: sectionTitles[key] })}>
            <span>
              <IconButton size="small" onClick={() => moveSection(key, -1)} disabled={idx <= 0} aria-label={t('chat.debug.moveLeft', { section: sectionTitles[key] })}>
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('chat.debug.moveRight', { section: sectionTitles[key] })}>
            <span>
              <IconButton size="small" onClick={() => moveSection(key, 1)} disabled={idx < 0 || idx >= visibleOrder.length - 1} aria-label={t('chat.debug.moveRight', { section: sectionTitles[key] })}>
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('chat.debug.hideSection', { section: sectionTitles[key] })}>
            <IconButton size="small" onClick={() => toggleSection(key)} aria-label={t('chat.debug.hideSection', { section: sectionTitles[key] })}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    );
  };

  // --- Section bodies ---

  const conversationBody = (
    <Box sx={{ flexGrow: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {currentStepData ? (
        selectedModelInput && modelInputs ? (
          <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Per-model-call pager (issue #167): only shown when the node made
                more than one captured model call this step. */}
            {modelInputs.length > 1 && (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, px: 1, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
                <Tooltip title={t('chat.debug.previousModelCall')}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={() => setCallIndex((i) => Math.max(0, Math.min(i, modelInputs.length - 1) - 1))}
                      disabled={safeCallIndex <= 0}
                      aria-label={t('chat.debug.previousModelCall')}
                    >
                      <ChevronLeftIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Typography variant="caption" color="textSecondary">
                  {t('chat.debug.modelCall', { current: safeCallIndex + 1, total: modelInputs.length })}
                </Typography>
                <Tooltip title={t('chat.debug.nextModelCall')}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={() => setCallIndex((i) => Math.min(modelInputs.length - 1, Math.min(i, modelInputs.length - 1) + 1))}
                      disabled={safeCallIndex >= modelInputs.length - 1}
                      aria-label={t('chat.debug.nextModelCall')}
                    >
                      <ChevronRightIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            )}
            <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <DebuggerConversation modelInput={selectedModelInput} conversationId={conversationId} />
            </Box>
          </Box>
        ) : (
          <Typography variant="body2" color="textSecondary" sx={{ p: 2 }}>
            {t('chat.debug.noModelCall')}
          </Typography>
        )
      ) : (
        <Typography variant="body2" color="textSecondary" sx={{ p: 2 }}>
          {t('chat.debug.selectStep')}
        </Typography>
      )}
    </Box>
  );

  const trackerBody = (
    <Box sx={{ flexGrow: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
      <TracePanel>
        <Typography variant="caption" color="textSecondary" gutterBottom sx={{ display: 'block' }}>{t('chat.debug.executionTrace')}</Typography>
        <List dense disablePadding>
          {debugState.executionTrace?.map((step, index) => (
            <ListItem key={step.stepIndex} disablePadding>
              <ListItemButton
                selected={index === currentStepIndex}
                onClick={() => handleStepSelect(index)}
              >
                <ListItemText primary={`${step.stepIndex}: ${step.nodeName || step.nodeId}`} secondary={step.nodeType} />
              </ListItemButton>
            </ListItem>
          ))}
          {isLoading && ( // Show loading indicator at the end if stepping
               <ListItem>
                  <CircularProgress size={20} sx={{ margin: 'auto' }}/>
               </ListItem>
          )}
        </List>
      </TracePanel>
      <FlowDisplayPanel>
        <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ px: 1, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, overflowX: 'auto' }}>
              {selectedFrame.parentKey && (
                <Tooltip title={t('chat.debug.backToParent')}>
                  <IconButton
                    size="small"
                    onClick={() => setSelectedFrameKey(selectedFrame.parentKey ?? DEBUGGER_ROOT_FRAME_KEY)}
                    aria-label={t('chat.debug.backToParent')}
                  >
                    <ChevronLeftIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {selectedFramePath.map((frame, index) => (
                <React.Fragment key={frame.key}>
                  {index > 0 && <ChevronRightIcon color="disabled" fontSize="small" />}
                  <Button
                    size="small"
                    variant={frame.key === selectedFrame.key ? 'contained' : 'text'}
                    onClick={() => setSelectedFrameKey(frame.key)}
                    sx={{ minWidth: 0, whiteSpace: 'nowrap', textTransform: 'none' }}
                  >
                    {frameLabel(frame)}
                  </Button>
                </React.Fragment>
              ))}
            </Box>
            {frameState.order.length > 1 && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25, overflowX: 'auto' }}>
                <Typography variant="caption" color="textSecondary" sx={{ flexShrink: 0 }}>{t('chat.debug.frames')}</Typography>
                {frameState.order.slice(1).map(key => {
                  const frame = frameState.frames[key];
                  return (
                    <Button
                      key={key}
                      size="small"
                      variant={frame.key === selectedFrame.key ? 'outlined' : 'text'}
                      color={frame.status === 'error' ? 'error' : 'inherit'}
                      onClick={() => setSelectedFrameKey(frame.key)}
                      sx={{ minWidth: 0, py: 0, whiteSpace: 'nowrap', textTransform: 'none', fontSize: '0.7rem' }}
                    >
                      {frameLabel(frame)} · {frame.status}
                    </Button>
                  );
                })}
              </Box>
            )}
          </Box>
          {childFlowNotice && (
            <Alert
              severity={selectedFlowEntry?.status === 'loading' || !selectedFlowEntry ? 'info' : 'warning'}
              sx={{ m: 1, mb: 0, py: 0, flexShrink: 0 }}
            >
              {childFlowNotice}
            </Alert>
          )}
          <Box
            sx={{
              flexGrow: 1,
              minHeight: 0,
              position: 'relative',
              // Breakpoint styling lives here (not in inline node styles) so it
              // can add a marker pseudo-element and survive the current-node /
              // live-activity borders.
              '& .react-flow__node.flujo-breakpoint': {
                outline: `3px solid ${theme.palette.error.main}`,
                outlineOffset: '2px',
                borderRadius: '8px',
                boxShadow: `0 0 0 7px ${alpha(theme.palette.error.main, 0.16)}, 0 0 14px ${alpha(theme.palette.error.main, 0.5)}`,
              },
              '& .react-flow__node.flujo-breakpoint::before': {
                content: '""',
                position: 'absolute',
                top: '-11px',
                left: '-11px',
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                backgroundColor: theme.palette.error.main,
                border: `2px solid ${theme.palette.background.paper}`,
                boxShadow: `0 0 8px ${theme.palette.error.main}`,
                zIndex: 12,
                pointerEvents: 'none',
              },
            }}
            onContextMenu={(e) => {
              // Right-click anywhere on the canvas surface (including gaps that
              // ReactFlow's own pane handler misses) opens the menu.
              if (!(e.target as HTMLElement).closest('.react-flow__node')) handlePaneContextMenu(e);
            }}
          >
            {flowLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <CircularProgress />
              </Box>
            ) : flowError ? (
              <Alert severity="error" sx={{ margin: 2 }}>{flowError}</Alert>
            ) : (
              <ReactFlowProvider>
                <ReactFlow
                  nodes={displayNodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  fitView
                  attributionPosition="bottom-right"
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  panOnDrag
                  zoomOnScroll
                  zoomOnPinch
                  zoomOnDoubleClick={false}
                  onNodeClick={(e, node) => {
                    e.preventDefault();
                    const breakpointKey = breakpointKeyForNode(node);
                    if (onToggleBreakpoint && breakpointKey) onToggleBreakpoint(breakpointKey);
                  }}
                  onNodeContextMenu={handleNodeContextMenu}
                  onPaneContextMenu={handlePaneContextMenu}
                  onEdgeClick={(e) => e.preventDefault()}
                  onPaneClick={() => {}}
                />
              </ReactFlowProvider>
            )}
            <Menu
              open={!!bpMenu}
              onClose={closeBpMenu}
              anchorReference="anchorPosition"
              anchorPosition={bpMenu ? { top: bpMenu.y, left: bpMenu.x } : undefined}
            >
              {bpMenu?.nodeLabel && (
                <MenuItem
                  onClick={() => { if (bpMenu.breakpointKey) onToggleBreakpoint?.(bpMenu.breakpointKey); closeBpMenu(); }}
                  disabled={!onToggleBreakpoint || !bpMenu.breakpointKey}
                >
                  <ListItemIcon>
                    {bpMenu.breakpointKey && activeBreakpoints.includes(bpMenu.breakpointKey) ? <RemoveCircleOutlineIcon fontSize="small" color="error" /> : <FiberManualRecordIcon fontSize="small" color={bpMenu.breakpointKey ? 'error' : 'disabled'} />}
                  </ListItemIcon>
                  <ListItemText
                    primary={bpMenu.breakpointKey && activeBreakpoints.includes(bpMenu.breakpointKey)
                      ? t('chat.debug.menu.removeBreakpoint')
                      : t('chat.debug.menu.addBreakpoint')}
                    secondary={bpMenu.unavailableReason || bpMenu.nodeLabel}
                  />
                </MenuItem>
              )}
              <MenuItem onClick={toggleToolBreakpoint} disabled={!onSetBreakpoints}>
                <ListItemIcon>
                  <BuildOutlinedIcon fontSize="small" color={toolBreakOn ? 'error' : 'inherit'} />
                </ListItemIcon>
                <ListItemText
                  primary={toolBreakOn ? t('chat.debug.menu.toolBreakpointOff') : t('chat.debug.menu.toolBreakpointOn')}
                  secondary={t('chat.debug.menu.toolBreakpointHelp')}
                />
              </MenuItem>
              <MenuItem onClick={clearAllBreakpoints} disabled={!onSetBreakpoints || activeBreakpoints.length === 0}>
                <ListItemIcon>
                  <DeleteSweepOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={t('chat.debug.menu.clearAll')} />
              </MenuItem>
            </Menu>
          </Box>
        </Box>
      </FlowDisplayPanel>
    </Box>
  );

  const detailBody = (
    <Box sx={{ flexGrow: 1, overflowY: 'auto', minHeight: 0, p: 2 }}>
      {currentStepData ? (
        <Box>
          <Typography variant="body2"><b>{t('chat.debug.node')}</b> {currentStepData.nodeName} ({currentStepData.nodeId})</Typography>
          <Typography variant="body2"><b>{t('chat.debug.type')}</b> {currentStepData.nodeType}</Typography>
          <Typography variant="body2"><b>{t('chat.debug.timestamp')}</b> {formatLocalizedDate(new Date(currentStepData.timestamp), { dateStyle: 'medium', timeStyle: 'medium' })}</Typography>
          <Typography variant="body2"><b>{t('chat.debug.actionTaken')}</b> {currentStepData.actionTaken}</Typography>

          {/* Model Input moved to the Conversation section (issue #162). The raw
              JSON accordions below remain as the power-user fallback. */}

          {/* Accordion for Prep Result */}
          <Accordion sx={{ mt: 2, boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
              <Typography variant="caption">{t('chat.debug.prepResult')}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflowY: 'auto', background: 'var(--surface-raised)', color: 'var(--foreground)', padding: '8px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                {JSON.stringify(currentStepData.prepResultSnapshot, null, 2)}
              </pre>
            </AccordionDetails>
          </Accordion>

          {/* Accordion for Exec Result with Error Handling */}
          <Accordion sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
              <Typography variant="caption" color={currentStepData.execResultSnapshot?.success === false ? 'error' : 'inherit'}>
                {currentStepData.execResultSnapshot?.success === false ? t('chat.debug.execResultError') : t('chat.debug.execResult')}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              {currentStepData.execResultSnapshot?.success === false ? (
                <Box sx={{ p: 1, background: theme.palette.error.light, borderRadius: 1 }}>
                  <Typography variant="body2" color="error" gutterBottom>
                    <b>{t('chat.debug.error')}</b> {currentStepData.execResultSnapshot.error || t('chat.debug.unknownError')}
                  </Typography>
                  {currentStepData.execResultSnapshot.errorDetails && (
                     <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '150px', overflowY: 'auto', background: 'var(--surface-raised)', color: 'var(--foreground)', padding: '4px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                       {JSON.stringify(currentStepData.execResultSnapshot.errorDetails, null, 2)}
                     </pre>
                  )}
                </Box>
              ) : (
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflowY: 'auto', background: 'var(--surface-raised)', color: 'var(--foreground)', padding: '8px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                  {JSON.stringify(currentStepData.execResultSnapshot, null, 2)}
                </pre>
              )}
            </AccordionDetails>
          </Accordion>

          {/* Accordion for State Before */}
          <Accordion sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
              <Typography variant="caption">{t('chat.debug.stateBefore')}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflowY: 'auto', background: 'var(--surface-raised)', color: 'var(--foreground)', padding: '8px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                {JSON.stringify(currentStepData.stateBefore, null, 2)}
              </pre>
            </AccordionDetails>
          </Accordion>

          {/* Accordion for State After */}
          <Accordion sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
              <Typography variant="caption">{t('chat.debug.stateAfter')}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflowY: 'auto', background: 'var(--surface-raised)', color: 'var(--foreground)', padding: '8px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                {JSON.stringify(currentStepData.stateAfter, null, 2)}
              </pre>
            </AccordionDetails>
          </Accordion>
        </Box>
      ) : (
        <Typography variant="body2" color="textSecondary">{t('chat.debug.selectStep')}</Typography>
      )}

      {/* Run data (Tier 3): the run-scoped resources captured so far —
          auto-captured tool results, captureResource outputs, links.
          Refetches whenever a resource:write arrives (resourceVersion). */}
      <Accordion defaultExpanded sx={{ mt: 2, boxShadow: 'none', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
          <Typography variant="caption">{t('chat.debug.runData')}</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 0 }}>
          <RunResourcesPanel
            conversationId={conversationId}
            refreshToken={liveActivity?.resourceVersion}
          />
        </AccordionDetails>
      </Accordion>
    </Box>
  );

  const sectionBodies: Record<SectionKey, React.ReactNode> = {
    conversation: conversationBody,
    tracker: trackerBody,
    detail: detailBody,
  };

  // Render one section column: fixed width for conversation/detail, flexible
  // (fill remaining) for the tracker.
  const renderSection = (key: SectionKey) => {
    const isFixed = key !== 'tracker';
    const width = key === 'conversation' ? convWidth : key === 'detail' ? detailWidth : undefined;
    return (
      <Box
        key={key}
        sx={{
          ...(isFixed
            ? { width, flexShrink: 0 }
            : { flexGrow: 1, minWidth: 300 }),
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 0,
        }}
      >
        {sectionHeader(key)}
        {sectionBodies[key]}
      </Box>
    );
  };

  // A resizer between two adjacent visible sections. The fixed-width neighbour
  // is the one that gets resized; if the left neighbour is fixed it grows with
  // rightward drag (sign +1), otherwise the right (fixed) neighbour shrinks
  // with rightward drag (sign -1).
  const renderResizer = (left: SectionKey, right: SectionKey) => {
    const target: 'conversation' | 'detail' | null =
      left !== 'tracker' ? (left as 'conversation' | 'detail')
      : right !== 'tracker' ? (right as 'conversation' | 'detail')
      : null;
    if (!target) return null; // two flexible neighbours never happens (only one tracker)
    const sign: 1 | -1 = left !== 'tracker' ? 1 : -1;
    return (
      <SectionResizer
        key={`resizer-${left}-${right}`}
        onPointerDown={(e) => startResize(target, sign, e)}
        aria-label={t('chat.debug.resizeSection', { section: sectionTitles[target] })}
      />
    );
  };

  return (
    <DebuggerContainer elevation={2}>
      <Header sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h6">{t('chat.debug.title')}</Typography>
          <Typography variant="caption" color="textSecondary" display="block">
            {t('chat.debug.breakpointHelp')}
            {activeBreakpoints.length > 0 ? ` · ${tp('chat.debug.activeBreakpoints', activeBreakpoints.length)}` : ''}
          </Typography>
          {/* Legend + the breakpoints that have no node to sit on (tool
              breakpoints), so an armed tool break is never invisible. */}
          {activeBreakpoints.length > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5, flexWrap: 'wrap' }}>
              {nodeBreakpoints(activeBreakpoints).length > 0 && (
                <Chip
                  size="small"
                  variant="outlined"
                  color="error"
                  icon={<FiberManualRecordIcon />}
                  label={tp('chat.debug.nodeBreakpoints', nodeBreakpoints(activeBreakpoints).length)}
                />
              )}
              {toolBreakpointNames(activeBreakpoints).map(name => (
                <Chip
                  key={name}
                  size="small"
                  variant="outlined"
                  color="error"
                  icon={<BuildOutlinedIcon />}
                  label={name === '*' ? t('chat.debug.anyToolBreakpoint') : name}
                  onDelete={onSetBreakpoints
                    ? () => onSetBreakpoints(activeBreakpoints.filter(b => b !== `tool:${name}`))
                    : undefined}
                />
              ))}
              {toolNodeBreakpointIds(activeBreakpoints).map(nodeId => (
                <Chip
                  key={`tool-node:${nodeId}`}
                  size="small"
                  variant="outlined"
                  color="error"
                  icon={<BuildOutlinedIcon />}
                  label={t('chat.debug.toolNodeBreakpoint', { id: nodeId.slice(0, 8) })}
                  onDelete={onSetBreakpoints
                    ? () => onSetBreakpoints(activeBreakpoints.filter(b => b !== `${TOOL_NODE_BREAKPOINT_PREFIX}${nodeId}`))
                    : undefined}
                />
              ))}
            </Box>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {/* Section visibility toggles */}
          <Tooltip title={visible.conversation ? t('chat.debug.hideSection', { section: sectionTitles.conversation }) : t('chat.debug.showSection', { section: sectionTitles.conversation })}>
            <IconButton
              size="small"
              onClick={() => toggleSection('conversation')}
              color={visible.conversation ? 'primary' : 'default'}
              aria-label={visible.conversation ? t('chat.debug.hideSection', { section: sectionTitles.conversation }) : t('chat.debug.showSection', { section: sectionTitles.conversation })}
            >
              <ForumOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={visible.tracker ? t('chat.debug.hideSection', { section: sectionTitles.tracker }) : t('chat.debug.showSection', { section: sectionTitles.tracker })}>
            <IconButton
              size="small"
              onClick={() => toggleSection('tracker')}
              color={visible.tracker ? 'primary' : 'default'}
              aria-label={visible.tracker ? t('chat.debug.hideSection', { section: sectionTitles.tracker }) : t('chat.debug.showSection', { section: sectionTitles.tracker })}
            >
              <AccountTreeOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={visible.detail ? t('chat.debug.hideSection', { section: sectionTitles.detail }) : t('chat.debug.showSection', { section: sectionTitles.detail })}>
            <IconButton
              size="small"
              onClick={() => toggleSection('detail')}
              color={visible.detail ? 'primary' : 'default'}
              aria-label={visible.detail ? t('chat.debug.hideSection', { section: sectionTitles.detail }) : t('chat.debug.showSection', { section: sectionTitles.detail })}
            >
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {onToggleExpand && (
            <Tooltip title={isExpanded ? t('chat.debug.exitFullscreen') : t('chat.debug.enterFullscreen')}>
              <IconButton size="small" onClick={onToggleExpand} aria-label={isExpanded ? t('chat.debug.exitFullscreen') : t('chat.debug.enterFullscreen')}>
                {isExpanded ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
          {onClose && (
            <Tooltip title={t('chat.debug.close')}>
              <IconButton size="small" onClick={onClose} aria-label={t('chat.debug.close')}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Header>
      <ContentArea>
        {visibleOrder.length === 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', p: 3 }}>
            <Typography variant="body2" color="textSecondary">
              {t('chat.debug.allHidden')}
            </Typography>
          </Box>
        ) : (
          visibleOrder.map((key, idx) => (
            <React.Fragment key={key}>
              {renderSection(key)}
              {idx < visibleOrder.length - 1 && renderResizer(key, visibleOrder[idx + 1])}
            </React.Fragment>
          ))
        )}
      </ContentArea>
       <ControlsPanel>
            <Button variant="outlined" size="small" onClick={handlePreviousStep} disabled={isLoading || currentStepIndex <= 0}>
                {t('chat.debug.previous')}
            </Button>
            <Button variant="contained" size="small" onClick={handleNextStep} disabled={isLoading || currentStepIndex === -1}>
                {/* Adjust button text based on whether we are at the end of the current trace */}
                {debugState.executionTrace && currentStepIndex < debugState.executionTrace.length - 1 ? t('chat.debug.nextTrace') : t('chat.debug.stepNext')}
            </Button>
            {onStepOver && (
              <Button variant="outlined" size="small" onClick={onStepOver} disabled={isLoading}>
                {t('chat.debug.stepOver')}
              </Button>
            )}
            <Button variant="contained" color="secondary" size="small" onClick={onContinue} disabled={isLoading}>
                {t('chat.debug.continue')}
            </Button>
            <Button variant="outlined" color="error" size="small" onClick={onCancel} disabled={isLoading}>{t('chat.debug.stop')}</Button>
       </ControlsPanel>
    </DebuggerContainer>
  );
};

export default DebuggerCanvas;
