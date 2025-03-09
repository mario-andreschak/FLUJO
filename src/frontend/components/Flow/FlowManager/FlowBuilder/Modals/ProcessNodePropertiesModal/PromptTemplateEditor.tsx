import React, { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';
import { Box, Typography, FormControlLabel, Switch, CircularProgress, Alert, Paper, Button } from '@mui/material';
import PromptBuilder, { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/PromptTemplateEditor');

interface PromptTemplateEditorProps {
  promptTemplate: string;
  handlePromptChange: (value: string) => void;
  excludeModelPrompt: boolean;
  setExcludeModelPrompt: (value: boolean) => void;
  excludeStartNodePrompt: boolean;
  setExcludeStartNodePrompt: (value: boolean) => void;
  isModelBound: boolean;
  models: any[];
  nodeData: any;
  flowId?: string;
}

const PromptTemplateEditor = forwardRef<PromptBuilderRef, PromptTemplateEditorProps>((props, ref) => {
  const {
    promptTemplate,
    handlePromptChange,
    excludeModelPrompt,
    setExcludeModelPrompt,
    excludeStartNodePrompt,
    setExcludeStartNodePrompt,
    isModelBound,
    models,
    nodeData,
    flowId
  } = props;
  
  // State for rendered prompt
  const [renderedPrompt, setRenderedPrompt] = useState<string>('');
  const [isRendering, setIsRendering] = useState<boolean>(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  
  const promptBuilderRef = useRef<PromptBuilderRef>(null);
  
  // Forward the ref to the parent component
  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      if (promptBuilderRef.current) {
        promptBuilderRef.current.insertText(text);
      }
    },
    getMode: () => {
      if (promptBuilderRef.current) {
        return promptBuilderRef.current.getMode();
      }
      return 'raw';
    }
  }));

  // Function to fetch rendered prompt
  const fetchRenderedPrompt = async () => {
    log.debug('fetchRenderedPrompt called with:', { flowId, nodeId: nodeData?.id });
    if (!flowId || !nodeData || !nodeData.id) {
      setRenderError('Flow ID or Node ID is missing');
      return;
    }

    setIsRendering(true);
    setRenderError(null);
    
    try {
      const response = await fetch('/api/flow/prompt-renderer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          flowId,
          nodeId: nodeData.id,
          options: {
            renderMode: 'rendered',
            includeConversationHistory: false,
            excludeModelPrompt,
            excludeStartNodePrompt
          },
        }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to render prompt');
      }
      
      log.debug('Rendered prompt received', { promptLength: data.prompt?.length });
      setRenderedPrompt(data.prompt + '\n\n [Messages sent by User]');
    } catch (error) {
      log.error('Error fetching rendered prompt', error);
      setRenderError(error instanceof Error ? error.message : 'An unknown error occurred');
    } finally {
      setIsRendering(false);
    }
  };

  // Handle mode change in PromptBuilder
  const handleModeChange = (mode: 'raw' | 'preview') => {
    // When switching to preview mode, fetch the rendered prompt
    if (mode === 'preview') {
      fetchRenderedPrompt();
    }
  };

  // Fetch rendered prompt when relevant props change and in preview mode
  useEffect(() => {
    // Check if PromptBuilder is in preview mode
    if (promptBuilderRef.current && promptBuilderRef.current.getMode() === 'preview') {
      fetchRenderedPrompt();
    }
  }, [promptTemplate, excludeModelPrompt, excludeStartNodePrompt, flowId, nodeData?.id]);

  // Custom renderer for preview mode that shows the complete rendered prompt
  const customPreviewRenderer = () => {
    if (isRendering) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
          <CircularProgress size={40} />
        </Box>
      );
    }
    
    if (renderError) {
      return (
        <Box sx={{ display: 'flex', flexDirection: 'column', p: 2 }}>
          <Alert 
            severity="error" 
            sx={{ mb: 2 }}
            action={
              <Button color="inherit" size="small" onClick={fetchRenderedPrompt}>
                Retry
              </Button>
            }
          >
            {renderError}
          </Alert>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
            {!flowId 
              ? "This flow hasn't been saved yet. Save the flow first to enable complete preview." 
              : "Check that the flow and node IDs are valid and try again."}
          </Typography>
        </Box>
      );
    }
    
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'medium' }}>
          Complete Rendered Prompt
        </Typography>
        <Paper 
          elevation={0} 
          sx={{ 
            p: 2, 
            overflow: 'auto',
            bgcolor: 'rgba(0, 0, 0, 0.02)',
            border: '1px solid rgba(0, 0, 0, 0.1)',
            borderRadius: 1
          }}
        >
          <Box
            component="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              m: 0
            }}
          >
            {renderedPrompt || 'No rendered prompt available. Please check your flow configuration.'}
          </Box>
        </Paper>
      </Box>
    );
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', pl: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">
          Prompt Template
        </Typography>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <FormControlLabel
            control={
              <Switch
                checked={excludeModelPrompt}
                onChange={(e) => setExcludeModelPrompt(e.target.checked)}
                color="primary"
                size="small"
              />
            }
            label="Exclude Model Prompt"
          />
          <FormControlLabel
            control={
              <Switch
                checked={excludeStartNodePrompt}
                onChange={(e) => setExcludeStartNodePrompt(e.target.checked)}
                color="primary"
                size="small"
              />
            }
            label="Exclude Start Node Prompt"
          />
        </Box>
      </Box>

      {/* Prompt inclusion preview */}
      <Box sx={{ mb: 2, p: 2, bgcolor: 'rgba(0, 0, 0, 0.03)', borderRadius: 1, fontSize: '0.85rem' }}>
        <Typography variant="caption" sx={{ display: 'block', mb: 1, fontWeight: 'bold' }}>
          Prompt Rendering Order:
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {!excludeStartNodePrompt && (
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 'medium' }}>
                1. Start Node Prompt
              </Typography>
              <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                (from the Start node in this flow)
              </Typography>
            </Box>
          )}
          {!excludeModelPrompt && isModelBound && (
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'secondary.main', fontWeight: 'medium' }}>
                {!excludeStartNodePrompt ? '2.' : '1.'} Model Prompt
              </Typography>
              <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                (from the selected model: {
                  // Find the model by ID to get its display name
                  (() => {
                    const modelId = nodeData.properties?.boundModel;
                    if (!modelId) return 'None';
                    const model = models.find(m => m.id === modelId);
                    return model ? (model.displayName || model.name) : nodeData.properties?.modelName || 'None';
                  })()
                })
              </Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ fontWeight: 'medium' }}>
              {(!excludeStartNodePrompt && !excludeModelPrompt && isModelBound) ? '3.' :
                (!excludeStartNodePrompt || (!excludeModelPrompt && isModelBound)) ? '2.' : '1.'} This Node's Prompt
            </Typography>
            <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
              (defined below)
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ fontWeight: 'medium' }}>
              {(!excludeStartNodePrompt && !excludeModelPrompt && isModelBound) ? '4.' :
                (!excludeStartNodePrompt || (!excludeModelPrompt && isModelBound)) ? '3.' : '2.'} Conversation History
            </Typography>
            <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
              (coming from ChatCompletion endpoint)
            </Typography>
          </Box>
        </Box>
      </Box>

      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', height: 'calc(100% - 120px)' }}>
        <PromptBuilder
          ref={promptBuilderRef}
          value={promptTemplate}
          onChange={handlePromptChange}
          label=""
          height="100%"
          onModeChange={handleModeChange}
          customPreviewRenderer={customPreviewRenderer}
        />
      </Box>
    </Box>
  );
});

// Add display name for the component
PromptTemplateEditor.displayName = 'PromptTemplateEditor';

export default PromptTemplateEditor;
