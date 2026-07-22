'use client';

import React, { useState } from 'react';
import { TabProps, MessageState } from '../../types';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';
import { mcpService } from '@/frontend/services/mcp';
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
  // When the probe detects OAuth, we pause before switching tabs to show a one-time note,
  // so the user understands they'll sign in (rather than hand-enter a header) on the next
  // screen. A second click ("Continue to setup") then proceeds.
  const [oauthDetected, setOauthDetected] = useState<boolean>(false);

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

  const proceedToLocalTab = () => {
    // Extract server name from URL
    const serverName = extractServerName(url);

    // Create a streamable config with the URL. The server root dir defaults to a
    // dedicated per-server folder (like stdio servers), NOT '/': rootPath feeds the
    // folder pickers, ServerCard actions and the git-update route, so a filesystem
    // root would be an overly wide default scope (issue 52).
    const remoteConfig: Partial<MCPServerConfig> = {
      name: serverName,
      transport: 'streamable',
      serverUrl: url,
      rootPath: `mcp-servers/${serverName}`,
      disabled: false,
      autoApprove: [],
      env: {},
      _buildCommand: '',
      _installCommand: '',
      // Install-origin (#193): a hosted endpoint — serverUrl is the reference.
      source: { type: 'remote' }
    };

    // Pass the config to the parent component before switching tabs
    if (onUpdate) {
      onUpdate(remoteConfig as MCPServerConfig);
    }

    // Switch to the local tab with pre-filled data
    if (setActiveTab) {
      setActiveTab('local');
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

    // Second click after an OAuth note — the user has read it; proceed.
    if (oauthDetected) {
      proceedToLocalTab();
      return;
    }

    setIsValidating(true);
    setMessage({
      type: 'success',
      text: 'Checking the server…'
    });

    try {
      // Probe for OAuth before handing off, so the user knows up front that this server
      // signs in via OAuth (rather than a static header). Best-effort — a failed probe
      // just proceeds to the normal setup flow.
      const probe = await mcpService.probeOAuthCapability(url);
      if (probe.oauthCapable) {
        setOauthDetected(true);
        setMessage({
          type: 'success',
          text: 'This server uses OAuth. Continue to setup, then run Test Run and click "Save & Authenticate" to sign in.'
        });
        setIsValidating(false);
        return;
      }

      proceedToLocalTab();
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
    // A changed URL invalidates the prior OAuth probe result.
    setOauthDetected(false);
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
            {isValidating ? 'Checking…' : oauthDetected ? 'Continue to setup' : 'Connect'}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
};

export default RemoteTab;
