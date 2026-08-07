"use client";

import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { 
  Box, 
  Typography, 
  Button, 
  Dialog, 
  DialogTitle, 
  DialogContent, 
  DialogContentText, 
  DialogActions, 
  TextField,
  Collapse,
  Alert,
  Tooltip,
  Paper,
  IconButton,
  Fade,
  Zoom,
  useTheme
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import FlowBuilder, { FlowBuilderHandle } from '@/frontend/components/Flow/FlowManager/FlowBuilder';
import GenerateFlowDialog, { GeneratedFlowInfo } from '@/frontend/components/Flow/FlowManager/GenerateFlowDialog';
import PageHeader from '@/frontend/components/shared/PageHeader';
import { setNavigationGuard, clearNavigationGuard, NavigationGuard } from '@/frontend/utils/navigationGuard';
import { useEntityDeepLink } from '@/frontend/hooks/useEntityDeepLink';
import { useHistoryGuard } from '@/frontend/hooks/useHistoryGuard';
import { magicLinkPath } from '@/frontend/utils/magicLink';
import CopyLinkButton from '@/frontend/components/shared/CopyLinkButton';
import FlowDashboard from '@/frontend/components/Flow/FlowDashboard';
import { Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { writeUiPreference } from '@/frontend/hooks/useUiPreference';
import type { FlowAuthoringMode } from '@/utils/shared/flowAuthoringProfile';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useAskFlujoPage } from '@/frontend/contexts/AskFlujoContext';

const log = createLogger('app/flows/page');

const FlowsPage = () => {
  log.debug('Rendering FlowsPage');
  const theme = useTheme();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, tp, formatList } = useI18n();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // The FlowBuilder is a real history state (#374): `mode=edit` in the URL is
  // the single source of truth for whether the editor is open, so Back/
  // Forward/refresh all do the right thing. `pushedByUsRef` remembers whether
  // *this page* pushed the edit URL (vs. it being the very first entry, e.g.
  // a fresh deep link), so handleBackToDashboard knows whether `router.back()`
  // is safe or would leave the app entirely.
  const isEditing = searchParams.get('mode') === 'edit' && !!selectedFlow;
  const pushedByUsRef = useRef(false);
  const flowBuilderRef = useRef<FlowBuilderHandle>(null);

  // Opens the editor for `flowId` as a real, back-able history entry.
  const enterEditor = useCallback((flowId: string) => {
    log.debug('Entering flow editor', { flowId });
    setSelectedFlow(flowId);
    pushedByUsRef.current = true;
    router.push(magicLinkPath({ kind: 'flow-editor', id: flowId }));
  }, [router]);
  
  // Generated draft (issue #14): an UNSAVED flow the builder edits via initialFlow.
  // It is deliberately NOT in `flows` — handleSaveFlow's create-vs-update check relies
  // on that, so the first save POSTs it like any new flow.
  const [draftFlow, setDraftFlow] = useState<Flow | null>(null);
  // Multi-level generation (#94): auto-generated subflow flows that belong to the current
  // draft, in dependency order (descendants first). They are UNSAVED like the root and are
  // persisted just before the root on first save, so every subflowId resolves. Discarding
  // the draft discards these too.
  const [draftDescendants, setDraftDescendants] = useState<Flow[]>([]);
  // Some creation actions promise a specific first view. Keep that intent
  // separate from the persisted preference so advanced-feature detection does
  // not override an explicit "Continue to simple builder" handoff.
  const [builderEntryMode, setBuilderEntryMode] = useState<FlowAuthoringMode | undefined>();
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const createAssistantHandled = useRef(false);

  const askSelectedFlow = selectedFlow
    ? flows.find(flow => flow.id === selectedFlow) ?? (draftFlow?.id === selectedFlow ? draftFlow : null)
    : null;
  useAskFlujoPage({
    scopeId: askSelectedFlow ? `flow:${askSelectedFlow.id}` : 'flows:dashboard',
    pageType: askSelectedFlow ? 'flow' : 'flows',
    route: '/flows',
    title: askSelectedFlow?.name ?? t('flows.page.title'),
    identifiers: { flowId: askSelectedFlow?.id ?? null },
    data: askSelectedFlow ? { flow: askSelectedFlow } : { flows },
    capabilities: {
      notes: askSelectedFlow
        ? ['The nested Flow Builder adapter replaces this saved snapshot with live unsaved state while the editor is mounted.']
        : ['The dashboard context contains every flow currently shown on screen.'],
    },
  });

  // Copy flow dialog state
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [flowToCopy, setFlowToCopy] = useState<Flow | null>(null);
  const [newFlowName, setNewFlowName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  
  // Snackbar for notifications
  const [snackbar, setSnackbar] = useState<{open: boolean; message: string; severity: 'success' | 'error' | 'info' | 'warning'}>({
    open: false,
    message: '',
    severity: 'info'
  });

  // Load flows on component mount and when selected flow changes
  useEffect(() => {
    log.info('Loading flows');
    const loadFlows = async () => {
      setIsLoading(true);
      try {
        const loadedFlows = await flowService.loadFlows();
        log.debug('Flows loaded successfully', { count: loadedFlows.length });
        setFlows(loadedFlows);
        
        // If a flow was previously selected, verify it still exists. An unsaved
        // generated draft is never in the loaded list — don't deselect it.
        if (selectedFlow) {
          const flowExists =
            loadedFlows.some(flow => flow.id === selectedFlow) ||
            draftFlow?.id === selectedFlow;
          if (!flowExists) {
            log.warn('Previously selected flow no longer exists', { flowId: selectedFlow });
            setSelectedFlow(null);
            router.replace('/flows');
            showSnackbar(t('flows.page.previousMissing'), 'warning');
          }
        }
      } catch (error) {
        log.error('Error loading flows', error);
        showSnackbar(t('flows.page.loadFailed'), 'error');
      } finally {
        setIsLoading(false);
      }
    };

    loadFlows();
  }, [selectedFlow, draftFlow, t]);
  
  // Handle flow selection
  const handleSelectFlow = useCallback((flowId: string) => {
    log.debug('Flow selected', { flowId });
    setBuilderEntryMode(undefined);
    enterEditor(flowId); // Auto-enter edit mode when a flow is selected
  }, [enterEditor]);

  // Start a new chat conversation bound to a flow (#148). The Chat page reads
  // the `?flow=<id>` param, creates a conversation for it, then clears the param.
  const handleOpenInChat = useCallback((flowId: string) => {
    log.debug('Opening flow in chat', { flowId });
    router.push(`/chat?flow=${encodeURIComponent(flowId)}`);
  }, [router]);

  // The builder saves before calling this action, so Try can move straight into
  // a normal chat without reopening the unsaved-changes guard.
  const handleOpenSelectedFlowInChat = useCallback(() => {
    if (!selectedFlow) return;
    router.push(`/chat?flow=${encodeURIComponent(selectedFlow)}`);
  }, [selectedFlow, router]);

  // Deep link: ?flow=<id> opens that flow straight in the editor (used by the
  // brain viewer's "Open in Editor" link). Runs once the flows have loaded so
  // we only open a flow that actually exists; an unknown id is ignored.
  useEntityDeepLink({
    param: 'flow',
    ready: !isLoading,
    exists: (id) => flows.some(f => f.id === id),
    onResolve: handleSelectFlow,
  });
  
  // While the editor is open, app-wide navigation (the top menu) must run
  // through the builder's guard too — otherwise switching to Models/MCP/Chat
  // unmounts the editor and silently discards unsaved changes.
  useEffect(() => {
    if (!(isEditing && selectedFlow)) return;
    const guard: NavigationGuard = (navigate) => {
      if (flowBuilderRef.current) {
        flowBuilderRef.current.requestNavigation(navigate);
      } else {
        navigate();
      }
    };
    setNavigationGuard(guard);
    return () => clearNavigationGuard(guard);
  }, [isEditing, selectedFlow]);

  // Browser Back must respect the same guard as top-nav clicks (#374) —
  // otherwise pressing Back while the editor has unsaved changes silently
  // discards them instead of leaving `/flows` entirely.
  const historyGuard = useHistoryGuard({
    active: isEditing && !!selectedFlow,
    currentUrl: selectedFlow ? magicLinkPath({ kind: 'flow-editor', id: selectedFlow }) : '/flows',
  });

  // Show snackbar notification (declared before its first useCallback consumer)
  const showSnackbar = useCallback((message: string, severity: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    log.debug('Showing snackbar', { message, severity });
    setSnackbar({
      open: true,
      message,
      severity
    });
  }, []);

  // Handle back to dashboard — routed through the builder's navigation
  // guard so unsaved changes get a Save/Discard dialog first.
  const handleBackToDashboard = useCallback(() => {
    log.debug('Returning to dashboard');
    const leave = () => {
      setBuilderEntryMode(undefined);
      // Leaving a generated draft without saving discards it — the root AND any
      // auto-generated subflow descendants (the dashboard only shows saved flows, so a
      // lingering draft would be unreachable anyway).
      if (draftFlow && draftFlow.id === selectedFlow) {
        const hadDescendants = draftDescendants.length > 0;
        setDraftFlow(null);
        setDraftDescendants([]);
        setSelectedFlow(null);
        showSnackbar(
          hadDescendants ? t('flows.page.draftBundleDiscarded') : t('flows.page.draftDiscarded'),
          'info'
        );
      }
      // The URL is the source of truth for `isEditing` — pop the `mode=edit`
      // entry this page pushed when it's safe to, otherwise (e.g. a deep link
      // landed directly in edit mode with nothing to pop) fall back to a
      // plain replace so Back can never leave the app entirely.
      historyGuard.suppressNext();
      if (pushedByUsRef.current) {
        pushedByUsRef.current = false;
        router.back();
      } else {
        router.replace('/flows');
      }
    };
    if (flowBuilderRef.current) {
      flowBuilderRef.current.requestNavigation(leave);
    } else {
      leave();
    }
  }, [draftFlow, draftDescendants, selectedFlow, showSnackbar, t, historyGuard, router]);
  
  // Handle banner close
  const handleSnackbarClose = useCallback(() => {
    setSnackbar(prev => ({ ...prev, open: false }));
  }, []);

  // Auto-dismiss the banner after a few seconds (re-armed whenever a new
  // message is shown). Errors stay until dismissed so they aren't missed.
  useEffect(() => {
    if (!snackbar.open || snackbar.severity === 'error') return;
    const timer = setTimeout(() => {
      setSnackbar(prev => ({ ...prev, open: false }));
    }, 6000);
    return () => clearTimeout(timer);
  }, [snackbar.open, snackbar.message, snackbar.severity]);

  // Validate flow name
  const validateFlowName = useCallback((name: string): string | null => {
    log.debug('Validating flow name', { name });
    
    // Check if name is empty
    if (!name.trim()) {
      log.debug('Flow name validation failed: empty name');
      return t('flows.page.nameEmpty');
    }
    
    // Names are for people; the flow ID remains the stable machine identifier.
    if (!/^[\p{L}\p{N}_ -]+$/u.test(name.trim())) {
      log.debug('Flow name validation failed: invalid characters');
      return t('flows.page.nameCharacters');
    }
    
    // Check for duplicate names
    const isDuplicate = flows.some(flow => flow.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (isDuplicate) {
      log.debug('Flow name validation failed: duplicate name');
      return t('flows.page.nameDuplicate');
    }
    
    log.debug('Flow name validation passed');
    return null;
  }, [flows, t]);

  const handleSaveFlow = async (flow: Flow): Promise<boolean> => {
    log.info('Saving flow', { flowId: flow.id, flowName: flow.name });
    try {
      // Multi-level draft: persist the auto-generated descendant flows FIRST (they arrive in
      // dependency order) so the root's subflowId references resolve, then fall through to
      // save the root as usual.
      if (draftFlow?.id === flow.id && draftDescendants.length > 0) {
        log.info('Persisting generated subflow descendants before the root', { count: draftDescendants.length });
        for (const child of draftDescendants) {
          const childIsNew = !flows.some(f => f.id === child.id);
          const childResult = childIsNew
            ? await flowService.addFlow(child)
            : await flowService.updateFlow(child);
          if (!childResult.success) {
            log.error('Failed to save a generated subflow', { error: childResult.error, childId: child.id });
            showSnackbar(childResult.error || t('flows.page.saveSubflowFailed'), 'error');
            return false;
          }
        }
        setFlows(prev => {
          const known = new Set(prev.map(f => f.id));
          const added = draftDescendants.filter(c => !known.has(c.id));
          return added.length ? [...prev, ...added] : prev;
        });
        setDraftDescendants([]);
      }

      // A flow not yet in state is a create (POST); otherwise it's an update (PUT).
      const isNew = !flows.some(f => f.id === flow.id);
      const result = isNew
        ? await flowService.addFlow(flow)
        : await flowService.updateFlow(flow);

      if (!result.success) {
        log.error('Failed to save flow', { error: result.error });
        showSnackbar(result.error || t('flows.page.saveFailed'), 'error');
        return false;
      }
      log.debug('Flow saved successfully');

      // Update local state
      setFlows(prevFlows => {
        const existingFlowIndex = prevFlows.findIndex(f => f.id === flow.id);
        if (existingFlowIndex >= 0) {
          log.debug('Updating existing flow in state');
          // Update existing flow
          const updatedFlows = [...prevFlows];
          updatedFlows[existingFlowIndex] = flow;
          return updatedFlows;
        } else {
          log.debug('Adding new flow to state');
          // Add new flow
          return [...prevFlows, flow];
        }
      });

      // A saved draft is a draft no longer — it lives in `flows` now.
      if (draftFlow?.id === flow.id) {
        setDraftFlow(null);
      }

      setSelectedFlow(flow.id);
      showSnackbar(t('flows.page.saved'), 'success');
      return true;
    } catch (error) {
      log.error('Error saving flow', error);
      showSnackbar(t('flows.page.saveFailed'), 'error');
      return false;
    }
  };

  // The conversion endpoint has already persisted both flows. Mirror its
  // returned state locally without issuing a second parent save.
  const handleConversionCommitted = useCallback((parentFlow: Flow, childFlow: Flow) => {
    setFlows(previous => {
      const withoutConverted = previous.filter(flow => flow.id !== parentFlow.id && flow.id !== childFlow.id);
      return [...withoutConverted, parentFlow, childFlow];
    });
    setSelectedFlow(parentFlow.id);
    showSnackbar(t('flows.page.subflowCreated', { name: childFlow.name }), 'success');
  }, [showSnackbar, t]);

  const handleDeleteFlow = async (flowId: string) => {
    log.info('Deleting flow', { flowId });
    try {
      await flowService.deleteFlow(flowId);
      log.debug('Flow deleted successfully');
      
      // Update local state
      setFlows(prevFlows => prevFlows.filter(f => f.id !== flowId));
      
      if (selectedFlow === flowId) {
        log.debug('Clearing selected flow as it was deleted');
        setSelectedFlow(null);
        router.replace('/flows');
      }
      
      showSnackbar(t('flows.page.deleted'), 'success');
    } catch (error) {
      log.error('Error deleting flow', error);
      showSnackbar(t('flows.page.deleteFailed'), 'error');
    }
  };
  
  const handleSetFlowFolder = useCallback(async (flowId: string, folder: string | undefined) => {
    log.info('Setting flow folder', { flowId, folder });
    const flow = flows.find(f => f.id === flowId);
    if (!flow) {
      log.warn('Flow to move not found', { flowId });
      return;
    }
    // Empty/undefined folder means "Ungrouped".
    const updated: Flow = { ...flow, folder: folder && folder.trim() ? folder.trim() : undefined };
    try {
      const result = await flowService.updateFlow(updated);
      if (!result.success) {
        showSnackbar(result.error || t('flows.page.moveFailed'), 'error');
        return;
      }
      setFlows(prev => prev.map(f => (f.id === flowId ? updated : f)));
      showSnackbar(updated.folder ? t('flows.page.moved', { folder: updated.folder }) : t('flows.page.removedFolder'), 'success');
    } catch (error) {
      log.error('Error setting flow folder', error);
      showSnackbar(t('flows.page.moveFailed'), 'error');
    }
  }, [flows, showSnackbar, t]);

  const handleToggleFavorite = useCallback(async (flowId: string) => {
    log.info('Toggling flow favorite', { flowId });
    const flow = flows.find(f => f.id === flowId);
    if (!flow) {
      log.warn('Flow to favorite not found', { flowId });
      return;
    }
    // Persist the flipped flag via the same seam folders use (#71). Missing/false
    // reads as "not a favorite"; toggling clears it back to that.
    const nextFavorite = !flow.favorite;
    const updated: Flow = { ...flow, favorite: nextFavorite || undefined };
    try {
      const result = await flowService.updateFlow(updated);
      if (!result.success) {
        showSnackbar(result.error || t('flows.page.favoriteFailed'), 'error');
        return;
      }
      setFlows(prev => prev.map(f => (f.id === flowId ? updated : f)));
      showSnackbar(nextFavorite ? t('flows.page.favoriteAdded') : t('flows.page.favoriteRemoved'), 'success');
    } catch (error) {
      log.error('Error toggling flow favorite', error);
      showSnackbar(t('flows.page.favoriteFailed'), 'error');
    }
  }, [flows, showSnackbar, t]);

  const handleCopyFlow = (flowId: string) => {
    log.info('Copying flow', { flowId });
    const flowToCopy = flows.find(f => f.id === flowId);
    if (flowToCopy) {
      log.debug('Found flow to copy', { flowName: flowToCopy.name });
      setFlowToCopy(flowToCopy);
      setNewFlowName(t('flows.page.copyName', { name: flowToCopy.name }));
      setCopyDialogOpen(true);
    } else {
      log.warn('Flow to copy not found', { flowId });
      showSnackbar(t('flows.page.notFound'), 'error');
    }
  };
  
  const handleCopyDialogClose = () => {
    log.debug('Closing copy flow dialog');
    setCopyDialogOpen(false);
    setFlowToCopy(null);
    setNewFlowName('');
    setNameError(null);
  };
  
  const handleCopyConfirm = async () => {
    log.info('Confirming flow copy');
    if (!flowToCopy) {
      log.warn('No flow to copy');
      showSnackbar(t('flows.page.noCopySelection'), 'error');
      return;
    }
    
    // Validate flow name
    const error = validateFlowName(newFlowName);
    if (error) {
      log.debug('Flow name validation failed', { error });
      setNameError(error);
      return;
    }
    
    // Create a new flow with the same nodes and edges but a new ID and name
    const newId = uuidv4();
    log.debug('Creating new flow from copy', { newId, newName: newFlowName });
    const newFlow: Flow = {
      id: newId, // Generate a new ID
      name: newFlowName,
      description: flowToCopy.description,
      nodes: flowToCopy.nodes,
      edges: flowToCopy.edges,
      folder: flowToCopy.folder,
      favorite: flowToCopy.favorite,
    };
    
    // Save the new flow
    const saved = await handleSaveFlow(newFlow);
    if (!saved) return;
    
    // Close the dialog
    handleCopyDialogClose();
    
    // Select the new flow
    log.debug('Selecting newly copied flow');
    setBuilderEntryMode(undefined);
    enterEditor(newFlow.id);
    showSnackbar(t('flows.page.copyCreated', { name: newFlowName }), 'success');
  };
  
  const handleNewFlowNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    log.debug('Flow name changed', { name });
    setNewFlowName(name);
    setNameError(validateFlowName(name));
  };
  
  // A generated draft arrives: open it in the builder WITHOUT saving. The first
  // save POSTs it via handleSaveFlow's create branch (the draft isn't in `flows`).
  const handleGenerated = useCallback((result: GeneratedFlowInfo) => {
    log.info('Opening generated draft flow', {
      flowId: result.flow.id,
      attempts: result.attempts,
      errors: result.errorCount,
      warnings: result.warningCount,
    });
    setGenerateDialogOpen(false);
    // The root is opened in the builder; its auto-generated subflow descendants ride along
    // as an unsaved bundle and are persisted just before the root on first save.
    const descendants = (result.flows ?? []).filter(f => f.id !== result.rootFlowId);
    setDraftFlow(result.flow);
    setDraftDescendants(descendants);
    setBuilderEntryMode('guided');
    enterEditor(result.flow.id);
    const freshInstalls = result.installedServers?.filter(s => !s.alreadyExisted) ?? [];
    const installNote = freshInstalls.length > 0
      ? t('flows.page.connectedServers', { servers: formatList(freshInstalls.map(s => s.name)) })
      : '';
    const subflowNote = descendants.length > 0
      ? tp('flows.page.helper', descendants.length)
      : '';
    const extraNotes = [subflowNote, installNote].filter(Boolean).join(' ');
    if (result.errorCount > 0) {
      showSnackbar(
        `${tp('flows.page.draftAttention', result.errorCount)}${extraNotes ? ` ${extraNotes}` : ''}`,
        'warning'
      );
    } else if (result.warningCount > 0) {
      showSnackbar(`${t('flows.page.draftSuggestions')}${extraNotes ? ` ${extraNotes}` : ''}`, 'info');
    } else {
      showSnackbar(`${t('flows.page.draftReady')}${extraNotes ? ` ${extraNotes}` : ''}`, 'success');
    }
  }, [showSnackbar, t, tp, formatList, enterEditor]);

  // Create a new flow with a unique name
  const createNewFlow = useCallback((authoringMode: FlowAuthoringMode = 'guided') => {
    log.info('Creating new flow');
    // Generate a unique name for the new flow
    const baseName = t('flows.page.untitled');
    let newName = baseName;
    let counter = 2;
    
    // Check if a flow with this name already exists
    while (flows.some(flow => flow.name === newName)) {
      newName = `${baseName} ${counter}`;
      counter++;
    }
    
    // Create a new flow with the unique name (includes the default Start node)
    const newFlow = flowService.createNewFlow(newName);

    // Set the requested view before the builder mounts, avoiding a flash of the
    // previously used editor when starting explicitly in Easy or Expert mode.
    writeUiPreference('flujo-ui:flow-builder:mode', authoringMode);
    setBuilderEntryMode(authoringMode);

    // Keep manual creations as drafts too. Abandoning the editor no longer
    // leaves an empty flow card behind; the first successful Save persists it.
    setDraftFlow(newFlow);
    setDraftDescendants([]);
    enterEditor(newFlow.id);
    showSnackbar(
      authoringMode === 'advanced'
        ? t('flows.page.newExpert')
        : t('flows.page.newGuided'),
      'info',
    );
  }, [flows, showSnackbar, t, enterEditor]);

  // The setup journey deep-links directly into easy creation. Wait for the
  // assistant list so the generated draft name is unique, consume the query
  // once, and leave /flows as the clean stable URL in browser history.
  useEffect(() => {
    if (createAssistantHandled.current || isLoading) return;
    const requestedMode = new URLSearchParams(window.location.search).get('create');
    if (requestedMode !== 'assistant') {
      createAssistantHandled.current = true;
      return;
    }
    createAssistantHandled.current = true;
    // createNewFlow() already pushes the real `/flows?flow=<id>&mode=edit`
    // editor URL via enterEditor() — no separate replace needed to drop
    // `?create=assistant` (a replace here would just clear the mode=edit we
    // just pushed).
    createNewFlow('guided');
  }, [createNewFlow, isLoading]);

  // Render content based on state (dashboard or editor)
  const renderContent = () => {
    if (isEditing && selectedFlow) {
      // A generated draft is not in `flows` yet — fall back to it by id.
      const selectedFlowData =
        flows.find((f: Flow) => f.id === selectedFlow) ??
        (draftFlow?.id === selectedFlow ? draftFlow : undefined);
      if (!selectedFlowData) {
        return (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h6" color="error">
              {t('flows.page.notFound')}
            </Typography>
            <Button 
              variant="contained" 
              onClick={handleBackToDashboard}
              sx={{ mt: 2 }}
            >
              {t('flows.page.back')}
            </Button>
          </Box>
        );
      }
      
      return (
        <Fade in={true} timeout={300}>
          <Box sx={{ height: { xs: 'auto', md: '100%' } }}>
            <FlowBuilder
              key={selectedFlow}
              ref={flowBuilderRef}
              initialFlow={selectedFlowData}
              initialAuthoringMode={builderEntryMode}
              onSave={handleSaveFlow}
              onDelete={handleDeleteFlow}
              onConversionCommitted={handleConversionCommitted}
              allFlows={[
                ...flows.filter(flow => !draftDescendants.some(draft => draft.id === flow.id)),
                ...draftDescendants,
              ]}
              relatedDraftFlows={draftDescendants}
              onRelatedDraftFlowsChange={setDraftDescendants}
              isDraft={draftFlow?.id === selectedFlowData.id}
              onTry={handleOpenSelectedFlowInChat}
              onNavigateToFlow={handleSelectFlow}
            />
          </Box>
        </Fade>
      );
    }
    
    return (
      <Fade in={true} timeout={300}>
        <Box sx={{ height: { xs: 'auto', md: '100%' } }}>
          <FlowDashboard
            flows={flows}
            selectedFlow={selectedFlow}
            onSelectFlow={handleSelectFlow}
            onDeleteFlow={handleDeleteFlow}
            onCopyFlow={handleCopyFlow}
            onCreateFlow={() => createNewFlow('guided')}
            onSetFolder={handleSetFlowFolder}
            onToggleFavorite={handleToggleFavorite}
            onOpenInChat={handleOpenInChat}
            isLoading={isLoading}
          />
        </Box>
      </Fade>
    );
  };

  return (
    <Box
      sx={{
        height: { xs: 'auto', md: 'calc(100dvh - var(--app-bar-height))' },
        minHeight: 'calc(100dvh - var(--app-bar-height))',
        display: 'flex',
        flexDirection: 'column',
        overflow: { xs: 'visible', md: 'hidden' },
      }}
    >
      <PageHeader
        eyebrow={isEditing ? t('flows.page.eyebrowMine') : t('flows.page.eyebrowCreate')}
        icon={AccountTreeRoundedIcon}
        compact={isEditing}
        title={
          isEditing && selectedFlow
            ? draftFlow?.id === selectedFlow
              ? t('flows.page.draftSuffix', { name: draftFlow.name })
              : flows.find(f => f.id === selectedFlow)?.name || t('flows.page.agent')
            : t('flows.page.title')
        }
        description={
          isEditing
            ? t('flows.page.editDescription')
            : t('flows.page.description')
        }
        leading={
          isEditing && selectedFlow ? (
            <IconButton
              color="primary"
              onClick={handleBackToDashboard}
              aria-label={t('flows.page.back')}
              sx={{ border: 1, borderColor: 'divider' }}
            >
              <ArrowBackIcon />
            </IconButton>
          ) : undefined
        }
        actions={
          !isEditing ? (
            <>
            <Tooltip title={t('flows.page.aiHelp')} describeChild>
              <Button
                variant="contained"
                color="primary"
                startIcon={<AutoAwesomeIcon />}
                onClick={() => setGenerateDialogOpen(true)}
                data-tour="generate-flow"
              >
                {t('flows.page.createAi')}
              </Button>
            </Tooltip>
            <Tooltip title={t('flows.page.simpleHelp')} describeChild>
              <Button
                variant="outlined"
                color="primary"
                startIcon={<AddIcon />}
                onClick={() => createNewFlow('guided')}
                data-tour="new-flow"
              >
                {t('flows.page.startSimple')}
              </Button>
            </Tooltip>
            <Tooltip title={t('flows.page.expertHelp')} describeChild>
              <Button
                variant="outlined"
                color="primary"
                startIcon={<TuneRoundedIcon />}
                onClick={() => createNewFlow('advanced')}
                data-tour="new-expert-flow"
              >
                {t('flows.page.startExpert')}
              </Button>
            </Tooltip>
            </>
          ) : (
            selectedFlow && draftFlow?.id !== selectedFlow ? (
              <CopyLinkButton target={{ kind: 'flow-editor', id: selectedFlow }} />
            ) : undefined
          )
        }
      />

      {/* Notification banner - shown at the top of the content so it isn't easy
          to miss (replaces the old bottom-right toast/snackbar). */}
      <Collapse in={snackbar.open} unmountOnExit>
        <Alert
          severity={snackbar.severity}
          onClose={handleSnackbarClose}
          sx={{ borderRadius: 0 }}
        >
          {snackbar.message}
        </Alert>
      </Collapse>

      {/* Main content area - switches between dashboard and editor */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: { xs: 'visible', md: 'hidden' } }}>
        {renderContent()}
      </Box>
      
      {/* Copy agent dialog */}
      <Dialog open={copyDialogOpen} onClose={handleCopyDialogClose}>
        <DialogTitle>{t('flows.page.copyTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('flows.page.copyPrompt')}
          </DialogContentText>
          <TextField
            autoFocus
            margin="dense"
            label={t('flows.page.nameLabel')}
            type="text"
            fullWidth
            value={newFlowName}
            onChange={handleNewFlowNameChange}
            error={!!nameError}
            helperText={nameError}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCopyDialogClose}>{t('common.cancel')}</Button>
          <Button 
            onClick={handleCopyConfirm} 
            variant="contained" 
            color="primary"
            disabled={!!nameError}
          >
            {t('flows.page.copyAction')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Generate Flow Dialog (issue #14) */}
      <GenerateFlowDialog
        open={generateDialogOpen}
        onClose={() => setGenerateDialogOpen(false)}
        onGenerated={handleGenerated}
      />

    </Box>
  );
};

// `useSearchParams()` (needed to make `mode=edit` the source of truth for the
// editor, #374) opts the page into client-side rendering up to the nearest
// Suspense boundary — wrap here, matching the existing `/models` pattern.
const FlowsPageWithSuspense = () => (
  <Suspense fallback={null}>
    <FlowsPage />
  </Suspense>
);

export default FlowsPageWithSuspense;
