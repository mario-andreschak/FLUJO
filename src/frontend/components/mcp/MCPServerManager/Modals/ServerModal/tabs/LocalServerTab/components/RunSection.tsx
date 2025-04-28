'use client';

import React from 'react';
import { MCPServerConfig, EnvVarValue } from '@/shared/types/mcp/mcp';
import { MessageState } from '../../../types';
import RunTools from '../RunTools';
import ArgumentsManager from '../ArgumentsManager';
import SectionHeader from './SectionHeader';

interface RunSectionProps {
  localConfig: MCPServerConfig;
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
  serverName: string;
  consoleOutput: string;
  message: MessageState | null;
  setMessage: (message: MessageState | null) => void;
  handleArgChange: (index: number, value: string) => void;
  addArgField: () => void;
  removeArgField: (index: number) => void;
  onFolderSelect: (index: number) => void;
  onParseReadme: () => Promise<void>;
  onParseClipboard: () => Promise<void>;
  isParsingReadme: boolean;
  isExpanded: boolean;
  toggleSection: () => void;
}

const RunSection: React.FC<RunSectionProps> = ({
  localConfig,
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
  serverName,
  consoleOutput,
  message,
  setMessage,
  handleArgChange,
  addArgField,
  removeArgField,
  onFolderSelect,
  onParseReadme,
  onParseClipboard,
  isParsingReadme,
  isExpanded,
  toggleSection
}) => {
  // Determine section status based on run state
  const getSectionStatus = () => {
    if (message?.type === 'error' && !isRunning) {
      return 'error';
    } else if (runCompleted) {
      return 'success';
    } else if (isRunning) {
      return 'loading';
    }
    return 'default';
  };

  return (
    <div className={`bg-gray-50 dark:bg-gray-800 border rounded-lg p-4 mb-6
      ${message?.type === 'error' && !isRunning ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20' : 
        runCompleted ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20' : 
        isRunning ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20' :
        'border-gray-200 dark:border-gray-700'}`}>
      <SectionHeader
        title="Third, define how to run your server"
        isExpanded={isExpanded}
        onToggle={toggleSection}
        status={getSectionStatus()}
      />
      
      {isExpanded && (
        <div className="space-y-6">
          <RunTools
            command={command}
            setCommand={setCommand}
            transport={transport}
            setTransport={setTransport}
            websocketUrl={websocketUrl}
            setWebsocketUrl={setWebsocketUrl}
            serverUrl={serverUrl}
            setServerUrl={setServerUrl}
            onRun={onRun}
            isRunning={isRunning}
            runCompleted={runCompleted}
            env={env}
            onEnvChange={onEnvChange}
            serverName={serverName}
            consoleOutput={consoleOutput}
            message={message}
            setMessage={setMessage}
          />
          
          <div className="mt-6">
            <h4 className="text-md font-medium mb-4">Arguments</h4>
            <ArgumentsManager
              args={localConfig.transport === 'stdio' ? (localConfig as any).args || [] : []}
              onArgChange={handleArgChange}
              onAddArg={addArgField}
              onRemoveArg={removeArgField}
              onFolderSelect={onFolderSelect}
              onParseReadme={onParseReadme}
              onParseClipboard={onParseClipboard}
              isParsingReadme={isParsingReadme}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default RunSection;
