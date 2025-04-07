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
    Grid,
    Typography,
    Tabs,
    Tab
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { FlowNode } from '@/frontend/types/flow/flow';
import { Edge } from '@xyflow/react';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { ProcessNodePropertiesModalProps } from './ProcessNodePropertiesModal/types'; // Adjusted path
import useModelManagement from './ProcessNodePropertiesModal/hooks/useModelManagement'; // Adjusted path
import useServerConnection from './ProcessNodePropertiesModal/hooks/useServerConnection'; // Adjusted path
import useNodeData from './ProcessNodePropertiesModal/hooks/useNodeData'; // Adjusted path
import useHandoffTools from './ProcessNodePropertiesModal/hooks/useHandoffTools'; // Adjusted path
import NodeConfiguration from './ProcessNodePropertiesModal/NodeConfiguration'; // Adjusted path
import ModelBinding from './ProcessNodePropertiesModal/ModelBinding/index'; // Adjusted path
import ServerTools from './ProcessNodePropertiesModal/ServerTools/ServerTools'; // Adjusted path
import AgentTools from './ProcessNodePropertiesModal/ServerTools/AgentTools'; // Adjusted path
import PromptTemplateEditor from './ProcessNodePropertiesModal/PromptTemplateEditor'; // Adjusted path
import NodeProperties from './ProcessNodePropertiesModal/NodeProperties'; // Adjusted path
import { getNodeProperties } from './ProcessNodePropertiesModal/utils'; // Adjusted path
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal');

export const ProcessNodePropertiesModal = ({ open, node, onClose, onSave, flowEdges = [], flowNodes = [], flowId }: ProcessNodePropertiesModalProps) => {
  log.debug('ProcessNodePropertiesModal rendered with:', { node: node, flowId: flowId });
  const { nodeData, setNodeData, handlePropertyChange } = useNodeData(node);
  const [promptTemplate, setPromptTemplate] = useState('');
  const [isModelBound, setIsModelBound] = useState(false);
  const [excludeModelPrompt, setExcludeModelPrompt] = useState(false);
  const [excludeStartNodePrompt, setExcludeStartNodePrompt] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('server');

  const { models, isLoadingModels, loadError, handleModelSelect, handleUnbindModel } = useModelManagement(
    open,
    nodeData,
    setNodeData,
    setPromptTemplate,
    setIsModelBound
  );

  const {
    connectedMcpNodes,
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
    }
  }, [node, open]);

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
    
    // Create the binding in the format that will be visually displayed as a pill
    // For handoff tools, use a different format to distinguish them
    const binding = toolType === 'handoff' 
      ? `\${_-_-_handoff_-_-_${toolName}}` 
      : `\${_-_-_${serverName}_-_-_${toolName}}`;
    
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

  const handleSave = () => {
    if (node && nodeData) {
      // Make sure to include the prompt template and toggle states in the saved data
      const updatedNodeData = {
        ...nodeData,
        properties: {
          ...nodeData.properties,
          promptTemplate: promptTemplate,
          excludeModelPrompt: excludeModelPrompt,
          excludeStartNodePrompt: excludeStartNodePrompt,
        }
      };
      onSave(node.id, updatedNodeData);
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
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

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 3, overflow: 'auto', height: 'calc(90vh - 130px)' }}>
        <Grid container spacing={2} sx={{ flexGrow: 1, height: '100%' }}>
          <Grid item xs={6} sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
            <Box sx={{ mb: 3 }}>
              <NodeConfiguration nodeData={nodeData} setNodeData={setNodeData} />
            </Box>
            <Box sx={{ mb: 3 }}>
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
            <Box sx={{ mb: 3 }}>
              {/* Tabs for Server Tools and Agent Tools */}
              <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
                <Tabs value={activeTab} onChange={(_, newValue: string) => setActiveTab(newValue)}>
                  <Tab label="Server Tools" value="server" />
                  <Tab label="Agent Tools" value="agent" />
                </Tabs>
              </Box>
              
              {/* Show Server Tools tab content */}
              {activeTab === 'server' && (
                <ServerTools
                  isLoadingServers={isLoadingServers}
                  connectedMcpNodes={connectedMcpNodes}
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
              
              {/* Show Agent Tools tab content */}
              {activeTab === 'agent' && (
                <AgentTools
                  handoffTools={handoffTools}
                  isLoadingHandoffTools={isLoadingHandoffTools}
                  handleInsertToolBinding={(toolType: string, toolName: string) => handleInsertToolBinding(toolType, toolName, 'handoff')}
                  promptBuilderRef={promptBuilderRef}
                  selectedNodeId={node?.id || null}
                />
              )}
            </Box>
            <Box>
              <NodeProperties nodeData={nodeData} handlePropertyChange={handlePropertyChange} properties={properties} />
            </Box>
          </Grid>

          <Grid item xs={6} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <PromptTemplateEditor
              ref={promptBuilderRef}
              promptTemplate={promptTemplate}
              handlePromptChange={handlePromptChange}
              excludeModelPrompt={excludeModelPrompt}
              setExcludeModelPrompt={setExcludeModelPrompt}
              excludeStartNodePrompt={excludeStartNodePrompt}
              setExcludeStartNodePrompt={setExcludeStartNodePrompt}
              isModelBound={isModelBound}
              models={models}
              nodeData={nodeData}
              flowId={flowId}
            />
          </Grid>
        </Grid>
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
