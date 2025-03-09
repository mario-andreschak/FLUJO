'use client';

import React, { useEffect } from 'react';
import EnvEditor from '@/frontend/components/mcp/MCPEnvManager/EnvEditor';
import Alert from '@mui/material/Alert';
import { MessageState } from '../../types';

interface RunToolsProps {
  command: string;
  setCommand: (command: string) => void;
  transport: 'stdio' | 'websocket';
  setTransport: (transport: 'stdio' | 'websocket') => void;
  websocketUrl: string;
  setWebsocketUrl: (url: string) => void;
  onRun: () => Promise<void>;
  isRunning: boolean;
  runCompleted: boolean;
  env: Record<string, string>;
  onEnvChange: (env: Record<string, string>) => void;
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
    <div className="space-y-6">
      {/* Error message display */}
      {message && message.type === 'error' && (
        <div className="mb-4">
          <Alert severity="error">
            {message.text}
          </Alert>
        </div>
      )}
      {/* Transport selection tabs */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">Transport Type</label>
        <div className="flex border-b">
          <button
            type="button"
            className={`py-2 px-4 ${transport === 'stdio' ? 'border-b-2 border-blue-500 text-blue-500' : 'text-gray-500'}`}
            onClick={() => setTransport('stdio')}
          >
            Standard IO
          </button>
          <button
            type="button"
            className={`py-2 px-4 ${transport === 'websocket' ? 'border-b-2 border-blue-500 text-blue-500' : 'text-gray-500'}`}
            onClick={() => setTransport('websocket')}
          >
            WebSocket
          </button>
        </div>
      </div>

      {/* WebSocket URL input (only shown when websocket transport is selected) */}
      {transport === 'websocket' && (
        <div>
          <label className="block text-sm font-medium mb-1">
            WebSocket URL
          </label>
          <input
            type="text"
            value={websocketUrl}
            onChange={e => setWebsocketUrl(e.target.value)}
            className={`w-full px-3 py-2 border rounded-lg ${!isWebsocketUrlValid ? 'border-red-500' : ''}`}
            placeholder="ws://localhost:3000"
            required
          />
          {!isWebsocketUrlValid && (
            <p className="text-red-500 text-sm mt-1">
              Please enter a valid WebSocket URL (starting with ws:// or wss://)
            </p>
          )}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium mb-1">
          Run Command
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={command}
            onChange={e => setCommand(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg"
            placeholder="npm start"
            required
          />
          <button
            type="button"
            onClick={onRun}
            disabled={isRunning || !command.trim() || (transport === 'websocket' && !isWebsocketUrlValid)}
            className={`px-4 py-2 ${runCompleted ? 'bg-green-500' : !command.trim() || (transport === 'websocket' && !isWebsocketUrlValid) ? 'bg-gray-400' : 'bg-blue-500'} text-white rounded-lg`}
            title={!command.trim() ? 'Please enter a run command first' : (transport === 'websocket' && !isWebsocketUrlValid) ? 'Please enter a valid WebSocket URL' : 'Test the run command'}
          >
            {isRunning ? 'Running...' : 'Test Run'}
          </button>
        </div>
      </div>
      
      <EnvEditor
        serverName={serverName}
        initialEnv={env}
        onSave={async (updatedEnv) => {
          onEnvChange(updatedEnv);
          return Promise.resolve();
        }}
      />
    </div>
  );
};

export default RunTools;
