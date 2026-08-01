import React, { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';
import { Box, Typography, CircularProgress, Alert, Paper, Button } from '@mui/material';
import PromptBuilder, { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { createLogger } from '@/utils/logger';
import { PromptReferenceSuggestion } from '@/utils/shared/promptRefs';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/PromptTemplateEditor');

interface PromptTemplateEditorProps {
  promptTemplate: string;
  handlePromptChange: (value: string) => void;
  // Kept because the rendered-prompt preview endpoint needs the current exclude
  // flags; the toggle UI itself now lives in PromptIOControls (issue #300).
  excludeModelPrompt: boolean;
  excludeStartNodePrompt: boolean;
  excludeSystemPrompt: boolean;
  nodeData: any;
  flowId?: string;
  suggestions?: PromptReferenceSuggestion[];
}

/**
 * The PromptBuilder editor + rendered-prompt preview for the ProcessNode modal.
 *
 * Issue #300: the exclude toggles and input/output OptionCards that used to sit
 * above the editor were moved into the "Input/Output" tab (PromptIOControls).
 * This component is rendered exactly once (in the "Task" tab) and MUST stay
 * mounted across tab switches so that `promptBuilderRef.insertText(...)` — used
 * by the tool panels and capture fields in other tabs — keeps working.
 */
const PromptTemplateEditor = forwardRef<PromptBuilderRef, PromptTemplateEditorProps>((props, ref) => {
  const { t } = useI18n();
  const {
    promptTemplate,
    handlePromptChange,
    excludeModelPrompt,
    excludeStartNodePrompt,
    excludeSystemPrompt,
    nodeData,
    flowId,
    suggestions,
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
      setRenderError(t('flows.promptPreview.missingIds'));
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
            excludeStartNodePrompt,
            excludeSystemPrompt
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || t('flows.promptPreview.failed'));
      }

      log.debug('Rendered prompt received', { promptLength: data.prompt?.length });
      setRenderedPrompt(`${data.prompt}\n\n[${t('flows.promptPreview.userMessages')}]`);
    } catch (error) {
      log.error('Error fetching rendered prompt', error);
      setRenderError(error instanceof Error ? error.message : t('flows.promptPreview.unknownError'));
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
  }, [promptTemplate, excludeModelPrompt, excludeStartNodePrompt, excludeSystemPrompt, flowId, nodeData?.id]);

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
                {t('flows.promptPreview.retry')}
              </Button>
            }
          >
            {renderError}
          </Alert>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
            {!flowId
              ? t('flows.promptPreview.unsaved')
              : t('flows.promptPreview.checkIds')}
          </Typography>
        </Box>
      );
    }

    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'medium' }}>
          {t('flows.promptPreview.title')}
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
            {renderedPrompt || t('flows.promptPreview.empty')}
          </Box>
        </Paper>
      </Box>
    );
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PromptBuilder
        ref={promptBuilderRef}
        value={promptTemplate}
        onChange={handlePromptChange}
        label=""
        height="100%"
        onModeChange={handleModeChange}
        customPreviewRenderer={customPreviewRenderer}
        suggestions={suggestions}
      />
    </Box>
  );
});

// Add display name for the component
PromptTemplateEditor.displayName = 'PromptTemplateEditor';

export default PromptTemplateEditor;
