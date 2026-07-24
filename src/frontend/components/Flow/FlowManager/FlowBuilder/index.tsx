"use client";

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { styled } from '@mui/material/styles';
import {
  Box,
  Button,
  ButtonGroup,
  Menu,
  MenuItem,
  TextField,
  Paper,
  Typography,
  Divider,
  IconButton,
  Tooltip,
  FormControlLabel,
  Switch,
} from '@mui/material';
import { createLogger } from '@/utils/logger';
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
  Node, 
  Edge, 
  NodeChange, 
  EdgeChange, 
  ReactFlowInstance, 
  useReactFlow,
  Panel,
  applyNodeChanges,
  applyEdgeChanges
} from '@xyflow/react';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { Flow, FlowNode, HistoryEntry } from '@/shared/types/flow';
import { flowService } from '@/frontend/services/flow';
import { mcpService } from '@/frontend/services/mcp';
import { createEdgeFromConnection } from './Canvas/utils/edgeUtils';
import { computeAutoLayout } from './Canvas/utils/autoLayout';
import { migrateHandoffPills } from './utils/handoffPillMigration';
import { Canvas } from './Canvas/index';
import { NodePalette } from './NodePalette';
import { FlowValidationButton } from './FlowValidationButton';
import ProcessNodePropertiesModal from './Modals/ProcessNodePropertiesModal';
import MCPNodePropertiesModal from './Modals/MCPNodePropertiesModal';
import StartNodePropertiesModal from './Modals/StartNodePropertiesModal';
import FinishNodePropertiesModal from './Modals/FinishNodePropertiesModal';
import EdgePropertiesModal from './Modals/EdgePropertiesModal';
import SubflowNodePropertiesModal from './Modals/SubflowNodePropertiesModal';
import ResourceNodePropertiesModal from './Modals/ResourceNodePropertiesModal';
import SignalNodePropertiesModal from './Modals/SignalNodePropertiesModal';
import FlowVersionHistoryDialog from './Modals/FlowVersionHistoryDialog';
import SaveIcon from '@mui/icons-material/Save';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import HealingIcon from '@mui/icons-material/Healing';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import HistoryIcon from '@mui/icons-material/History';
import ImproveFlowDialog, { ImprovedFlowInfo } from '../ImproveFlowDialog';
import { autoRepairFlow } from '@/utils/shared/flowAutoRepair';
import { EdgeCondition } from '@/utils/shared/edgeConditions';
import { Collapse } from '@mui/material';

/** Pre-filled instruction for AI-supported repair (mirrors the backend repairFlowWithAI). */
const AI_REPAIR_DESCRIPTION =
  "Repair this flow's wiring so it is runnable, without changing any node's prompt, model, or servers: " +
  'add a Start node if one is missing (connected to the first step), add a Finish node if one is missing ' +
  '(connected from the last step), and connect any disconnected process/subflow nodes. Read node placement ' +
  'as intent: nodes stacked top-to-bottom are sequential steps, and nodes on the same horizontal line are ' +
  'parallel branches under a shared parent above them.';

const FlowBuilderContainer = styled(Box)(({ theme }) => ({
  display: 'flex',
  height: 'calc(100vh - 64px)',
  gap: '16px',
  padding: '16px',
  backgroundColor: theme.palette.background.default,
}));

const ToolbarContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(1),
  display: 'flex',
  gap: theme.spacing(1),
  borderBottom: '1px solid',
  borderColor: theme.palette.divider,
  alignItems: 'center',
  marginBottom: theme.spacing(1),
  backgroundColor: theme.palette.background.paper,
  boxShadow: theme.shadows[1],
}));

const MainContent = styled(Box)({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  overflow: 'hidden',
});

interface FlowBuilderProps {
  initialFlow?: Flow;
  onSave: (flow: Flow) => void;
  onDelete: (flowId: string) => void;
  allFlows: Flow[];
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
type SaveResult = 'saved' | 'invalid-name' | 'rename-dialog';

export const FlowBuilder = React.forwardRef<FlowBuilderHandle, FlowBuilderProps>(({ initialFlow, onSave, onDelete, allFlows }, ref) => {
  log.debug('FlowBuilder rendered with initialFlow:', initialFlow);

  const [nodes, setNodes] = useState<FlowNode[]>(initialFlow?.nodes || []);
  // Initialize with the *filtered* edges (same rule the init effect applies)
  // so the very first render already matches what history is seeded with —
  // otherwise an unfiltered→filtered diff could itself mark the flow dirty.
  const [edges, setEdges] = useState<Edge[]>(
    (initialFlow?.edges || []).filter(
      edge => edge.source && edge.target && edge.sourceHandle && edge.targetHandle
    )
  );
  const [flowName, setFlowName] = useState<string>(initialFlow?.name || 'NewFlow');
  const [flowNameError, setFlowNameError] = useState<string | null>(null);
  // Optional free-text description shown on the Flow Card (#70).
  const [flowDescription, setFlowDescription] = useState<string>(initialFlow?.description || '');
  // Unattended execution (#218): when ON, a Process node that stops on plain
  // text is driven forward to its single next step instead of silently ending
  // the run. `undefined` = follow the source default (scheduled ON, chat OFF).
  const [flowUnattended, setFlowUnattended] = useState<boolean>(initialFlow?.unattended ?? false);

  // Dialog states
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [dialogType, setDialogType] = useState<DialogType>('none');
  const [newFlowName, setNewFlowName] = useState<string>('');
  const [newFlowNameError, setNewFlowNameError] = useState<string | null>(null);
  
  // Modal states
  const [processModalOpen, setProcessModalOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [finishModalOpen, setFinishModalOpen] = useState(false);
  const [subflowModalOpen, setSubflowModalOpen] = useState(false);
  const [resourceModalOpen, setResourceModalOpen] = useState(false);
  const [signalModalOpen, setSignalModalOpen] = useState(false);
  const [nodeToEdit, setNodeToEdit] = useState<FlowNode | null>(null);
  // The edge whose properties (Tier 2b routing condition) are being edited.
  const [editingEdge, setEditingEdge] = useState<Edge | null>(null);

  // AI-Improve (issue #99): the dialog that revises the current flow, plus a transient
  // notice summarizing the last improvement (validation counts / installed servers).
  const [improveDialogOpen, setImproveDialogOpen] = useState(false);
  const [improveNotice, setImproveNotice] = useState<
    { severity: 'success' | 'info' | 'warning'; message: string } | null
  >(null);
  // Auto-repair: the dropdown menu anchor, and the description the AI-Improve dialog is
  // pre-seeded with when the user chooses "Repair with AI".
  const [repairMenuAnchor, setRepairMenuAnchor] = useState<null | HTMLElement>(null);
  const [improveInitialDescription, setImproveInitialDescription] = useState('');

  // Version history: browse/preview/restore archived versions of a saved flow.
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  
  // History for undo/redo functionality
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isHistoryAction, setIsHistoryAction] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
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
  
  // Filter out invalid edges (missing source/target handles)
  const filterInvalidEdges = useCallback((edges: Edge[]): Edge[] => {
    return edges.filter(edge => 
      edge.source && 
      edge.target && 
      edge.sourceHandle && 
      edge.targetHandle
    );
  }, []);

  // Initialize history with initial state
  useEffect(() => {
    // Re-arm the initialization guard so the state updates this effect makes
    // (nodes/edges/history) don't register as a user edit in the
    // history-tracking effect below.
    isInitializingRef.current = true;
    if (initialFlow) {
      setNodes(initialFlow.nodes || []);
      
      // Filter out invalid edges before setting them
      const validEdges = filterInvalidEdges(initialFlow.edges || []);
      if (validEdges.length !== initialFlow.edges.length) {
        console.warn(`Filtered out ${initialFlow.edges.length - validEdges.length} invalid edges`);
      }
      setEdges(validEdges);
      setFlowName(initialFlow.name);
      setFlowDescription(initialFlow.description || '');
      setFlowUnattended(initialFlow.unattended ?? false);

      // Initialize history with initial state
      const initialState: HistoryEntry = {
        nodes: initialFlow.nodes || [],
        edges: validEdges
      };
      setHistory([initialState]);
      setHistoryIndex(0);
    } else {
      // Create a new flow with a Start node
      const startNode = flowService.createStartNode();

      setNodes([startNode]);
      setEdges([]);
      setFlowName('NewFlow');
      setFlowDescription('');
      setFlowUnattended(false);

      // Initialize history with the Start node
      const emptyState: HistoryEntry = {
        nodes: [startNode],
        edges: []
      };
      setHistory([emptyState]);
      setHistoryIndex(0);
    }
  }, [initialFlow]);
  
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
      return "Flow name cannot be empty";
    }
    
    // Check if name contains only allowed characters (alphanumeric, underscores, dashes)
    if (!/^[\w-]+$/.test(name)) {
      return "Flow name can only contain letters, numbers, underscores, and dashes";
    }
    
    // Check for duplicate names (only if it's a new flow or the name has changed)
    if (!initialFlow || (initialFlow && initialFlow.name !== name)) {
      const isDuplicate = allFlows.some(flow => 
        flow.id !== (initialFlow?.id || '') && 
        flow.name.toLowerCase() === name.toLowerCase()
      );
      
      if (isDuplicate) {
        return "A flow with this name already exists";
      }
    }
    
    return null;
  };

  // Handle flow name change
  const handleFlowNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setFlowName(newName);
    setFlowNameError(validateFlowName(newName));
  };

  // Handle flow description change. The history-tracking effect only watches
  // nodes/edges, so a description edit must flag unsaved changes explicitly so
  // the navigate-away guard still offers Save/Discard.
  const handleFlowDescriptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFlowDescription(e.target.value);
    setHasUnsavedChanges(true);
  };

  // Handle unattended toggle (#218). Like the description, it isn't tracked by
  // the nodes/edges history effect, so flag unsaved changes explicitly.
  const handleFlowUnattendedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFlowUnattended(e.target.checked);
    setHasUnsavedChanges(true);
  };

  // Handle save flow
  const handleSave = useCallback((): SaveResult => {
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
    
    // Check if we're trying to save with a new name for an existing flow
    if (initialFlow && initialFlow.name !== flowName) {
      log.debug(`handleSave: Flow name changed from "${initialFlow.name}" to "${flowName}", opening rename dialog`);
      // Ask if user wants to rename or copy
      setDialogType('rename');
      setNewFlowName(flowName);
      setDialogOpen(true);
      return 'rename-dialog';
    }

    const flow: Flow = {
      id: initialFlow?.id || uuidv4(),
      name: flowName,
      description: flowDescription,
      unattended: flowUnattended,
      nodes: flowNodes,
      edges,
      folder: initialFlow?.folder,    // Preserve folder assignment
      favorite: initialFlow?.favorite, // Preserve favorite status
    };

    log.info(`handleSave: Saving flow "${flowName}" with ${flowNodes.length} nodes and ${edges.length} edges`);
    onSave(flow);
    setHasUnsavedChanges(false);
    return 'saved';
  }, [flowName, flowDescription, flowUnattended, nodes, edges, initialFlow, onSave, allFlows]);

  // Navigation guard: the parent must route "leave the builder" actions
  // (back to dashboard, switching flows) through here so unsaved changes get
  // a Save/Discard dialog instead of being silently dropped.
  React.useImperativeHandle(ref, () => ({
    requestNavigation: (navigate: () => void) => {
      if (hasUnsavedChanges) {
        pendingNavigationRef.current = navigate;
        setDialogType('unsaved');
        setDialogOpen(true);
      } else {
        navigate();
      }
    },
  }), [hasUnsavedChanges]);

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
      ? ` Installed MCP server(s): ${freshInstalls.map((s) => s.name).join(', ')}.`
      : '';
    if (info.errorCount > 0) {
      setImproveNotice({
        severity: 'warning',
        message: `Flow revised with ${info.errorCount} error(s) and ${info.warningCount} warning(s) — use the Check button, fix, then Save.${installNote}`,
      });
    } else if (info.warningCount > 0) {
      setImproveNotice({
        severity: 'info',
        message: `Flow revised with ${info.warningCount} warning(s) — review the changes, then Save to keep them.${installNote}`,
      });
    } else {
      setImproveNotice({
        severity: 'success',
        message: `Flow revised — review the changes (Undo reverts them), then Save to keep them.${installNote}`,
      });
    }
  }, [filterInvalidEdges]);

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
    setFlowUnattended(restored.unattended ?? false);
    setFlowNameError(validateFlowName(restored.name));
    setHasUnsavedChanges(true);
    setImproveNotice({
      severity: 'info',
      message: 'Restored an earlier version to the canvas — review it (Undo reverts), then Save to keep it.',
    });
  }, [filterInvalidEdges]);

  // Static auto-repair: deterministically add a missing Start/Finish and connect
  // disconnected nodes, reading the current canvas layout as intent (vertical = sequential,
  // same row = parallel). Runs entirely client-side (no model), applied as an unsaved,
  // undoable change just like AI-Improve. No-op flows report "nothing to repair".
  const handleRepairStatic = useCallback(() => {
    setRepairMenuAnchor(null);
    const currentFlow: Flow = {
      id: initialFlow?.id || '',
      name: flowName,
      description: flowDescription,
      unattended: flowUnattended,
      nodes,
      edges,
      folder: initialFlow?.folder,
      favorite: initialFlow?.favorite,
    };
    const { flow: repaired, changes } = autoRepairFlow(currentFlow);
    if (changes.length === 0) {
      setImproveNotice({ severity: 'info', message: 'Nothing to repair — the flow is already wired up.' });
      return;
    }
    log.info(`Applying static auto-repair to the canvas (${changes.length} change(s))`);
    setNodes(repaired.nodes || []);
    setEdges(filterInvalidEdges(repaired.edges || []));
    setHasUnsavedChanges(true);
    const added = changes.filter((c) => c.code === 'auto-added-start' || c.code === 'auto-added-finish').length;
    const wired = changes.length - added;
    const parts: string[] = [];
    if (changes.some((c) => c.code === 'auto-added-start')) parts.push('added a Start node');
    if (changes.some((c) => c.code === 'auto-added-finish')) parts.push('added a Finish node');
    if (wired > 0) parts.push(`connected ${wired} step(s)`);
    setImproveNotice({
      severity: 'success',
      message: `Repaired the flow — ${parts.join(', ')}. Review the changes (Undo reverts them), then Save to keep them.`,
    });
  }, [initialFlow, flowName, flowDescription, nodes, edges, filterInvalidEdges]);

  // AI-supported repair: pre-seed the AI-Improve dialog with the repair instruction and open
  // it, so model selection / install opt-in / result handling are all reused.
  const handleRepairWithAI = useCallback(() => {
    setRepairMenuAnchor(null);
    setImproveInitialDescription(AI_REPAIR_DESCRIPTION);
    setImproveDialogOpen(true);
  }, []);

  // Handle copy flow
  const handleCopyFlow = useCallback((flowToCopy: Flow, newName: string) => {
    log.debug(`handleCopyFlow: Copying flow "${flowToCopy.name}" to "${newName}"`);
    
    // Create a new flow with the same nodes and edges but a new ID and name
    const newFlow: Flow = {
      id: uuidv4(), // Generate a new ID
      name: newName,
      description: flowToCopy.description,
      unattended: flowToCopy.unattended,
      nodes: flowToCopy.nodes,
      edges: flowToCopy.edges,
      folder: flowToCopy.folder,    // Preserve folder assignment
      favorite: flowToCopy.favorite, // Preserve favorite status
    };
    
    log.info(`handleCopyFlow: Created copy of flow "${flowToCopy.name}" with new name "${newName}" (${flowToCopy.nodes.length} nodes, ${flowToCopy.edges.length} edges)`);
    onSave(newFlow);
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
  const handleDialogConfirm = () => {
    // Validate new flow name
    const error = validateFlowName(newFlowName);
    if (error) {
      setNewFlowNameError(error);
      return;
    }

    if (dialogType === 'duplicate') {
      // Copy the flow with a new name
      if (initialFlow) {
        handleCopyFlow(initialFlow, newFlowName);
      }
    } else if (dialogType === 'rename') {
      // Save the flow with the new name
      const flow: Flow = {
        id: initialFlow?.id || uuidv4(),
        name: newFlowName,
        description: flowDescription,
        unattended: flowUnattended,
        nodes,
        edges,
        folder: initialFlow?.folder,
        favorite: initialFlow?.favorite,
      };
      onSave(flow);
      setHasUnsavedChanges(false);
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
  const handleSaveAndContinue = () => {
    const result = handleSave();
    if (result === 'saved') {
      runPendingNavigation();
      handleDialogClose();
    } else if (result === 'invalid-name') {
      // Nothing saved; keep the user in the builder so they can fix the
      // name (the error is shown on the flow-name field).
      handleDialogClose();
    }
    // 'rename-dialog': handleSave switched this dialog to the rename flow;
    // keep the deferred navigation so it continues after a successful rename.
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
      log.info(`handleUndo: Restored flow state to previous version (${prevState.nodes.length} nodes, ${prevState.edges.length} edges)`);
    }
  }, [history, historyIndex, canUndo]);
  
  const handleRedo = useCallback(() => {
    if (canRedo) {
      log.debug(`handleRedo: Performing redo operation, moving from history index ${historyIndex} to ${historyIndex + 1}`);
      setIsHistoryAction(true);
      const newIndex = historyIndex + 1;
      const nextState = history[newIndex];
      setNodes(nextState.nodes);
      setEdges(nextState.edges);
      setHistoryIndex(newIndex);
      log.info(`handleRedo: Restored flow state to next version (${nextState.nodes.length} nodes, ${nextState.edges.length} edges)`);
    }
  }, [history, historyIndex, canRedo]);

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

  // Auto-Align (issue #100): re-arrange nodes into a clean top-to-bottom
  // layered layout. Uses the functional setNodes so it stacks on the latest
  // state; because positions change outside a drag gesture, the history effect
  // records it as a single undoable step and flags the flow unsaved. Nothing
  // is persisted until the user hits Save. fitView re-frames after the new
  // positions are applied.
  const handleAutoAlign = useCallback(() => {
    log.debug('handleAutoAlign: auto-arranging flow nodes');
    setNodes(prev => computeAutoLayout(prev, edges));
    requestAnimationFrame(() => reactFlowInstance?.fitView({ padding: 0.2 }));
  }, [edges, reactFlowInstance]);

  const handleNodeUpdate = useCallback((nodeId: string, data: any) => {
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
    
    // Close any open modals
    setProcessModalOpen(false);
    setMcpModalOpen(false);
    setStartModalOpen(false);
    setFinishModalOpen(false);
    setSubflowModalOpen(false);
    setResourceModalOpen(false);
    setSignalModalOpen(false);
    setNodeToEdit(null);
    log.debug(`handleNodeUpdate: Closed property modals`);
  }, [edges]);
  
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

  // Open the appropriate properties modal based on node type
  const openNodeProperties = useCallback((node: FlowNode) => {
    log.debug('Opening properties for node:', node);
    setNodeToEdit(node);

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
    } else {
      setProcessModalOpen(true);
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
      const newNode = flowService.createNode(type, position);
      log.info(`onDrop: Created new ${type} node with ID: ${newNode.id}`);
      
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
      
      // Automatically open the edit properties modal for the new node
      openNodeProperties(newNode);
      log.debug(`onDrop: Opened properties modal for new node: ${newNode.id}`);
    },
    [reactFlowInstance, openNodeProperties]
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // We don't need to log every dragover event as it would be too verbose
  }, []);

  const onInit = useCallback((instance: any) => {
    log.debug('onInit: ReactFlow instance initialized');
    setReactFlowInstance(instance as ReactFlowInstance<FlowNode, Edge>);
  }, []);

  return (
    <FlowBuilderContainer>
      <NodePalette />
      <ReactFlowProvider>
        <MainContent>
          <ToolbarContainer elevation={1}>
            <TextField
              size="small"
              label="Flow Name"
              value={flowName}
              onChange={handleFlowNameChange}
              sx={{ minWidth: 300 }}
              error={!!flowNameError}
              helperText={flowNameError}
            />

            <TextField
              size="small"
              label="Description"
              value={flowDescription}
              onChange={handleFlowDescriptionChange}
              multiline
              maxRows={3}
              sx={{ minWidth: 300, flex: 1 }}
              placeholder="Optional — shown on the flow card"
            />

            <Tooltip
              arrow
              title="Unattended: if a step's model stops without handing off, the engine drives the conversation forward to the next step instead of silently ending the run. Recommended for scheduled/headless flows; leave off for interactive chat."
            >
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={flowUnattended}
                    onChange={handleFlowUnattendedChange}
                  />
                }
                label="Unattended"
                sx={{ whiteSpace: 'nowrap', ml: 0.5 }}
              />
            </Tooltip>

            <Button
              variant="contained"
              color="primary"
              onClick={handleSave}
              startIcon={<SaveIcon />}
              disabled={!!flowNameError}
            >
              Save Flow
            </Button>
            
            <FlowValidationButton nodes={nodes} edges={edges} />

            <Tooltip title="Auto-arrange nodes into a clean layout">
              <span>
                <Button
                  variant="outlined"
                  color="primary"
                  onClick={handleAutoAlign}
                  startIcon={<AccountTreeIcon />}
                  disabled={nodes.length <= 1}
                >
                  Auto-Align
                </Button>
              </span>
            </Tooltip>

            <Tooltip title="Add a missing Start/Finish and connect disconnected nodes">
              <ButtonGroup variant="outlined" color="primary" disabled={nodes.length === 0}>
                <Button onClick={handleRepairStatic} startIcon={<HealingIcon />}>
                  Repair
                </Button>
                <Button
                  size="small"
                  onClick={(e) => setRepairMenuAnchor(e.currentTarget)}
                  aria-label="Repair options"
                >
                  <ArrowDropDownIcon />
                </Button>
              </ButtonGroup>
            </Tooltip>
            <Menu
              anchorEl={repairMenuAnchor}
              open={!!repairMenuAnchor}
              onClose={() => setRepairMenuAnchor(null)}
            >
              <MenuItem onClick={handleRepairStatic}>Repair automatically (no model)</MenuItem>
              <MenuItem onClick={handleRepairWithAI}>Repair with AI…</MenuItem>
            </Menu>

            {initialFlow && (
              <>
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={() => {
                    setImproveInitialDescription('');
                    setImproveDialogOpen(true);
                  }}
                  startIcon={<AutoFixHighIcon />}
                  data-tour="improve-flow"
                >
                  AI-Improve
                </Button>
                <Tooltip title="Browse, preview, and restore earlier saved versions of this flow">
                  <Button
                    variant="outlined"
                    color="primary"
                    onClick={() => setVersionHistoryOpen(true)}
                    startIcon={<HistoryIcon />}
                  >
                    History
                  </Button>
                </Tooltip>
                <Button
                  variant="outlined"
                  color="primary"
                  onClick={() => {
                    setDialogType('duplicate');
                    setNewFlowName(`${initialFlow.name}_copy`);
                    setDialogOpen(true);
                  }}
                >
                  Copy Flow
                </Button>
                <Button variant="outlined" color="error" onClick={handleDelete}>
                  Delete Flow
                </Button>
              </>
            )}

            <Divider orientation="vertical" flexItem />
            
            <IconButton 
              onClick={handleUndo} 
              disabled={!canUndo}
              color="primary"
              size="small"
            >
              <UndoIcon />
            </IconButton>
            
            <IconButton 
              onClick={handleRedo} 
              disabled={!canRedo}
              color="primary"
              size="small"
            >
              <RedoIcon />
            </IconButton>
            
            <Box sx={{ flex: 1 }} />
          </ToolbarContainer>

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
          
          <Box sx={{ flex: 1, position: 'relative' }}>
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
              onEditEdge={(edge) => setEditingEdge(edge)}
            />
          </Box>
        </MainContent>
      </ReactFlowProvider>
      
      {/* Node Properties Modals */}
      <ProcessNodePropertiesModal
        open={processModalOpen}
        node={nodeToEdit}
        onClose={() => setProcessModalOpen(false)}
        onSave={handleNodeUpdate}
        flowEdges={edges}
        flowNodes={nodes}
        flowId={initialFlow?.id}
        onConnectMcpServer={(serverName) => {
          if (nodeToEdit) {
            handleConnectMcpServer(nodeToEdit.id, serverName);
          }
        }}
      />
      
      <MCPNodePropertiesModal 
        open={mcpModalOpen}
        node={nodeToEdit}
        onClose={() => setMcpModalOpen(false)}
        onSave={handleNodeUpdate}
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
        flowId={initialFlow?.id}
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

      <EdgePropertiesModal
        open={!!editingEdge}
        edge={editingEdge}
        onClose={() => setEditingEdge(null)}
        onSave={handleSaveEdgeCondition}
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
          unattended: flowUnattended,
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
            ? 'Copy Flow' 
            : dialogType === 'rename' 
              ? 'Rename Flow' 
              : 'Unsaved Changes'}
        </DialogTitle>
        <DialogContent>
          {dialogType === 'unsaved' ? (
            <DialogContentText>
              You have unsaved changes in the current flow. What would you like to do?
            </DialogContentText>
          ) : (
            <>
              <DialogContentText>
                {dialogType === 'duplicate' 
                  ? 'Enter a name for the copied flow:' 
                  : 'You are changing the name of this flow. Do you want to rename it or create a copy with the new name?'}
              </DialogContentText>
              <TextField
                autoFocus
                margin="dense"
                label="Flow Name"
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
          <Button onClick={handleDialogClose}>Cancel</Button>
          
          {dialogType === 'unsaved' && (
            <>
              <Button 
                onClick={handleDiscardAndContinue}
                color="error"
              >
                Discard Changes
              </Button>
              <Button 
                onClick={handleSaveAndContinue}
                variant="contained" 
                color="primary"
              >
                Save Changes
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
                Copy
              </Button>
              <Button 
                onClick={handleDialogConfirm} 
                variant="contained" 
                color="primary"
                disabled={!!newFlowNameError}
              >
                Rename
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
              Copy
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </FlowBuilderContainer>
  );
});

FlowBuilder.displayName = 'FlowBuilder';

export default FlowBuilder;
