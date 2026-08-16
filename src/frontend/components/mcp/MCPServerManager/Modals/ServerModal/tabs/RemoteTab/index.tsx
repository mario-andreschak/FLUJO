'use client';

import React, { useState } from 'react';
import { TabProps, MessageState } from '../../types';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';
import { MCPSamplingPolicy } from '@/shared/types/mcp';
import { mcpService } from '@/frontend/services/mcp';
import {
  Alert,
  Box,
  Button,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import SamplingManager from '../ConfigureTab/SamplingManager';
import { useI18n } from '@/frontend/contexts/I18nContext';

const RemoteTab: React.FC<TabProps> = ({
  onAdd,
  onClose,
  onHandoff
}) => {
  const { t } = useI18n();
  const [url, setUrl] = useState<string>('');
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  // When the probe detects OAuth, we pause before switching tabs to show a one-time note,
  // so the user understands they'll sign in (rather than hand-enter a header) on the next
  // screen. A second click ("Continue to setup") then proceeds.
  const [oauthDetected, setOauthDetected] = useState<boolean>(false);
  // Sampling policy configured here is forwarded to ConfigureTab via the remoteConfig.
  const [samplingPolicy, setSamplingPolicy] = useState<MCPSamplingPolicy | undefined>(undefined);

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
      env: {},
      _buildCommand: '',
      _installCommand: '',
      // Install-origin (#193): a hosted endpoint — serverUrl is the reference.
      source: { type: 'remote' },
      // Forward any sampling policy configured on this tab.
      ...(samplingPolicy ? { sampling: samplingPolicy } : {}),
    };

    // The URL is already a complete runnable config. Use the same streamlined
    // handoff as Marketplace: Configure collapses the prefilled sections, tests
    // immediately, then leaves Save as the only action when the probe succeeds.
    if (onHandoff) {
      onHandoff({
        to: 'configure',
        config: remoteConfig as MCPServerConfig,
        autoTestRun: true,
      });
    }
  };

  const handleConnect = async () => {
    if (!isUrlValid) {
      setMessage({
        type: 'error',
        text: t('mcp.remote.invalidUrl')
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
      text: t('mcp.remote.checkingServer')
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
          text: t('mcp.remote.oauthDetected')
        });
        setIsValidating(false);
        return;
      }

      proceedToLocalTab();
      setMessage({
        type: 'success',
        text: t('mcp.remote.switching')
      });

    } catch (error) {
      console.error('Error processing remote URL:', error);
      setMessage({
        type: 'error',
        text: t('mcp.remote.processingError', {
          error: error instanceof Error ? error.message : t('mcp.server.unknownError'),
        })
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
          {t('mcp.remote.title')}
        </Typography>
        
        <Typography variant="body2" color="text.secondary">
          {t('mcp.remote.help')}
        </Typography>

        <Box>
          <Typography variant="subtitle2" gutterBottom>
            {t('mcp.remote.url')}
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
                ? t('mcp.remote.invalidUrl')
                : t('mcp.remote.urlHelp')
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

        <Divider />

        <Box>
          <Typography variant="subtitle2" gutterBottom>
            {t('mcp.remote.sampling')}
          </Typography>
          <SamplingManager
            policy={samplingPolicy}
            onChange={setSamplingPolicy}
          />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          <Button
            variant="outlined"
            onClick={onClose}
            disabled={isValidating}
          >
            {t('mcp.remote.cancel')}
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={handleConnect}
            disabled={!isUrlValid || isValidating}
          >
            {isValidating
              ? t('mcp.remote.checking')
              : oauthDetected
                ? t('mcp.remote.continue')
                : t('mcp.remote.connect')}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
};

export default RemoteTab;
