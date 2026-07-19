"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Box, Typography, List, ListItem, ListItemButton, ListItemText, Button, Paper, CircularProgress, Alert,
    Accordion, AccordionSummary, AccordionDetails, // Import Accordion components
    IconButton, Tooltip
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
import { styled, useTheme } from '@mui/material/styles';
import { ReactFlow, useNodesState, useEdgesState, Node, Edge, ReactFlowProvider } from '@xyflow/react'; // Import ReactFlow components
import { SharedState, DebugStep } from '@/backend/execution/flow/types'; // Import backend types
import { Flow } from '@/shared/types/flow'; // Import shared Flow type
import { flowService } from '@/frontend/services/flow'; // Import flow service
import { createLogger } from '@/utils/logger';

// Import custom nodes and edges if needed for display (might need adaptation for read-only)
import { StartNode, ProcessNode, FinishNode, MCPNode, SubflowNode, ResourceNode } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';
import { CustomEdge, MCPEdge, ResourceEdge } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges';
import { LiveActivity, LIVE_HIGHLIGHT_TTL_MS, resourceActivityKey } from '@/utils/shared/liveActivity';
import RunResourcesPanel from './RunResourcesPanel';
import DebuggerConversation from './DebuggerConversation';

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
  breakpoints?: string[]; // Node IDs with active breakpoints
  onToggleBreakpoint?: (nodeId: string) => void; // Toggle a breakpoint on node click
  onClose?: () => void; // Callback to dismiss/hide the debugger panel
  /** Whether the debugger is currently shown in the large (modal) layout. */
  isExpanded?: boolean;
  /** Toggle between the docked side panel and the large modal layout. */
  onToggleExpand?: () => void;
  /** Live node/resource activity from the SSE stream (Tier 3): highlights the
   *  node currently executing and the artifacts being read/written, fading
   *  over LIVE_HIGHLIGHT_TTL_MS. Absent ⇒ trace-driven highlighting only. */
  liveActivity?: LiveActivity;
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

// --- Debugger layout (issue #162) ---------------------------------------------
// The debugger is split into three top-level sections — Conversation,
// Execution Tracker + Canvas, and Detail — each of which can be hidden,
// reordered (moved left/right), and (for the side sections) resized. The chosen
// visibility / order / widths persist in localStorage so the layout survives
// reloads, consistent with how the docked panel width is handled in Chat/index.
type SectionKey = 'conversation' | 'tracker' | 'detail';
const SECTION_KEYS: SectionKey[] = ['conversation', 'tracker', 'detail'];
const SECTION_TITLES: Record<SectionKey, string> = {
  conversation: 'Conversation',
  tracker: 'Execution Tracker',
  detail: 'Detail',
};
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
  onClose,
  isExpanded,
  onToggleExpand,
  liveActivity,
}) => {
  const theme = useTheme();
  // Initialize step index safely, defaulting to -1 if no trace
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(
    debugState.executionTrace && debugState.executionTrace.length > 0 ? debugState.executionTrace.length - 1 : -1
  );

  // --- Section layout state (issue #162) ---
  const [order, setOrder] = useState<SectionKey[]>(() => readOrder());
  const [visible, setVisible] = useState<Record<SectionKey, boolean>>(() => readVisible());
  const [convWidth, setConvWidth] = useState<number>(() => readWidth(LS_CONV_WIDTH, CONV_WIDTH_DEFAULT));
  const [detailWidth, setDetailWidth] = useState<number>(() => readWidth(LS_DETAIL_WIDTH, DETAIL_WIDTH_DEFAULT));

  const [flowDefinition, setFlowDefinition] = useState<Flow | null>(null);
  const [flowLoading, setFlowLoading] = useState<boolean>(true);
  const [flowError, setFlowError] = useState<string | null>(null);

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

  // Load flow definition when component mounts or flowId changes
  useEffect(() => {
    const loadFlow = async () => {
      if (!debugState.flowId) {
        setFlowError("Flow ID is missing in debug state.");
        setFlowLoading(false);
        return;
      }
      setFlowLoading(true);
      setFlowError(null);
      try {
        log.debug(`Loading flow definition for ID: ${debugState.flowId}`);
        const flow = await flowService.getFlow(debugState.flowId);
        if (!flow) {
          throw new Error(`Flow with ID ${debugState.flowId} not found.`);
        }
        setFlowDefinition(flow);
        log.info(`Flow definition loaded: ${flow.name}`);
      } catch (err) {
        log.error("Error loading flow definition:", err);
        setFlowError(err instanceof Error ? err.message : "Failed to load flow definition.");
        setFlowDefinition(null);
      } finally {
        setFlowLoading(false);
      }
    };
    loadFlow();
  }, [debugState.flowId]);

  // Initialize/Update React Flow nodes and edges when flowDefinition loads
  useEffect(() => {
    if (flowDefinition) {
      log.debug("Setting nodes and edges from flow definition");
      // Ensure nodes are not draggable or selectable, etc.
      const initialNodes = flowDefinition.nodes.map(node => ({
        ...node,
        draggable: false,
        selectable: false,
        connectable: false,
        // focusable: false, // Might cause issues with highlighting
      }));
      const initialEdges = flowDefinition.edges.map(edge => ({
        ...edge,
        selectable: false,
        // focusable: false,
      }));
      setNodes(initialNodes);
      setEdges(initialEdges);
    }
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

  // Decay repaint (Tier 3 live highlighting): while any live-activity entry is
  // younger than the TTL, a low-frequency interval bumps `now` so highlights
  // fade out; it self-stops once everything has aged out.
  const [now, setNow] = useState<number>(() => Date.now());
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
    if (!liveActivity) return null;
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
  }, [liveActivity, now]);

  // Derived nodes for display: highlight the inspected step's node (warning),
  // live activity (primary/teal, fading by age), and breakpoint nodes (error).
  // Precedence: debug step > live activity > breakpoint. Computed, not
  // stateful, to avoid render loops.
  const displayNodes = useMemo(() => {
    const highlightId = currentStepData?.nodeId;
    return nodes.map((node: Node) => {
      const isCurrent = node.id === highlightId;
      const isBreakpoint = breakpoints?.includes(node.id);
      const live = isCurrent ? null : liveActivityFor(node);
      const liveOpacity = live ? Math.max(0.25, 1 - (now - live.ts) / LIVE_HIGHLIGHT_TTL_MS) : 0;
      const liveColor = live?.kind === 'active' ? theme.palette.primary.main : RESOURCE_HIGHLIGHT;
      return {
        ...node,
        style: {
          ...node.style,
          border: isCurrent
            ? `2px solid ${theme.palette.warning.main}`
            : live
              ? `2px solid ${liveColor}`
              : isBreakpoint
                ? `2px dashed ${theme.palette.error.main}`
                : (node.style?.border as string | undefined),
          boxShadow: isCurrent
            ? `0 0 10px ${theme.palette.warning.light}`
            : live
              ? `0 0 ${live.kind === 'resource-write' ? 14 : 10}px ${liveColor}${Math.round(liveOpacity * 255).toString(16).padStart(2, '0')}`
              : undefined,
        },
      };
    });
  }, [nodes, currentStepData, breakpoints, theme, liveActivityFor, now]);

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
        <Typography variant="subtitle2" noWrap>{SECTION_TITLES[key]}</Typography>
        <Box sx={{ display: 'flex' }}>
          <Tooltip title="Move left">
            <span>
              <IconButton size="small" onClick={() => moveSection(key, -1)} disabled={idx <= 0} aria-label={`Move ${SECTION_TITLES[key]} left`}>
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Move right">
            <span>
              <IconButton size="small" onClick={() => moveSection(key, 1)} disabled={idx < 0 || idx >= visibleOrder.length - 1} aria-label={`Move ${SECTION_TITLES[key]} right`}>
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Hide section">
            <IconButton size="small" onClick={() => toggleSection(key)} aria-label={`Hide ${SECTION_TITLES[key]}`}>
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
        currentStepData.modelInput ? (
          <DebuggerConversation modelInput={currentStepData.modelInput} conversationId={conversationId} />
        ) : (
          <Typography variant="body2" color="textSecondary" sx={{ p: 2 }}>
            No model call for this step.
          </Typography>
        )
      ) : (
        <Typography variant="body2" color="textSecondary" sx={{ p: 2 }}>
          Select a step from the execution tracker.
        </Typography>
      )}
    </Box>
  );

  const trackerBody = (
    <Box sx={{ flexGrow: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
      <TracePanel>
        <Typography variant="caption" color="textSecondary" gutterBottom sx={{ display: 'block' }}>Execution Trace</Typography>
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
        {flowLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <CircularProgress />
          </Box>
        ) : flowError ? (
          <Alert severity="error" sx={{ margin: 2 }}>{flowError}</Alert>
        ) : (
          <ReactFlowProvider> {/* Needed for useReactFlow hook if used by controls */}
            <ReactFlow
              nodes={displayNodes}
              edges={edges}
              onNodesChange={onNodesChange} // Required, even if read-only
              onEdgesChange={onEdgesChange} // Required, even if read-only
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              attributionPosition="bottom-right"
              // Disable interactions
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag={true} // Allow panning
              zoomOnScroll={true} // Allow zooming
              zoomOnPinch={true}
              zoomOnDoubleClick={false}
              // Click a node to toggle a breakpoint on it
              onNodeClick={(e, node) => {
                e.preventDefault();
                if (onToggleBreakpoint) onToggleBreakpoint(node.id);
              }}
              onEdgeClick={(e) => e.preventDefault()}
              onPaneClick={() => {}} // No action on pane click
            >
              {/* <CanvasControls /> */} {/* Add controls if needed */}
            </ReactFlow>
          </ReactFlowProvider>
        )}
      </FlowDisplayPanel>
    </Box>
  );

  const detailBody = (
    <Box sx={{ flexGrow: 1, overflowY: 'auto', minHeight: 0, p: 2 }}>
      {currentStepData ? (
        <Box>
          <Typography variant="body2"><b>Node:</b> {currentStepData.nodeName} ({currentStepData.nodeId})</Typography>
          <Typography variant="body2"><b>Type:</b> {currentStepData.nodeType}</Typography>
          <Typography variant="body2"><b>Timestamp:</b> {new Date(currentStepData.timestamp).toLocaleString()}</Typography>
          <Typography variant="body2"><b>Action Taken:</b> {currentStepData.actionTaken}</Typography>

          {/* Model Input moved to the Conversation section (issue #162). The raw
              JSON accordions below remain as the power-user fallback. */}

          {/* Accordion for Prep Result */}
          <Accordion sx={{ mt: 2, boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
              <Typography variant="caption">Prep Result</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflowY: 'auto', background: '#f5f5f5', padding: '8px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                {JSON.stringify(currentStepData.prepResultSnapshot, null, 2)}
              </pre>
            </AccordionDetails>
          </Accordion>

          {/* Accordion for Exec Result with Error Handling */}
          <Accordion sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
              <Typography variant="caption" color={currentStepData.execResultSnapshot?.success === false ? 'error' : 'inherit'}>
                Exec Result {currentStepData.execResultSnapshot?.success === false ? '(Error)' : ''}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              {currentStepData.execResultSnapshot?.success === false ? (
                <Box sx={{ p: 1, background: theme.palette.error.light, borderRadius: 1 }}>
                  <Typography variant="body2" color="error" gutterBottom>
                    <b>Error:</b> {currentStepData.execResultSnapshot.error || 'Unknown error'}
                  </Typography>
                  {currentStepData.execResultSnapshot.errorDetails && (
                     <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '150px', overflowY: 'auto', background: '#f5f5f5', padding: '4px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                       {JSON.stringify(currentStepData.execResultSnapshot.errorDetails, null, 2)}
                     </pre>
                  )}
                </Box>
              ) : (
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflowY: 'auto', background: '#f5f5f5', padding: '8px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                  {JSON.stringify(currentStepData.execResultSnapshot, null, 2)}
                </pre>
              )}
            </AccordionDetails>
          </Accordion>

          {/* Accordion for State Before */}
          <Accordion sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
              <Typography variant="caption">State Before</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflowY: 'auto', background: '#f5f5f5', padding: '8px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                {JSON.stringify(currentStepData.stateBefore, null, 2)}
              </pre>
            </AccordionDetails>
          </Accordion>

          {/* Accordion for State After */}
          <Accordion sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
              <Typography variant="caption">State After</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflowY: 'auto', background: '#f5f5f5', padding: '8px', borderRadius: '4px', fontSize: '0.75rem', margin: 0 }}>
                {JSON.stringify(currentStepData.stateAfter, null, 2)}
              </pre>
            </AccordionDetails>
          </Accordion>
        </Box>
      ) : (
        <Typography variant="body2" color="textSecondary">Select a step from the execution tracker.</Typography>
      )}

      {/* Run data (Tier 3): the run-scoped resources captured so far —
          auto-captured tool results, captureResource outputs, links.
          Refetches whenever a resource:write arrives (resourceVersion). */}
      <Accordion defaultExpanded sx={{ mt: 2, boxShadow: 'none', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
          <Typography variant="caption">Run Data</Typography>
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
        aria-label={`Resize ${SECTION_TITLES[target]} section`}
      />
    );
  };

  return (
    <DebuggerContainer elevation={2}>
      <Header sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h6">Flow Debugger</Typography>
          <Typography variant="caption" color="textSecondary" display="block">
            Click a node to toggle a breakpoint
            {breakpoints && breakpoints.length > 0 ? ` · ${breakpoints.length} active` : ''}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {/* Section visibility toggles */}
          <Tooltip title={visible.conversation ? 'Hide Conversation' : 'Show Conversation'}>
            <IconButton
              size="small"
              onClick={() => toggleSection('conversation')}
              color={visible.conversation ? 'primary' : 'default'}
              aria-label={visible.conversation ? 'Hide Conversation' : 'Show Conversation'}
            >
              <ForumOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={visible.tracker ? 'Hide Execution Tracker' : 'Show Execution Tracker'}>
            <IconButton
              size="small"
              onClick={() => toggleSection('tracker')}
              color={visible.tracker ? 'primary' : 'default'}
              aria-label={visible.tracker ? 'Hide Execution Tracker' : 'Show Execution Tracker'}
            >
              <AccountTreeOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={visible.detail ? 'Hide Detail' : 'Show Detail'}>
            <IconButton
              size="small"
              onClick={() => toggleSection('detail')}
              color={visible.detail ? 'primary' : 'default'}
              aria-label={visible.detail ? 'Hide Detail' : 'Show Detail'}
            >
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {onToggleExpand && (
            <Tooltip title={isExpanded ? 'Exit full screen' : 'Expand to full screen'}>
              <IconButton size="small" onClick={onToggleExpand} aria-label={isExpanded ? 'Exit full screen' : 'Expand to full screen'}>
                {isExpanded ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
          {onClose && (
            <Tooltip title="Close debugger">
              <IconButton size="small" onClick={onClose} aria-label="Close debugger">
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
              All sections are hidden — use the toolbar toggles above to show a section.
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
                Previous
            </Button>
            <Button variant="contained" size="small" onClick={handleNextStep} disabled={isLoading || currentStepIndex === -1}>
                {/* Adjust button text based on whether we are at the end of the current trace */}
                {debugState.executionTrace && currentStepIndex < debugState.executionTrace.length - 1 ? 'Next Trace Step' : 'Step Next'}
            </Button>
            {onStepOver && (
              <Button variant="outlined" size="small" onClick={onStepOver} disabled={isLoading}>
                Step Over
              </Button>
            )}
            <Button variant="contained" color="secondary" size="small" onClick={onContinue} disabled={isLoading}>
                Continue
            </Button>
            <Button variant="outlined" color="error" size="small" onClick={onCancel} disabled={isLoading}>Stop</Button>
       </ControlsPanel>
    </DebuggerContainer>
  );
};

export default DebuggerCanvas;
