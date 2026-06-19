"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Box, Typography, List, ListItem, ListItemButton, ListItemText, Button, Paper, CircularProgress, Alert,
    Accordion, AccordionSummary, AccordionDetails, // Import Accordion components
    IconButton, Tooltip
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'; // Import icon for Accordion
import CloseIcon from '@mui/icons-material/Close';
import { styled, useTheme } from '@mui/material/styles';
import { ReactFlow, useNodesState, useEdgesState, Node, Edge, ReactFlowProvider } from '@xyflow/react'; // Import ReactFlow components
import { SharedState, DebugStep } from '@/backend/execution/flow/types'; // Import backend types
import { Flow } from '@/shared/types/flow'; // Import shared Flow type
import { flowService } from '@/frontend/services/flow'; // Import flow service
import { createLogger } from '@/utils/logger';

// Import custom nodes and edges if needed for display (might need adaptation for read-only)
import { StartNode, ProcessNode, FinishNode, MCPNode } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';
import { CustomEdge, MCPEdge } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges';

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
}

// Define node types for React Flow display
const nodeTypes = {
  start: StartNode,
  process: ProcessNode,
  finish: FinishNode,
  mcp: MCPNode,
};

// Define edge types
const edgeTypes = {
  custom: CustomEdge,
  mcpEdge: MCPEdge,
};

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
});

const TracePanel = styled(Box)(({ theme }) => ({
  width: '200px', // Fixed width for trace list
  borderRight: `1px solid ${theme.palette.divider}`,
  overflowY: 'auto',
  padding: theme.spacing(1),
}));

const FlowDisplayPanel = styled(Box)({
  flexGrow: 1,
  position: 'relative', // Needed for ReactFlow attribution
  height: '100%', // Ensure it takes full height
});

const InspectorPanel = styled(Box)(({ theme }) => ({
  width: '300px', // Fixed width for inspector
  borderLeft: `1px solid ${theme.palette.divider}`,
  overflowY: 'auto',
  padding: theme.spacing(2),
}));

const ControlsPanel = styled(Box)(({ theme }) => ({
    padding: theme.spacing(1, 2),
    borderTop: `1px solid ${theme.palette.divider}`,
    display: 'flex',
    gap: theme.spacing(1),
    justifyContent: 'center',
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
}) => {
  const theme = useTheme();
  // Initialize step index safely, defaulting to -1 if no trace
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(
    debugState.executionTrace && debugState.executionTrace.length > 0 ? debugState.executionTrace.length - 1 : -1
  );
  const [flowDefinition, setFlowDefinition] = useState<Flow | null>(null);
  const [flowLoading, setFlowLoading] = useState<boolean>(true);
  const [flowError, setFlowError] = useState<string | null>(null);

  // State for React Flow nodes and edges with correct explicit types
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]); // Use Node, not Node[]
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]); // Use Edge, not Edge[]

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
    setCurrentStepIndex(index);
    setCurrentStepIndex(index);
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

  // Removed duplicate handlePreviousStep definition

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

  // Derived nodes for display: highlight the inspected step's node (warning) and
  // mark breakpoint nodes (error). Computed, not stateful, to avoid render loops.
  const displayNodes = useMemo(() => {
    const highlightId = currentStepData?.nodeId;
    return nodes.map((node: Node) => {
      const isCurrent = node.id === highlightId;
      const isBreakpoint = breakpoints?.includes(node.id);
      return {
        ...node,
        style: {
          ...node.style,
          border: isCurrent
            ? `2px solid ${theme.palette.warning.main}`
            : isBreakpoint
              ? `2px dashed ${theme.palette.error.main}`
              : (node.style?.border as string | undefined),
          boxShadow: isCurrent ? `0 0 10px ${theme.palette.warning.light}` : undefined,
        },
      };
    });
  }, [nodes, currentStepData, breakpoints, theme]);

  // Removed duplicated handleNextStep definition


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
        {onClose && (
          <Tooltip title="Close debugger">
            <IconButton size="small" onClick={onClose} aria-label="Close debugger">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Header>
      <ContentArea>
        <TracePanel>
          <Typography variant="subtitle2" gutterBottom>Execution Trace</Typography>
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
        <InspectorPanel>
          <Typography variant="subtitle2" gutterBottom>Step Inspector</Typography>
          {currentStepData ? (
            <Box>
              <Typography variant="body2"><b>Node:</b> {currentStepData.nodeName} ({currentStepData.nodeId})</Typography>
              <Typography variant="body2"><b>Type:</b> {currentStepData.nodeType}</Typography>
              <Typography variant="body2"><b>Timestamp:</b> {new Date(currentStepData.timestamp).toLocaleString()}</Typography>
              <Typography variant="body2"><b>Action Taken:</b> {currentStepData.actionTaken}</Typography>

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

              {/* Accordion for Exec Result */}
              {/* Accordion for Exec Result with Error Handling */}
              <Accordion sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: '36px', '& .MuiAccordionSummary-content': { margin: '8px 0' } }}>
                  <Typography variant="caption" color={currentStepData.execResultSnapshot?.success === false ? 'error' : 'inherit'}>
                    Exec Result {currentStepData.execResultSnapshot?.success === false ? '(Error)' : ''}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  {currentStepData.execResultSnapshot?.success === false ? (
                    <Box sx={{ p: 1, background: theme.palette.error.light, borderRadius: 1 }}> {/* Changed lightest to light */}
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
            <Typography variant="body2" color="textSecondary">Select a step from the trace.</Typography>
          )}
        </InspectorPanel>
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
