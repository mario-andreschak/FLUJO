'use client';

import React, { useEffect } from 'react';
import EnvEditor from '@/frontend/components/mcp/MCPEnvManager/EnvEditor';
import HeadersEditor from './HeadersEditor';
import OAuthCredentialsEditor from './OAuthCredentialsEditor';
import { MessageState } from '../../types';
import { EnvVarValue, MCPHeaderValue } from '@/shared/types/mcp/mcp';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormHelperText,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography
} from '@mui/material';
import LoginIcon from '@mui/icons-material/Login';
import { isPackageRunnerCommand } from '@/utils/mcp/resolveServerCwd';
import { RUNNER_TEST_CONNECTION_TIMEOUT_MS } from '@/utils/mcp/testConnectionTimeout';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface RunToolsProps {
  command: string;
  setCommand: (command: string) => void;
  transport: 'stdio' | 'websocket' | 'sse' | 'streamable';
  setTransport: (transport: 'stdio' | 'websocket' | 'sse' | 'streamable') => void;
  websocketUrl: string;
  setWebsocketUrl: (url: string) => void;
  serverUrl: string;
  setServerUrl: (url: string) => void;
  onRun: () => Promise<void>;
  isRunning: boolean;
  runCompleted: boolean;
  env: Record<string, EnvVarValue>;
  onEnvChange: (env: Record<string, EnvVarValue>) => void;
  headers?: Record<string, MCPHeaderValue>;
  onHeadersChange?: (headers: Record<string, MCPHeaderValue>) => void;
  oauthClientId?: string;
  oauthClientSecret?: string;
  onOAuthClientIdChange?: (clientId: string) => void;
  onOAuthClientSecretChange?: (clientSecret: string) => void;
  serverName: string;
  consoleOutput: string;
  message: MessageState | null;
  setMessage: (message: MessageState | null) => void;
  /** Test Run detected a reachable OAuth (RFC 9728) streamable server. */
  oauthCapable?: boolean;
  /** Persist the server and start its OAuth flow (shown when oauthCapable). */
  onSaveAndAuthenticate?: () => Promise<void> | void;
  isAuthenticating?: boolean;
}

const RunTools: React.FC<RunToolsProps> = ({
  command,
  setCommand,
  transport,
  setTransport,
  websocketUrl,
  setWebsocketUrl,
  serverUrl,
  setServerUrl,
  onRun,
  isRunning,
  runCompleted,
  env,
  onEnvChange,
  headers = {},
  onHeadersChange,
  oauthClientId = '',
  oauthClientSecret = '',
  onOAuthClientIdChange,
  onOAuthClientSecretChange,
  serverName,
  consoleOutput,
  message,
  setMessage,
  oauthCapable = false,
  onSaveAndAuthenticate,
  isAuthenticating = false
}) => {
  const { t, formatNumber } = useI18n();
  // Check for MODULE_NOT_FOUND in console output
  useEffect(() => {
    if (consoleOutput.includes("MODULE_NOT_FOUND")) {
      setMessage({
        type: 'error',
        text: t('mcp.local.run.moduleNotFound')
      });
    }
  }, [consoleOutput, setMessage, t]);
  
  // URL validation
  const isValidWebsocketUrl = (url: string): boolean => {
    if (!url) return false;
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'ws:' || urlObj.protocol === 'wss:';
    } catch (e) {
      return false;
    }
  };

  const isValidHttpUrl = (url: string): boolean => {
    if (!url) return false;
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch (e) {
      return false;
    }
  };

  const isWebsocketUrlValid = transport !== 'websocket' || isValidWebsocketUrl(websocketUrl);
  const isServerUrlValid = (transport !== 'sse' && transport !== 'streamable') || isValidHttpUrl(serverUrl);

  // Non-blocking security hint: ws:// is fine for localhost, but remote
  // servers should use wss:// so traffic is encrypted in transit.
  const isLocalhostHost = (hostname: string): boolean => {
    const host = hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
  };

  const isInsecureRemoteWebsocket = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'ws:' && !isLocalhostHost(urlObj.hostname);
    } catch (e) {
      return false;
    }
  };

  const showInsecureWebsocketWarning =
    transport === 'websocket' && isWebsocketUrlValid && isInsecureRemoteWebsocket(websocketUrl);

  // Detect a package-runner command (npx/uvx/bunx/pnpm dlx). Its first run may need to
  // download the package before the MCP handshake starts, so the Test Run allows a longer
  // timeout (issue #43) — surface that up front so a slow first start isn't mistaken for
  // a frozen modal.
  const commandTokens = command.trim().split(/\s+/).filter(Boolean);
  const isRunnerCommand =
    transport === 'stdio' &&
    commandTokens.length > 0 &&
    isPackageRunnerCommand(commandTokens[0], commandTokens.slice(1));
  const runnerTimeoutSeconds = Math.round(RUNNER_TEST_CONNECTION_TIMEOUT_MS / 1000);

  return (
    <Stack spacing={3}>
      {/* Error message display */}
      {message && message.type === 'error' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {message.text}
        </Alert>
      )}
      
      {/* Transport selection tabs */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          {t('mcp.local.run.transport')}
        </Typography>
        <Tabs 
          value={transport} 
          onChange={(e, newValue) => setTransport(newValue)}
          sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab label={t('mcp.server.transport.stdio')} value="stdio" />
          <Tab label={t('mcp.server.transport.websocket')} value="websocket" />
          <Tab label={t('mcp.server.transport.sse')} value="sse" />
          <Tab label={t('mcp.server.transport.streamable')} value="streamable" />
        </Tabs>
      </Box>

      {/* WebSocket URL input (only shown when websocket transport is selected) */}
      {transport === 'websocket' && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            {t('mcp.local.run.websocketUrl')}
          </Typography>
          <TextField
            fullWidth
            size="small"
            value={websocketUrl}
            onChange={e => setWebsocketUrl(e.target.value)}
            placeholder="ws://localhost:3000"
            variant="outlined"
            required
            error={!isWebsocketUrlValid}
            helperText={!isWebsocketUrlValid && t('mcp.local.run.invalidWebsocket')}
          />
          {showInsecureWebsocketWarning && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              {t('mcp.local.run.insecureWebsocket')}
            </Alert>
          )}
        </Box>
      )}

      {/* Server URL input (only shown when sse or streamable transport is selected) */}
      {(transport === 'sse' || transport === 'streamable') && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            {t('mcp.local.run.serverUrl')}
          </Typography>
          <TextField
            fullWidth
            size="small"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            placeholder="https://localhost:3000"
            variant="outlined"
            required
            error={!isServerUrlValid}
            helperText={!isServerUrlValid && t('mcp.local.run.invalidHttp')}
          />
        </Box>
      )}

      {/* Custom HTTP headers (only shown for sse or streamable transports) */}
      {(transport === 'sse' || transport === 'streamable') && (
        <Box>
          <HeadersEditor headers={headers} onChange={onHeadersChange || (() => {})} />
        </Box>
      )}

      {/* OAuth client credentials (only shown for sse or streamable transports) */}
      {(transport === 'sse' || transport === 'streamable') && (
        <Box>
          <OAuthCredentialsEditor
            clientId={oauthClientId}
            clientSecret={oauthClientSecret}
            onClientIdChange={onOAuthClientIdChange || (() => {})}
            onClientSecretChange={onOAuthClientSecretChange || (() => {})}
          />
        </Box>
      )}

      {/* Run Command input (only shown when stdio transport is selected) */}
      {transport === 'stdio' && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            {t('mcp.local.run.command')}
          </Typography>
          <TextField
            fullWidth
            size="small"
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder="npm start"
            variant="outlined"
            required
          />
          {isRunnerCommand && (
            <FormHelperText>
              {t('mcp.local.run.runnerTimeout', { seconds: formatNumber(runnerTimeoutSeconds) })}
            </FormHelperText>
          )}
        </Box>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
        <Button
          variant="contained"
          color={runCompleted ? "success" : "primary"}
          onClick={onRun}
          startIcon={isRunning ? <CircularProgress size={16} color="inherit" /> : undefined}
          disabled={isRunning || 
                  (transport === 'stdio' && !command.trim()) || 
                  (transport === 'websocket' && !isWebsocketUrlValid) || 
                  ((transport === 'sse' || transport === 'streamable') && !isServerUrlValid)}
          title={(transport === 'stdio' && !command.trim()) ? t('mcp.local.run.enterCommand') :
                (transport === 'websocket' && !isWebsocketUrlValid) ? t('mcp.local.run.validWebsocket') :
                ((transport === 'sse' || transport === 'streamable') && !isServerUrlValid) ? t('mcp.local.run.validServer') :
                t('mcp.local.run.testHelp')}
        >
          {isRunning ? t('mcp.local.run.running') : t('mcp.local.run.test')}
        </Button>
      </Box>

      {/* OAuth affordance: shown after a Test Run finds a reachable streamable server that
          advertises OAuth. "Save & Authenticate" persists the server (OAuth binds tokens by
          server name) and opens the provider's sign-in, so the user need not save, hunt for
          the card banner, and click Authenticate separately. */}
      {oauthCapable && (transport === 'sse' || transport === 'streamable') && onSaveAndAuthenticate && (
        <Alert
          severity="info"
          action={
            <Button
              color="inherit"
              size="small"
              variant="outlined"
              startIcon={isAuthenticating ? <CircularProgress size={16} color="inherit" /> : <LoginIcon />}
              onClick={() => { void onSaveAndAuthenticate(); }}
              disabled={isAuthenticating || !isServerUrlValid}
            >
              {isAuthenticating ? t('mcp.local.run.authenticating') : t('mcp.local.run.saveAuthenticate')}
            </Button>
          }
        >
          {t('mcp.local.run.oauthHelp')}
        </Alert>
      )}

      <Box>
        <EnvEditor
          serverName={serverName}
          initialEnv={env}
          onSave={async (updatedEnv) => {
            onEnvChange(updatedEnv);
            return Promise.resolve();
          }}
        />
      </Box>
    </Stack>
  );
};

export default RunTools;
