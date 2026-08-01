import React, { useState } from 'react';
import { Box, Button, TextField, Typography, Paper, CircularProgress, FormControlLabel, Switch } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface PromptRendererDemoProps {
  flowId?: string;
  nodeId?: string;
}

const PromptRendererDemo: React.FC<PromptRendererDemoProps> = ({ flowId: initialFlowId, nodeId: initialNodeId }) => {
  const { t } = useI18n();
  const [flowId, setFlowId] = useState(initialFlowId || '');
  const [nodeId, setNodeId] = useState(initialNodeId || '');
  const [renderMode, setRenderMode] = useState<'raw' | 'rendered'>('rendered');
  const [includeConversationHistory, setIncludeConversationHistory] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRender = async () => {
    if (!flowId || !nodeId) {
      setError(t('promptRenderer.required'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/flow/prompt-renderer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          flowId,
          nodeId,
          options: {
            renderMode,
            includeConversationHistory,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || t('promptRenderer.failed'));
      }

      setPrompt(data.prompt);
    } catch (error) {
      setError(error instanceof Error ? error.message : t('common.unknownError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" gutterBottom>
        {t('promptRenderer.title')}
      </Typography>

      <Box sx={{ mb: 3 }}>
        <TextField
          fullWidth
          label={t('promptRenderer.flowId')}
          value={flowId}
          onChange={(e) => setFlowId(e.target.value)}
          margin="normal"
          variant="outlined"
          size="small"
        />
        <TextField
          fullWidth
          label={t('promptRenderer.nodeId')}
          value={nodeId}
          onChange={(e) => setNodeId(e.target.value)}
          margin="normal"
          variant="outlined"
          size="small"
        />

        <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
          <FormControlLabel
            control={
              <Switch
                checked={renderMode === 'rendered'}
                onChange={(e) => setRenderMode(e.target.checked ? 'rendered' : 'raw')}
              />
            }
            label={t('promptRenderer.resolveTools')}
          />
          <FormControlLabel
            control={
              <Switch
                checked={includeConversationHistory}
                onChange={(e) => setIncludeConversationHistory(e.target.checked)}
              />
            }
            label={t('promptRenderer.includeHistory')}
          />
        </Box>

        <Button
          variant="contained"
          color="primary"
          onClick={handleRender}
          disabled={loading || !flowId || !nodeId}
          sx={{ mt: 2 }}
        >
          {loading ? <CircularProgress size={24} /> : t('promptRenderer.action')}
        </Button>
      </Box>

      {error && (
        <Typography color="error" sx={{ mb: 2 }}>
          {error}
        </Typography>
      )}

      {prompt && (
        <Paper sx={{ p: 2, maxHeight: '400px', overflow: 'auto' }}>
          <Typography variant="subtitle1" gutterBottom>
            {t('promptRenderer.result')}
          </Typography>
          <Box
            component="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              p: 1,
              bgcolor: 'rgba(0, 0, 0, 0.03)',
              borderRadius: 1,
            }}
          >
            {prompt}
          </Box>
        </Paper>
      )}
    </Box>
  );
};

export default PromptRendererDemo;
