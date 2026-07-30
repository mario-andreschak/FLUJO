import React, { useState, useRef, useEffect } from 'react';
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    Box,
    IconButton,
    Divider,
    Typography,
    Tabs,
    Tab,
    FormControlLabel,
    Switch
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { FlowNode } from '@/frontend/types/flow/flow';
import { Edge } from '@xyflow/react';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { encodeBindingPill } from '@/utils/shared/mcpBinding';
import {
  createPromptReferenceSuggestion,
  PromptReferenceSuggestion,
} from '@/utils/shared/promptRefs';
import { mcpService } from '@/frontend/services/mcp';
import type { MCPResource, MCPResourceTemplate } from '@/shared/types/mcp';
import { ProcessNodePropertiesModalProps } from './ProcessNodePropertiesModal/types'; // Adjusted path
import useModelManagement from './ProcessNodePropertiesModal/hooks/useModelManagement'; // Adjusted path
import useServerConnection from './ProcessNodePropertiesModal/hooks/useServerConnection'; // Adjusted path
import useNodeData from './ProcessNodePropertiesModal/hooks/useNodeData'; // Adjusted path
import useHandoffTools from './ProcessNodePropertiesModal/hooks/useHandoffTools'; // Adjusted path
import NodeConfiguration from './ProcessNodePropertiesModal/NodeConfiguration'; // Adjusted path
import ModelBinding from './ProcessNodePropertiesModal/ModelBinding/index'; // Adjusted path
import ServerTools from './ProcessNodePropertiesModal/ServerTools/ServerTools'; // Adjusted path
import ServerResources from './ProcessNodePropertiesModal/ServerTools/ServerResources'; // Adjusted path
import WiredResources, { WiredResource } from './ProcessNodePropertiesModal/ServerTools/WiredResources';
import AgentTools from './ProcessNodePropertiesModal/ServerTools/AgentTools'; // Adjusted path
import PromptTemplateEditor from './ProcessNodePropertiesModal/PromptTemplateEditor'; // Adjusted path
import PromptIOControls from './ProcessNodePropertiesModal/PromptIOControls';
import NodeProperties from './ProcessNodePropertiesModal/NodeProperties'; // Adjusted path
import CaptureFields from './shared/CaptureFields';
import { parseKvRef, buildKvRef, KvRefScope } from '@/utils/shared/resolveKvRefs';
import { getNodeProperties } from './ProcessNodePropertiesModal/utils'; // Adjusted path
import { createLogger } from '@/utils/logger';
import type { FlowAuthoringMode } from '@/utils/shared/flowAuthoringProfile';

const log = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal');

// Issue #300: the 5 top-level sections. The modal renders all of them stacked
// in a single scroll container; the tab bar both scrolls a section into view
// (on click) and reflects the section currently in view (via IntersectionObserver).
type SectionKey = 'basic' | 'model' | 'io' | 'task' | 'advanced';
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'basic', label: 'Basic' },
  { key: 'model', label: 'Model' },
  { key: 'io', label: 'Input/Output' },
  { key: 'task', label: 'Task' },
  { key: 'advanced', label: 'Advanced' },
];

const TASK_TOOLS_WIDTH_STORAGE_KEY = 'flujo.processNode.taskToolsPaneWidth';
const DEFAULT_TASK_TOOLS_WIDTH = 340;
const MIN_TASK_TOOLS_WIDTH = 260;
const MAX_TASK_TOOLS_WIDTH = 640;
const MIN_TASK_EDITOR_WIDTH = 360;
const TASK_DIVIDER_WIDTH = 12;
const TASK_RESIZE_STEP = 24;

const clampTaskToolsWidth = (width: number, containerWidth = 0): number => {
  const viewportMaximum = containerWidth > 0
    ? Math.max(MIN_TASK_TOOLS_WIDTH, containerWidth - MIN_TASK_EDITOR_WIDTH - TASK_DIVIDER_WIDTH)
    : MAX_TASK_TOOLS_WIDTH;
  const maximum = Math.min(MAX_TASK_TOOLS_WIDTH, viewportMaximum);
  return Math.min(Math.max(width, MIN_TASK_TOOLS_WIDTH), maximum);
};

const readStoredTaskToolsWidth = (): number => {
  if (typeof window === 'undefined') return DEFAULT_TASK_TOOLS_WIDTH;
  try {
    const stored = Number(window.localStorage.getItem(TASK_TOOLS_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0
      ? clampTaskToolsWidth(stored)
      : DEFAULT_TASK_TOOLS_WIDTH;
  } catch {
    return DEFAULT_TASK_TOOLS_WIDTH;
  }
};

export function getInitialProcessSection(
  authoringMode: FlowAuthoringMode,
  promptTemplate: unknown,
): SectionKey {
  return authoringMode === 'guided'
    && typeof promptTemplate === 'string'
    && promptTemplate.trim().length > 0
    ? 'task'
    : 'basic';
}

export const ProcessNodePropertiesModal = ({
  open,
  node,
  onClose,
  onSave,
  flowEdges = [],
  flowNodes = [],
  flowId,
  onConnectMcpServer,
  authoringMode = 'advanced',
  mode = 'edit',
}: ProcessNodePropertiesModalProps) => {
  log.debug('ProcessNodePropertiesModal rendered with:', { node: node, flowId: flowId });
  const { nodeData, setNodeData, handlePropertyChange } = useNodeData(node);
  const [promptTemplate, setPromptTemplate] = useState('');
  const [isModelBound, setIsModelBound] = useState(false);
  const [excludeModelPrompt, setExcludeModelPrompt] = useState(false);
  const [excludeStartNodePrompt, setExcludeStartNodePrompt] = useState(false);
  const [excludeSystemPrompt, setExcludeSystemPrompt] = useState(false);
  const [inputMode, setInputMode] = useState<'full-history' | 'latest-message' | 'isolated'>('full-history');
  const [isolatedPrompt, setIsolatedPrompt] = useState('');
  // Issue #96: only meaningful in isolated mode; default ON (a caller may pass a
  // prompt through the handoff tool that overrides the isolated prompt below).
  const [allowCallerPrompt, setAllowCallerPrompt] = useState(true);
  const [outputMode, setOutputMode] = useState<'full-conversation' | 'latest-message'>('full-conversation');
  // Issue #259: opt in to the synthetic `todo` tool for this node.
  const [enableTodoTool, setEnableTodoTool] = useState(false);
  // Data-flow capture editors (issue #203, Phase 3 of #186). captureKv is split
  // into scope + key for editing and recombined via buildKvRef on save.
  const [captureVariable, setCaptureVariable] = useState('');
  const [captureResource, setCaptureResource] = useState('');
  const [captureKvScope, setCaptureKvScope] = useState<KvRefScope>('folder');
  const [captureKvKey, setCaptureKvKey] = useState('');
  // Inner MCP | Connected Nodes | Resources sub-tabs (inside the Task section).
  const [activeTab, setActiveTab] = useState<string>('server');
  // Issue #300: the currently active top-level section tab.
  const [activeSection, setActiveSection] = useState<SectionKey>('basic');
  const [taskToolsWidth, setTaskToolsWidth] = useState(readStoredTaskToolsWidth);
  const [isResizingTaskPanes, setIsResizingTaskPanes] = useState(false);
  const visibleSections = authoringMode === 'advanced'
    ? SECTIONS
    : SECTIONS.filter((section) => ['basic', 'model', 'task'].includes(section.key));

  // Refs for each section, used both for tab-click scroll-into-view and for the
  // IntersectionObserver that keeps the tab bar in sync while the user scrolls.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const basicRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const ioRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<HTMLDivElement>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  const taskSplitContainerRef = useRef<HTMLDivElement>(null);
  const taskToolsWidthRef = useRef(taskToolsWidth);
  const taskResizeStartRef = useRef({ pointerX: 0, width: taskToolsWidth });
  const sectionRefs: Record<SectionKey, React.RefObject<HTMLDivElement | null>> = {
    basic: basicRef,
    model: modelRef,
    io: ioRef,
    task: taskRef,
    advanced: advancedRef,
  };
  // While a programmatic (tab-click) smooth scroll is in flight, ignore the
  // IntersectionObserver so it doesn't flicker the active tab through sections.
  const isProgrammaticScroll = useRef(false);

  useEffect(() => {
    if (authoringMode === 'guided' && (activeSection === 'io' || activeSection === 'advanced')) {
      setActiveSection('basic');
    }
    if (authoringMode === 'guided' && activeTab !== 'server') setActiveTab('server');
  }, [activeSection, activeTab, authoringMode]);

  useEffect(() => {
    taskToolsWidthRef.current = taskToolsWidth;
    try {
      window.localStorage.setItem(TASK_TOOLS_WIDTH_STORAGE_KEY, String(taskToolsWidth));
    } catch {
      // localStorage can be unavailable in privacy-restricted browser contexts.
    }
  }, [taskToolsWidth]);

  useEffect(() => {
    const clampToContainer = () => {
      const containerWidth = taskSplitContainerRef.current?.getBoundingClientRect().width ?? 0;
      setTaskToolsWidth((current) => clampTaskToolsWidth(current, containerWidth));
    };
    clampToContainer();
    window.addEventListener('resize', clampToContainer);
    return () => window.removeEventListener('resize', clampToContainer);
  }, [open]);

  useEffect(() => {
    if (!isResizingTaskPanes) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (!Number.isFinite(event.clientX)) return;
      const containerWidth = taskSplitContainerRef.current?.getBoundingClientRect().width ?? 0;
      const nextWidth = taskResizeStartRef.current.width
        + event.clientX - taskResizeStartRef.current.pointerX;
      setTaskToolsWidth(clampTaskToolsWidth(nextWidth, containerWidth));
    };
    const finishResize = () => setIsResizingTaskPanes(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingTaskPanes]);

  const { models, isLoadingModels, loadError, handleModelSelect, handleUnbindModel } = useModelManagement(
    open,
    nodeData,
    setNodeData,
    setPromptTemplate,
    setIsModelBound
  );

  const {
    connectedMcpNodes,
    allServers,
    isLoadingServers,
    selectedToolServerNodeId,
    serverToolsMap,
    serverStatuses,
    isLoadingTools,
    handleSelectToolServer,
    isLoadingSelectedServerTools,
    handleRetryServer,
    handleRestartServer
  } = useServerConnection(open, node, flowEdges, flowNodes);

  const [resourceSuggestions, setResourceSuggestions] = useState<PromptReferenceSuggestion[]>([]);

  useEffect(() => {
    let cancelled = false;
    const serverNames = [...new Set(
      connectedMcpNodes
        .filter((connected) => connected.status === 'connected')
        .map((connected) => connected.serverName),
    )];
    if (!open || serverNames.length === 0) {
      setResourceSuggestions([]);
      return () => { cancelled = true; };
    }
    void Promise.all(serverNames.map(async (serverName) => {
      try {
        const result = await mcpService.listServerResources(serverName);
        const contexts = connectedMcpNodes.filter((connected) => connected.serverName === serverName);
        const isEnabled = (uri: string) => contexts.some((connected) => {
          const enabled = connected.enabledResources;
          return enabled === undefined || enabled === 'all' || enabled.includes(uri);
        });
        return [
          ...(result.resources ?? [])
            .filter((resource: MCPResource) => isEnabled(resource.uri))
            .map((resource: MCPResource) => createPromptReferenceSuggestion(
              { kind: 'resource', server: serverName, name: resource.uri },
              resource.name || resource.uri,
              resource.description || `${serverName} · ${resource.uri}`,
            )),
          ...(result.resourceTemplates ?? [])
            .filter((resource: MCPResourceTemplate) => isEnabled(resource.uriTemplate))
            .map((resource: MCPResourceTemplate) => createPromptReferenceSuggestion(
              { kind: 'resource', server: serverName, name: resource.uriTemplate },
              resource.name || resource.uriTemplate,
              resource.description || `${serverName} · ${resource.uriTemplate}`,
            )),
        ];
      } catch (error) {
        log.warn(`Failed to load @ resource suggestions for ${serverName}`, error);
        return [];
      }
    })).then((groups) => {
      if (!cancelled) setResourceSuggestions(groups.flat());
    });
    return () => { cancelled = true; };
  }, [open, connectedMcpNodes]);

  const referenceSuggestions = React.useMemo<PromptReferenceSuggestion[]>(() => {
    const toolSuggestions = connectedMcpNodes.flatMap((connected) => {
      const enabled = new Set(connected.enabledTools ?? []);
      return (serverToolsMap[connected.serverName] ?? [])
        .filter((tool) => tool?.name && enabled.has(tool.name))
        .map((tool) => createPromptReferenceSuggestion(
          { kind: 'tool', server: connected.serverName, name: tool.name },
          tool.name,
          tool.description || connected.serverName,
        ));
    });
    return [...toolSuggestions, ...resourceSuggestions];
  }, [connectedMcpNodes, resourceSuggestions, serverToolsMap]);
  
  // Tier 3 (issue #161 item 3): resource NODES wired to this process node on
  // the canvas. Direction encodes role (resource→process = consume;
  // process→resource = produce). Derived from the same flowEdges/flowNodes the
  // MCP hooks use, so no extra data plumbing is needed. Declared with the other
  // hooks (before any early return) to respect the Rules of Hooks.
  const wiredResources: WiredResource[] = React.useMemo(() => {
    if (!node) return [];
    const out: WiredResource[] = [];
    for (const e of flowEdges) {
      if ((e.data as { edgeType?: string } | undefined)?.edgeType !== 'resource') continue;
      let resId: string | undefined;
      let role: 'consume' | 'produce' | undefined;
      if (e.target === node.id) { resId = e.source; role = 'consume'; }
      else if (e.source === node.id) { resId = e.target; role = 'produce'; }
      if (!resId || !role) continue;
      const rn = flowNodes.find((n) => n.id === resId);
      if (!rn || rn.type !== 'resource') continue;
      const p = (rn.data?.properties ?? {}) as {
        name?: string; scope?: 'mcp' | 'run'; runName?: string; uri?: string; boundServer?: string;
      };
      out.push({
        id: resId,
        role,
        label: p.name || p.runName || p.uri || resId,
        scope: p.scope,
        runName: p.runName,
        uri: p.uri,
        boundServer: p.boundServer,
      });
    }
    return out;
  }, [node, flowEdges, flowNodes]);

  // Get handoff tools for agent tab
  const handoffToolsResult = useHandoffTools(open, node, flowEdges, flowNodes);
  const handoffTools = handoffToolsResult?.handoffTools || [];
  const isLoadingHandoffTools = handoffToolsResult?.isLoadingHandoffTools || false;
  
  // Log handoff tools for debugging
  useEffect(() => {
    if (open && node) {
      log.debug('Handoff tools:', { 
        count: handoffTools.length, 
        tools: handoffTools.map(t => t.name) 
      });
    }
  }, [open, node, handoffTools]);

    // Load prompt template and model binding status when node changes
  useEffect(() => {
    if (!open) return;

    if (node) {
      // Always load the prompt template from the node's properties
      const savedPromptTemplate = node.data.properties?.promptTemplate || '';
      setPromptTemplate(savedPromptTemplate);

      // Set model binding status
      if (node.data.properties?.boundModel) {
        setIsModelBound(true);
      } else {
        setIsModelBound(false);
      }

      // Load toggle states from node properties if they exist
      setExcludeModelPrompt(node.data.properties?.excludeModelPrompt || false);
      setExcludeStartNodePrompt(node.data.properties?.excludeStartNodePrompt || false);
      setExcludeSystemPrompt(node.data.properties?.excludeSystemPrompt || false);
      setInputMode(node.data.properties?.inputMode || 'full-history');
      setIsolatedPrompt(node.data.properties?.isolatedPrompt || '');
      setAllowCallerPrompt(node.data.properties?.allowCallerPrompt !== false);
      setOutputMode(node.data.properties?.outputMode || 'full-conversation');
      setEnableTodoTool(node.data.properties?.enableTodoTool || false);

      // Data-flow capture (issue #203). parseKvRef('') → { scope:'folder', key:'' }.
      setCaptureVariable(node.data.properties?.captureVariable || '');
      setCaptureResource(node.data.properties?.captureResource || '');
      const kvParsed = parseKvRef(node.data.properties?.captureKv || '');
      setCaptureKvScope(kvParsed.scope);
      setCaptureKvKey(kvParsed.key || '');

    }

    // Reset both navigation levels whenever the modal target or open state changes.
    // Guided edit sessions with an authored task open directly on Task; new and
    // advanced sessions start on Basic.
    const initialSection: SectionKey = mode === 'create'
      ? 'basic'
      : getInitialProcessSection(authoringMode, node?.data.properties?.promptTemplate);
    setActiveSection(initialSection);
    setActiveTab('server');
    isProgrammaticScroll.current = true;
    const frame = window.requestAnimationFrame(() => {
      const target = sectionRefs[initialSection].current;
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
      } else if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = target?.offsetTop ?? 0;
      }
      isProgrammaticScroll.current = false;
    });
    return () => {
      window.cancelAnimationFrame(frame);
      isProgrammaticScroll.current = false;
    };
    // sectionRefs is stable for the lifetime of this modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, open, mode, authoringMode]);

  // Issue #300: keep the active tab in sync with the section scrolled into view.
  useEffect(() => {
    if (!open) return;
    const root = scrollContainerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (isProgrammaticScroll.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const key = (visible[0]?.target as HTMLElement | undefined)?.dataset.section as SectionKey | undefined;
        if (key) setActiveSection(key);
      },
      { root, threshold: [0.15, 0.4, 0.75], rootMargin: '0px 0px -45% 0px' }
    );
    Object.values(sectionRefs).forEach((r) => { if (r.current) observer.observe(r.current); });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, node]);

  const handleSectionClick = (key: SectionKey) => {
    setActiveSection(key);
    isProgrammaticScroll.current = true;
    const target = sectionRefs[key].current;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = target?.offsetTop ?? 0;
    }
    // Re-enable observer once the smooth scroll has settled.
    window.setTimeout(() => { isProgrammaticScroll.current = false; }, 700);
  };

  const handleTaskDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!Number.isFinite(event.clientX)) return;
    event.preventDefault();
    taskResizeStartRef.current = {
      pointerX: event.clientX,
      width: taskToolsWidthRef.current,
    };
    setIsResizingTaskPanes(true);
  };

  const handleTaskDividerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const containerWidth = taskSplitContainerRef.current?.getBoundingClientRect().width ?? 0;
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') nextWidth = taskToolsWidthRef.current - TASK_RESIZE_STEP;
    if (event.key === 'ArrowRight') nextWidth = taskToolsWidthRef.current + TASK_RESIZE_STEP;
    if (event.key === 'Home') nextWidth = MIN_TASK_TOOLS_WIDTH;
    if (event.key === 'End') nextWidth = MAX_TASK_TOOLS_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    setTaskToolsWidth(clampTaskToolsWidth(nextWidth, containerWidth));
  };

  const handleDialogEntered = () => {
    if (activeSection !== 'task') return;
    isProgrammaticScroll.current = true;
    taskRef.current?.scrollIntoView({ block: 'start' });
    window.setTimeout(() => { isProgrammaticScroll.current = false; }, 0);
  };

  const promptBuilderRef = useRef<PromptBuilderRef>(null);

  const handleInsertToolBinding = (serverName: string, toolName: string, toolType: string = 'server'): void => {
    // Log the parameters to help with debugging
    log.debug('handleInsertToolBinding called with:', JSON.stringify({ serverName, toolName }));
    
    // Validate the parameters
    if (!serverName || !toolName) {
      log.warn('Invalid parameters for handleInsertToolBinding:', { serverName, toolName });
      return;
    }
    
    // Get the tool description if available from serverToolsMap
    const toolsMap = serverToolsMap as Record<string, any[]>;
    const tools = toolsMap[serverName] || [];
    const tool = tools.find((t: any) => t.name === toolName);
    const toolDescription = tool?.description || '';
    
    // Create the binding pill (canonical format). Handoff tools use the pseudo-server
    // `handoff` so they're visually distinguished and routed correctly downstream.
    const binding = toolType === 'handoff'
      ? encodeBindingPill('tool', 'handoff', toolName)
      : encodeBindingPill('tool', serverName, toolName);
    
    // Add a space before the binding if needed
    const needsSpace = promptTemplate.length > 0 && !promptTemplate.endsWith(' ') && !promptTemplate.endsWith('\n');
    const textToInsert = (needsSpace ? ' ' : '') + binding;

    // Use the ref to insert text at the current cursor position
    if (promptBuilderRef.current) {
      log.debug('Inserting text into PromptBuilder:', JSON.stringify({ textToInsert }));
      promptBuilderRef.current.insertText(textToInsert);
      log.debug('Tool binding inserted successfully');
    } else {
      log.warn('promptBuilderRef.current is null, cannot insert text');
    }
    
    // Update the promptTemplate state to reflect the change
    // Note: We don't need to manually update the state here as the PromptBuilder's onChange handler will be triggered
    // when we insert the text, which will update the promptTemplate state
  };

  const handleInsertResourceBinding = (serverName: string, uri: string): void => {
    if (!serverName || !uri) {
      log.warn('Invalid parameters for handleInsertResourceBinding:', { serverName, uri });
      return;
    }
    const binding = encodeBindingPill('resource', serverName, uri);
    const needsSpace = promptTemplate.length > 0 && !promptTemplate.endsWith(' ') && !promptTemplate.endsWith('\n');
    const textToInsert = (needsSpace ? ' ' : '') + binding;
    if (promptBuilderRef.current) {
      promptBuilderRef.current.insertText(textToInsert);
    } else {
      log.warn('promptBuilderRef.current is null, cannot insert resource binding');
    }
  };

  // Inject a ${var:}/${res:}/${kv:} reference into the prompt editor at the
  // cursor, mirroring the tool/resource binding insert helpers above.
  const handleInsertCaptureRef = (ref: string): void => {
    const needsSpace = promptTemplate.length > 0 && !promptTemplate.endsWith(' ') && !promptTemplate.endsWith('\n');
    const textToInsert = (needsSpace ? ' ' : '') + ref;
    if (promptBuilderRef.current) {
      promptBuilderRef.current.insertText(textToInsert);
    } else {
      log.warn('promptBuilderRef.current is null, cannot insert capture reference');
    }
  };

  const handleSave = () => {
    if (node && nodeData) {
      const properties: Record<string, any> = {
        ...nodeData.properties,
        promptTemplate: promptTemplate,
      };

      if (authoringMode === 'advanced') {
        Object.assign(properties, {
          excludeModelPrompt,
          excludeStartNodePrompt,
          excludeSystemPrompt,
          inputMode,
          isolatedPrompt,
          allowCallerPrompt,
          outputMode,
        });

        // Issue #259: only persist enableTodoTool when ON, so flows that don't use
        // it stay byte-identical (same delete-when-false convention as captureX).
        if (enableTodoTool) properties.enableTodoTool = true; else delete properties.enableTodoTool;

        // Data-flow capture (issue #203): set the trimmed value or REMOVE the key
        // when empty, so flowToSpec never emits an empty captureX and existing
        // flows without these fields stay byte-identical.
        const cv = captureVariable.trim();
        if (cv) properties.captureVariable = cv; else delete properties.captureVariable;
        const cr = captureResource.trim();
        if (cr) properties.captureResource = cr; else delete properties.captureResource;
        const ckv = buildKvRef(captureKvScope, captureKvKey);
        if (ckv) properties.captureKv = ckv; else delete properties.captureKv;
      }

      onSave(node.id, { ...nodeData, properties });
      onClose();
    }
  };

  const handlePromptChange = (value: string) => {
    setPromptTemplate(value);
    // Also update the node data
    setNodeData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        properties: {
          ...prev.properties,
          promptTemplate: value,
        },
      };
    });
  };

  if (!node || !nodeData) return null;

  const properties = getNodeProperties();
  const selectedModelId = nodeData.properties?.boundModel || '';

  // Issue #300 (feedback): each section fills the scroll-port and snaps "as a
  // whole" so a scroll gesture jumps to the next section instead of drifting
  // line-by-line. Sections taller than the viewport (Task/Advanced) still
  // scroll internally; only their top is a snap point.
  const sectionSx = {
    minHeight: '100%',
    scrollSnapAlign: 'start' as const,
    scrollSnapStop: 'always' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    pb: 4,
  };

  // The inner MCP | Connected Nodes | Resources panels, rendered beside the
  // editor. The editor stays mounted while these panels switch so binding
  // insertion always retains the same promptBuilderRef.
  const toolPanels = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {authoringMode === 'advanced' && <Box sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Tabs
          value={activeTab}
          onChange={(_, newValue: string) => setActiveTab(newValue)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Task tools"
        >
          <Tab id="process-task-tab-server" aria-controls="process-task-panel-server" label="MCP" value="server" />
          <Tab id="process-task-tab-agent" aria-controls="process-task-panel-agent" label="Connected Nodes" value="agent" />
          <Tab id="process-task-tab-resources" aria-controls="process-task-panel-resources" label="Resources" value="resources" />
        </Tabs>
      </Box>}

      <Box
        id={`process-task-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`process-task-tab-${activeTab}`}
        data-testid="process-task-tools-scroll"
        sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}
      >
        {/* Show Server Tools tab content */}
        {activeTab === 'server' && (
          <ServerTools
            isLoadingServers={isLoadingServers}
            connectedMcpNodes={connectedMcpNodes}
            availableServers={allServers}
            onConnectMcpServer={onConnectMcpServer}
            serverStatuses={serverStatuses}
            serverToolsMap={serverToolsMap}
            isLoadingTools={isLoadingTools}
            handleInsertToolBinding={handleInsertToolBinding}
            selectedToolServerNodeId={selectedToolServerNodeId}
            selectedNodeId={node?.id || null}
            handleSelectToolServer={handleSelectToolServer}
            isLoadingSelectedServerTools={isLoadingSelectedServerTools}
            promptBuilderRef={promptBuilderRef}
            handleRetryServer={handleRetryServer}
            handleRestartServer={handleRestartServer}
          />
        )}

        {/* Show Resources tab content */}
        {authoringMode === 'advanced' && activeTab === 'resources' && (
          <>
            <WiredResources
              wiredResources={wiredResources}
              promptBuilderRef={promptBuilderRef}
            />
            <ServerResources
              connectedMcpNodes={connectedMcpNodes}
              handleInsertResourceBinding={handleInsertResourceBinding}
              promptBuilderRef={promptBuilderRef}
            />
          </>
        )}

        {/* Show Agent Tools tab content */}
        {authoringMode === 'advanced' && activeTab === 'agent' && (
          <AgentTools
            handoffTools={handoffTools}
            isLoadingHandoffTools={isLoadingHandoffTools}
            handleInsertToolBinding={(toolType: string, toolName: string) => handleInsertToolBinding(toolType, toolName, 'handoff')}
            promptBuilderRef={promptBuilderRef}
          />
        )}
      </Box>
    </Box>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      slotProps={{ transition: { onEntered: handleDialogEntered } }}
      maxWidth="xl"
      fullWidth
      PaperProps={{
        sx: {
          borderTop: 5,
          borderColor: 'secondary.main',
          width: '95vw',
          height: '90vh',
          maxWidth: '95vw',
          maxHeight: '90vh',
        }
      }}
    >
      <DialogTitle component="div">
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">
            {nodeData.label || 'Process Node'} Properties
          </Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 0, overflow: 'hidden', height: 'calc(90vh - 130px)' }}>
        {/* Section tab bar — click to scroll a section into view (issue #300). */}
        <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 2, flexShrink: 0 }}>
          <Tabs
            value={activeSection}
            onChange={(_, newValue: SectionKey) => handleSectionClick(newValue)}
            variant="scrollable"
            scrollButtons="auto"
          >
            {visibleSections.map((s) => (
              <Tab key={s.key} label={s.label} value={s.key} />
            ))}
          </Tabs>
        </Box>

        {/* Single scroll surface: all five sections stacked, with per-page
            scroll-snap so scrolling moves whole sections (issue #300). */}
        <Box ref={scrollContainerRef} sx={{ flexGrow: 1, overflow: 'auto', p: 3, scrollSnapType: 'y mandatory', scrollPaddingTop: '24px' }}>
          {/* Basic */}
          <Box ref={basicRef} data-section="basic" sx={sectionSx}>
            <Typography variant="h6" sx={{ mb: 2 }}>Basic</Typography>
            <NodeConfiguration nodeData={nodeData} setNodeData={setNodeData} />
          </Box>

          {/* Model */}
          <Box ref={modelRef} data-section="model" sx={sectionSx}>
            <Typography variant="h6" sx={{ mb: 2 }}>Model</Typography>
            <ModelBinding
              isLoadingModels={isLoadingModels}
              loadError={loadError}
              models={models}
              selectedModelId={selectedModelId}
              handleModelSelect={handleModelSelect}
              isModelBound={isModelBound}
              handleUnbindModel={handleUnbindModel}
            />
          </Box>

          {/* Input/Output */}
          {authoringMode === 'advanced' && <Box ref={ioRef} data-section="io" sx={sectionSx}>
            <Typography variant="h6" sx={{ mb: 2 }}>Input / Output</Typography>
            <PromptIOControls
              excludeModelPrompt={excludeModelPrompt}
              setExcludeModelPrompt={setExcludeModelPrompt}
              excludeStartNodePrompt={excludeStartNodePrompt}
              setExcludeStartNodePrompt={setExcludeStartNodePrompt}
              excludeSystemPrompt={excludeSystemPrompt}
              setExcludeSystemPrompt={setExcludeSystemPrompt}
              inputMode={inputMode}
              setInputMode={setInputMode}
              isolatedPrompt={isolatedPrompt}
              setIsolatedPrompt={setIsolatedPrompt}
              allowCallerPrompt={allowCallerPrompt}
              setAllowCallerPrompt={setAllowCallerPrompt}
              outputMode={outputMode}
              setOutputMode={setOutputMode}
              isModelBound={isModelBound}
              models={models}
              nodeData={nodeData}
            />
            {/* Issue #259: opt in to the run-scoped `todo` task list. */}
            <FormControlLabel
              sx={{ mt: 1 }}
              control={
                <Switch
                  checked={enableTodoTool}
                  onChange={(e) => setEnableTodoTool(e.target.checked)}
                />
              }
              label="Enable todo tool (run-scoped task list)"
            />
          </Box>}

          {/* Task — independently scrollable tools/editor panes with a persisted
              accessible splitter. The prompt editor remains mounted once. */}
          <Box ref={taskRef} data-section="task" sx={sectionSx}>
            <Typography variant="h6" sx={{ mb: 2 }}>Task</Typography>
            <Box
              ref={taskSplitContainerRef}
              data-testid="process-task-split-container"
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', md: 'row' },
                flexGrow: 1,
                minHeight: 480,
                height: { xs: 'auto', md: 'clamp(480px, 62vh, 680px)' },
                overflow: 'hidden',
              }}
            >
              <Box
                data-testid="process-task-tools-pane"
                sx={{
                  flex: { xs: '0 0 auto', md: `0 0 ${taskToolsWidth}px` },
                  width: { xs: '100%', md: `${taskToolsWidth}px` },
                  minWidth: 0,
                  minHeight: { xs: 320, md: 0 },
                  maxHeight: { xs: 420, md: 'none' },
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                {toolPanels}
              </Box>
              <Box
                role="separator"
                aria-label="Resize Task tools and prompt editor panes"
                aria-orientation="vertical"
                aria-valuemin={MIN_TASK_TOOLS_WIDTH}
                aria-valuemax={MAX_TASK_TOOLS_WIDTH}
                aria-valuenow={Math.round(taskToolsWidth)}
                tabIndex={0}
                onPointerDown={handleTaskDividerPointerDown}
                onKeyDown={handleTaskDividerKeyDown}
                sx={{
                  display: { xs: 'none', md: 'flex' },
                  flex: `0 0 ${TASK_DIVIDER_WIDTH}px`,
                  cursor: 'col-resize',
                  alignItems: 'stretch',
                  justifyContent: 'center',
                  touchAction: 'none',
                  bgcolor: isResizingTaskPanes ? 'action.selected' : 'transparent',
                  '&::after': {
                    content: '""',
                    width: 2,
                    borderRadius: 1,
                    bgcolor: 'divider',
                  },
                  '&:hover, &:focus-visible': { bgcolor: 'action.hover', outline: 'none' },
                }}
              />
              <Box
                data-testid="process-task-editor-scroll"
                sx={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  minHeight: { xs: 420, md: 0 },
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'auto',
                }}
              >
                <PromptTemplateEditor
                  ref={promptBuilderRef}
                  promptTemplate={promptTemplate}
                  handlePromptChange={handlePromptChange}
                  excludeModelPrompt={excludeModelPrompt}
                  excludeStartNodePrompt={excludeStartNodePrompt}
                  excludeSystemPrompt={excludeSystemPrompt}
                  nodeData={nodeData}
                  flowId={flowId}
                  suggestions={referenceSuggestions}
                />
              </Box>
            </Box>
          </Box>

          {/* Advanced */}
          {authoringMode === 'advanced' && <Box ref={advancedRef} data-section="advanced" sx={sectionSx}>
            <Typography variant="h6" sx={{ mb: 2 }}>Advanced</Typography>
            <Box sx={{ mb: 3 }}>
              <NodeProperties nodeData={nodeData} handlePropertyChange={handlePropertyChange} properties={properties} />
            </Box>
            <Box>
              <CaptureFields
                value={{ captureVariable, captureResource, captureKvScope, captureKvKey }}
                onChange={(patch) => {
                  if (patch.captureVariable !== undefined) setCaptureVariable(patch.captureVariable);
                  if (patch.captureResource !== undefined) setCaptureResource(patch.captureResource);
                  if (patch.captureKvScope !== undefined) setCaptureKvScope(patch.captureKvScope);
                  if (patch.captureKvKey !== undefined) setCaptureKvKey(patch.captureKvKey);
                }}
                onInsertRef={handleInsertCaptureRef}
              />
            </Box>
          </Box>}
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" color="primary">
          Save Changes
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ProcessNodePropertiesModal;
