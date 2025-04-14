'use client';

import React, { useEffect } from 'react';
import EnvEditor from '@/frontend/components/mcp/MCPEnvManager/EnvEditor';
import { MessageState } from '../../types';
import { EnvVarValue } from '@/shared/types/mcp/mcp';
import {
  Alert,
  Box,
  Button,
  FormHelperText,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography
} from '@mui/material';

interface RunToolsProps {
  command: string;
  setCommand: (command: string) => void;
  transport: 'stdio' | 'websocket' | 'streamableHttp' | 'httpSse';
  setTransport: (transport: 'stdio' | 'websocket' | 'streamableHttp' | 'httpSse') => void;
  websocketUrl: string;
  setWebsocketUrl: (url: string) => void;
  endpoint?: string;
  setEndpoint?: (endpoint: string) => void;
  sseEndpoint?: string;
  setSseEndpoint?: (endpoint: string) => void;
  messageEndpoint?: string;
  setMessageEndpoint?: (endpoint: string) => void;
  onRun: () => Promise<void>;
  isRunning: boolean;
  runCompleted: boolean;
  env: Record<string, EnvVarValue>;
  onEnvChange: (env: Record<string, EnvVarValue>) => void;
  serverName: string;
  consoleOutput: string;
  message: MessageState | null;
  setMessage: (message: MessageState | null) => void;
}

const RunTools: React.FC<RunToolsProps> = ({
  command,
  setCommand,
  transport,
  setTransport,
  websocketUrl,
  setWebsocketUrl,
  endpoint,
  setEndpoint,
  sseEndpoint,
  setSseEndpoint,
  messageEndpoint,
  setMessageEndpoint,
  onRun,
  isRunning,
  runCompleted,
  env,
  onEnvChange,
  serverName,
  consoleOutput,
  message,
  setMessage
}) => {
  // Check for MODULE_NOT_FOUND in console output
  useEffect(() => {
    if (consoleOutput.includes("MODULE_NOT_FOUND")) {
      setMessage({
        type: 'error',
        text: 'Module not found error detected. Please check the paths defined in the Arguments!'
      });
    }
  }, [consoleOutput, setMessage]);
  
  // Basic URL validation
  const isValidWebsocketUrl = (url: string): boolean => {
    if (!url) return false;
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'ws:' || urlObj.protocol === 'wss:';
    } catch (e) {
      return false;
    }
  };

  const isWebsocketUrlValid = transport !== 'websocket' || isValidWebsocketUrl(websocketUrl);

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
          Transport Type
        </Typography>
        <Tabs 
          value={transport} 
          onChange={(e, newValue) => setTransport(newValue)}
          sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab label="Standard IO" value="stdio" />
          <Tab label="WebSocket" value="websocket" />
          <Tab label="Streamable HTTP" value="streamableHttp" />
          <Tab label="HTTP+SSE (Legacy)" value="httpSse" />
        </Tabs>
      </Box>

      {/* WebSocket URL input (only shown when websocket transport is selected) */}
      {transport === 'websocket' && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            WebSocket URL
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
            helperText={!isWebsocketUrlValid && "Please enter a valid WebSocket URL (starting with ws:// or wss://)"}
          />
        </Box>
      )}

      {/* Streamable HTTP endpoint input */}
      {transport === 'streamableHttp' && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            HTTP Endpoint
          </Typography>
          <TextField
            fullWidth
            size="small"
            value={endpoint || ''}
            onChange={e => setEndpoint && setEndpoint(e.target.value)}
            placeholder="http://localhost:3000/mcp"
            variant="outlined"
            required
            helperText="The HTTP endpoint for the Streamable HTTP transport"
          />
        </Box>
      )}

      {/* HTTP+SSE (Legacy) endpoints input */}
      {transport === 'httpSse' && (
        <>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              SSE Endpoint
            </Typography>
            <TextField
              fullWidth
              size="small"
              value={sseEndpoint || ''}
              onChange={e => setSseEndpoint && setSseEndpoint(e.target.value)}
              placeholder="http://localhost:3000/sse"
              variant="outlined"
              required
              helperText="The SSE endpoint for receiving messages"
            />
          </Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Message Endpoint
            </Typography>
            <TextField
              fullWidth
              size="small"
              value={messageEndpoint || ''}
              onChange={e => setMessageEndpoint && setMessageEndpoint(e.target.value)}
              placeholder="http://localhost:3000/messages"
              variant="outlined"
              required
              helperText="The HTTP endpoint for sending messages"
            />
          </Box>
        </>
      )}

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Run Command
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
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
          <Button
            variant="contained"
            color={runCompleted ? "success" : "primary"}
            onClick={onRun}
            disabled={isRunning || !command.trim() || (transport === 'websocket' && !isWebsocketUrlValid)}
            title={!command.trim() ? 'Please enter a run command first' : (transport === 'websocket' && !isWebsocketUrlValid) ? 'Please enter a valid WebSocket URL' : 'Test the run command'}
          >
            {isRunning ? 'Running...' : '3) Test Run'}
          </Button>
        </Box>
      </Box>
      
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
