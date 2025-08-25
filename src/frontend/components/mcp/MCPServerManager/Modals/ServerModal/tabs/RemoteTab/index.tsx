'use client';

import React, { useState } from 'react';
import { TabProps, MessageState } from '../../types';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';
import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material';

const RemoteTab: React.FC<TabProps> = ({
  onAdd,
  onClose,
  setActiveTab,
  onUpdate
}) => {
  const [url, setUrl] = useState<string>('');
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [message, setMessage] = useState<MessageState | null>(null);

  // URL validation
  const isValidHttpUrl = (url: string): boolean => {
    if (!url) return false;
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch (e) {
      return false;
    }
  };

  const isUrlValid = isValidHttpUrl(url);

  // Extract server name from URL
  const extractServerName = (url: string): string => {
    try {
      const urlObj = new URL(url);
      // Use hostname without port as server name
      return urlObj.hostname.replace(/\./g, '-');
    } catch (e) {
      return 'remote-server';
    }
  };

  const handleConnect = async () => {
    if (!isUrlValid) {
      setMessage({
        type: 'error',
        text: 'Please enter a valid HTTP or HTTPS URL'
      });
      return;
    }

    setIsValidating(true);
    setMessage({
      type: 'success',
      text: 'Validating URL...'
    });

    try {
      // Extract server name from URL
      const serverName = extractServerName(url);
      
      // Create a streamable config with the URL
      const remoteConfig: Partial<MCPServerConfig> = {
        name: serverName,
        transport: 'streamable',
        serverUrl: url,
        rootPath: '/',
        disabled: false,
        autoApprove: [],
        env: {},
        _buildCommand: '',
        _installCommand: ''
      };

      // Pass the config to the parent component before switching tabs
      if (onUpdate) {
        onUpdate(remoteConfig as MCPServerConfig);
      }

      // Switch to the local tab with pre-filled data
      if (setActiveTab) {
        setActiveTab('local');
      }

      setMessage({
        type: 'success',
        text: 'Switching to Local Server tab with pre-filled configuration...'
      });

    } catch (error) {
      console.error('Error processing remote URL:', error);
      setMessage({
        type: 'error',
        text: `Error processing URL: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    } finally {
      setIsValidating(false);
    }
  };

  const handleUrlChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUrl(event.target.value);
    // Clear any previous messages when user starts typing
    if (message) {
      setMessage(null);
    }
  };

  return (
    <Paper elevation={0} sx={{ p: 0 }}>
      <Stack spacing={3}>
        <Typography variant="h6" gutterBottom>
          Connect to Remote MCP Server
        </Typography>
        
        <Typography variant="body2" color="text.secondary">
          Enter the URL of a remote MCP server that supports HTTP streaming. 
          The server configuration will be automatically set up for you.
        </Typography>

        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Server URL
          </Typography>
          <TextField
            fullWidth
            size="small"
            value={url}
            onChange={handleUrlChange}
            placeholder="https://example.com/mcp"
            variant="outlined"
            required
            error={url.length > 0 && !isUrlValid}
            helperText={
              url.length > 0 && !isUrlValid 
                ? "Please enter a valid HTTP or HTTPS URL" 
                : "Enter the full URL to the MCP server endpoint"
            }
            disabled={isValidating}
          />
        </Box>

        {message && (
          <Box>
            <Alert severity={message.type}>
              {message.text}
            </Alert>
          </Box>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            variant="outlined"
            onClick={onClose}
            disabled={isValidating}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={handleConnect}
            disabled={!isUrlValid || isValidating}
          >
            {isValidating ? 'Connecting...' : 'Connect'}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
};

export default RemoteTab;
