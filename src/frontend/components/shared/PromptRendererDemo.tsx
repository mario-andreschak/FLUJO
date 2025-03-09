import React, { useState } from 'react';
import { Box, Button, TextField, Typography, Paper, CircularProgress, FormControlLabel, Switch } from '@mui/material';

interface PromptRendererDemoProps {
  flowId?: string;
  nodeId?: string;
}

const PromptRendererDemo: React.FC<PromptRendererDemoProps> = ({ flowId: initialFlowId, nodeId: initialNodeId }) => {
  const [flowId, setFlowId] = useState(initialFlowId || '');
  const [nodeId, setNodeId] = useState(initialNodeId || '');
  const [renderMode, setRenderMode] = useState<'raw' | 'rendered'>('rendered');
  const [includeConversationHistory, setIncludeConversationHistory] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRender = async () => {
    if (!flowId || !nodeId) {
      setError('Flow ID and Node ID are required');
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
        throw new Error(data.error || 'Failed to render prompt');
      }

      setPrompt(data.prompt);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" gutterBottom>
        Prompt Renderer Demo
      </Typography>

      <Box sx={{ mb: 3 }}>
        <TextField
          fullWidth
          label="Flow ID"
          value={flowId}
          onChange={(e) => setFlowId(e.target.value)}
          margin="normal"
          variant="outlined"
          size="small"
        />
        <TextField
          fullWidth
          label="Node ID"
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
            label="Resolve Tool Pills"
          />
          <FormControlLabel
            control={
              <Switch
                checked={includeConversationHistory}
                onChange={(e) => setIncludeConversationHistory(e.target.checked)}
              />
            }
            label="Include Conversation History"
          />
        </Box>

        <Button
          variant="contained"
          color="primary"
          onClick={handleRender}
          disabled={loading || !flowId || !nodeId}
          sx={{ mt: 2 }}
        >
          {loading ? <CircularProgress size={24} /> : 'Render Prompt'}
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
            Rendered Prompt:
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
