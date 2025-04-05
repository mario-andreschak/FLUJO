'use client';

import React, { useState } from 'react';
import { TabProps, MessageState } from '../../types';
import { MCPDockerConfig, MCPServerConfig } from '@/shared/types/mcp/mcp';
import {
  Alert,
  Box,
  Button,
  Grid,
  Paper,
  Stack,
  TextField,
  Typography,
  FormControl,
  FormControlLabel,
  RadioGroup,
  Radio,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Divider,
  IconButton,
  InputAdornment
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/DockerTab');

const DockerTab: React.FC<TabProps> = ({
  initialConfig,
  onAdd,
  onUpdate,
  onClose
}) => {
  // Initialize with default values or values from initialConfig
  const [config, setConfig] = useState<Partial<MCPDockerConfig>>(() => {
    if (initialConfig && initialConfig.transport === 'docker') {
      return initialConfig;
    }
    return {
      name: '',
      transport: 'docker',
      image: '',
      transportMethod: 'stdio',
      disabled: false,
      autoApprove: [],
      rootPath: '',
      env: {},
      _buildCommand: '',
      _installCommand: ''
    };
  });

  const [message, setMessage] = useState<MessageState | null>(null);
  const [expandedSections, setExpandedSections] = useState({
    basic: true,
    advanced: false
  });
  const [volumes, setVolumes] = useState<string[]>(
    (initialConfig && initialConfig.transport === 'docker' && initialConfig.volumes) || []
  );
  const [extraArgs, setExtraArgs] = useState<string[]>(
    (initialConfig && initialConfig.transport === 'docker' && initialConfig.extraArgs) || []
  );

  // Handle form field changes
  const handleChange = (field: keyof MCPDockerConfig, value: any) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  // Handle volume changes
  const handleVolumeChange = (index: number, value: string) => {
    const newVolumes = [...volumes];
    newVolumes[index] = value;
    setVolumes(newVolumes);
  };

  // Add a new volume
  const addVolume = () => {
    setVolumes([...volumes, '']);
  };

  // Remove a volume
  const removeVolume = (index: number) => {
    const newVolumes = [...volumes];
    newVolumes.splice(index, 1);
    setVolumes(newVolumes);
  };

  // Handle extra args changes
  const handleExtraArgChange = (index: number, value: string) => {
    const newExtraArgs = [...extraArgs];
    newExtraArgs[index] = value;
    setExtraArgs(newExtraArgs);
  };

  // Add a new extra arg
  const addExtraArg = () => {
    setExtraArgs([...extraArgs, '']);
  };

  // Remove an extra arg
  const removeExtraArg = (index: number) => {
    const newExtraArgs = [...extraArgs];
    newExtraArgs.splice(index, 1);
    setExtraArgs(newExtraArgs);
  };

  // Handle accordion expansion
  const handleAccordionChange = (panel: string) => (event: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedSections({
      ...expandedSections,
      [panel]: isExpanded
    });
  };

  // Handle form submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate required fields
    if (!config.name) {
      setMessage({ type: 'error', text: 'Server name is required' });
      return;
    }

    if (!config.image) {
      setMessage({ type: 'error', text: 'Docker image is required' });
      return;
    }

    // Create the final config object
    const finalConfig: MCPDockerConfig = {
      ...config as MCPDockerConfig,
      volumes: volumes.filter(v => v.trim() !== ''),
      extraArgs: extraArgs.filter(a => a.trim() !== '')
    };

    // Add or update the server
    if (initialConfig) {
      onUpdate?.(finalConfig);
    } else {
      onAdd(finalConfig);
    }

    // Close the modal
    onClose();
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ width: '100%' }}>
      <Stack spacing={3}>
        {/* Basic Configuration Section */}
        <Accordion 
          expanded={expandedSections.basic} 
          onChange={handleAccordionChange('basic')}
          sx={{
            border: 1,
            borderColor: 'divider',
            '&:before': { display: 'none' },
            borderRadius: 1,
            boxShadow: theme => theme.palette.mode === 'dark' ? 1 : 0,
            mb: 2,
            overflow: 'hidden'
          }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            aria-controls="basic-config-content"
            id="basic-config-header"
            sx={{
              '& .MuiAccordionSummary-content': {
                alignItems: 'center'
              },
              minHeight: 56,
              px: 2
            }}
          >
            <Typography variant="h6" sx={{ fontWeight: 500 }}>
              Basic Configuration
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 3, py: 2 }}>
            <Stack spacing={3}>
              {/* Server Name */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Server Name
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  value={config.name || ''}
                  onChange={e => handleChange('name', e.target.value)}
                  placeholder="my-docker-mcp-server"
                  variant="outlined"
                  required
                />
              </Box>

              {/* Docker Image */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Docker Image
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  value={config.image || ''}
                  onChange={e => handleChange('image', e.target.value)}
                  placeholder="ghcr.io/github/github-mcp-server"
                  variant="outlined"
                  required
                  helperText="Docker image name (e.g., 'ghcr.io/github/github-mcp-server')"
                />
              </Box>

              {/* Container Name (Optional) */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Container Name (Optional)
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  value={config.containerName || ''}
                  onChange={e => handleChange('containerName', e.target.value)}
                  placeholder="my-mcp-container"
                  variant="outlined"
                  helperText="Optional custom container name"
                />
              </Box>

              {/* Transport Method */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Transport Method
                </Typography>
                <FormControl component="fieldset">
                  <RadioGroup
                    row
                    value={config.transportMethod || 'stdio'}
                    onChange={e => handleChange('transportMethod', e.target.value)}
                  >
                    <FormControlLabel value="stdio" control={<Radio />} label="STDIO" />
                    <FormControlLabel value="websocket" control={<Radio />} label="WebSocket" />
                  </RadioGroup>
                </FormControl>
              </Box>

              {/* WebSocket Port (Only if transportMethod is websocket) */}
              {config.transportMethod === 'websocket' && (
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    WebSocket Port
                  </Typography>
                  <TextField
                    fullWidth
                    size="small"
                    type="number"
                    value={config.websocketPort || ''}
                    onChange={e => handleChange('websocketPort', parseInt(e.target.value, 10))}
                    placeholder="8080"
                    variant="outlined"
                    required
                    helperText="Port for WebSocket connection"
                  />
                </Box>
              )}
            </Stack>
          </AccordionDetails>
        </Accordion>

        {/* Advanced Configuration Section */}
        <Accordion 
          expanded={expandedSections.advanced} 
          onChange={handleAccordionChange('advanced')}
          sx={{
            border: 1,
            borderColor: 'divider',
            '&:before': { display: 'none' },
            borderRadius: 1,
            boxShadow: theme => theme.palette.mode === 'dark' ? 1 : 0,
            mb: 2,
            overflow: 'hidden'
          }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            aria-controls="advanced-config-content"
            id="advanced-config-header"
            sx={{
              '& .MuiAccordionSummary-content': {
                alignItems: 'center'
              },
              minHeight: 56,
              px: 2
            }}
          >
            <Typography variant="h6" sx={{ fontWeight: 500 }}>
              Advanced Configuration
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 3, py: 2 }}>
            <Stack spacing={3}>
              {/* Network Mode */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Network Mode (Optional)
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  value={config.networkMode || ''}
                  onChange={e => handleChange('networkMode', e.target.value)}
                  placeholder="host"
                  variant="outlined"
                  helperText="Optional network mode (e.g., 'host', 'bridge')"
                />
              </Box>

              {/* Volumes */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Volumes
                </Typography>
                {volumes.map((volume, index) => (
                  <Box key={index} sx={{ display: 'flex', mb: 1 }}>
                    <TextField
                      fullWidth
                      size="small"
                      value={volume}
                      onChange={e => handleVolumeChange(index, e.target.value)}
                      placeholder="/host/path:/container/path"
                      variant="outlined"
                      sx={{ mr: 1 }}
                    />
                    <IconButton 
                      onClick={() => removeVolume(index)}
                      color="error"
                      size="small"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Box>
                ))}
                <Button
                  startIcon={<AddIcon />}
                  onClick={addVolume}
                  variant="outlined"
                  size="small"
                  sx={{ mt: 1 }}
                >
                  Add Volume
                </Button>
              </Box>

              {/* Extra Args */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Additional Docker Run Arguments
                </Typography>
                {extraArgs.map((arg, index) => (
                  <Box key={index} sx={{ display: 'flex', mb: 1 }}>
                    <TextField
                      fullWidth
                      size="small"
                      value={arg}
                      onChange={e => handleExtraArgChange(index, e.target.value)}
                      placeholder="--gpus all"
                      variant="outlined"
                      sx={{ mr: 1 }}
                    />
                    <IconButton 
                      onClick={() => removeExtraArg(index)}
                      color="error"
                      size="small"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Box>
                ))}
                <Button
                  startIcon={<AddIcon />}
                  onClick={addExtraArg}
                  variant="outlined"
                  size="small"
                  sx={{ mt: 1 }}
                >
                  Add Argument
                </Button>
              </Box>
            </Stack>
          </AccordionDetails>
        </Accordion>
      </Stack>

      {message && (
        <Box sx={{ mt: 2, mb: 2 }}>
          <Alert severity={message.type}>
            {message.text}
          </Alert>
        </Box>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button
          variant="outlined"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          color="primary"
        >
          {initialConfig ? 'Update Server' : 'Add Server'}
        </Button>
      </Box>
    </Box>
  );
};

export default DockerTab;
