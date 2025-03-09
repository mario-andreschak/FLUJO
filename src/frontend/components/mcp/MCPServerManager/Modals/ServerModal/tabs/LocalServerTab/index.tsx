'use client';

import React from 'react';
import Alert from '@mui/material/Alert';
import { TabProps } from '../../types';
import { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp/mcp';
import ConsoleOutput from './ConsoleOutput';
import { useLocalServerState } from './hooks/useLocalServerState';
import { useConsoleOutput } from './hooks/useConsoleOutput';
import DefineServerSection from './components/DefineServerSection';
import BuildSection from './components/BuildSection';
import RunSection from './components/RunSection';
import ConsoleToggle from './components/ConsoleToggle';
import { 
  handleSubmit,
  handleRootPathSelect,
  handleFolderSelect,
  handleParseClipboard,
  handleParseEnvClipboard,
  handleParseEnvExample,
  handleParseReadme,
  handleInstall,
  handleBuild,
  handleRun
} from './utils/formHandlers';

const LocalServerTab: React.FC<TabProps> = ({
  initialConfig,
  onAdd,
  onUpdate,
  onClose
}) => {
  // Use custom hooks for state management
  const {
    localConfig,
    setLocalConfig,
    websocketUrl,
    setWebsocketUrl,
    buildCommand,
    setBuildCommand,
    installCommand,
    setInstallCommand,
    message,
    setMessage,
    isBuilding,
    setIsBuilding,
    isInstalling,
    setIsInstalling,
    buildCompleted,
    setBuildCompleted,
    installCompleted,
    setInstallCompleted,
    isParsingReadme,
    setIsParsingReadme,
    isParsingEnv,
    setIsParsingEnv,
    isRunning,
    setIsRunning,
    runCompleted,
    setRunCompleted,
    expandedSections,
    toggleSection,
    handleTransportChange,
    handleArgChange,
    addArgField,
    removeArgField,
    handleEnvChange
  } = useLocalServerState({ initialConfig });

  // Use custom hook for console output
  const {
    consoleOutput,
    isConsoleVisible,
    consoleTitle,
    setConsoleTitle,
    toggleConsoleVisibility,
    setIsConsoleVisible,
    appendToConsole,
    clearConsole,
    updateConsole: setConsoleOutput
  } = useConsoleOutput();

  // Event handlers that use the form handlers utility functions
  const onSubmit = (e: React.FormEvent) => {
    handleSubmit(
      e,
      localConfig,
      websocketUrl,
      buildCommand,
      installCommand,
      setMessage,
      onAdd,
      onUpdate,
      initialConfig,
      onClose
    );
  };

  const onRootPathSelect = async () => {
    await handleRootPathSelect(localConfig, setLocalConfig);
  };

  const onFolderSelect = async (index: number) => {
    await handleFolderSelect(index, localConfig, handleArgChange);
  };

  const onParseClipboard = async () => {
    await handleParseClipboard(
      localConfig,
      setLocalConfig,
      setMessage,
      setBuildCommand,
      setInstallCommand,
      setWebsocketUrl,
      websocketUrl
    );
  };

  const onParseEnvClipboard = async () => {
    await handleParseEnvClipboard(
      localConfig,
      setLocalConfig,
      setMessage,
      setIsParsingEnv
    );
  };

  const onParseEnvExample = async () => {
    await handleParseEnvExample(
      localConfig,
      setLocalConfig,
      setMessage,
      setIsParsingEnv
    );
  };

  const onParseReadme = async () => {
    await handleParseReadme(
      localConfig,
      setLocalConfig,
      setMessage,
      setIsParsingReadme,
      setBuildCommand,
      setInstallCommand,
      setWebsocketUrl,
      websocketUrl
    );
  };

  const onInstall = async () => {
    await handleInstall(
      localConfig,
      installCommand,
      setIsInstalling,
      setMessage,
      setConsoleTitle,
      setIsConsoleVisible,
      setConsoleOutput,
      setInstallCompleted
    );
  };

  const onBuild = async () => {
    await handleBuild(
      localConfig,
      buildCommand,
      setIsBuilding,
      setMessage,
      setConsoleTitle,
      setIsConsoleVisible,
      setConsoleOutput,
      setBuildCompleted
    );
  };

  const onRun = async () => {
    await handleRun(
      localConfig,
      websocketUrl,
      setIsRunning,
      setConsoleTitle,
      setConsoleOutput,
      setIsConsoleVisible,
      setMessage,
      setRunCompleted
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex">
        <div className={`space-y-6 ${isConsoleVisible ? 'w-2/3 pr-4' : 'w-full'}`}>
          {/* Left column with form components */}
          <DefineServerSection
            localConfig={localConfig}
            setLocalConfig={setLocalConfig}
            isExpanded={expandedSections.define}
            toggleSection={() => toggleSection('define')}
            onRootPathSelect={onRootPathSelect}
          />
          
          <BuildSection
            installCommand={installCommand}
            setInstallCommand={setInstallCommand}
            buildCommand={buildCommand}
            setBuildCommand={setBuildCommand}
            onInstall={onInstall}
            onBuild={onBuild}
            isInstalling={isInstalling}
            isBuilding={isBuilding}
            installCompleted={installCompleted}
            buildCompleted={buildCompleted}
            isExpanded={expandedSections.build}
            toggleSection={() => toggleSection('build')}
          />
          
          <RunSection
            localConfig={localConfig}
            command={localConfig.transport === 'stdio' ? (localConfig as MCPStdioConfig).command : ''}
            setCommand={(command) => {
              if (localConfig.transport === 'stdio') {
                setLocalConfig(prev => {
                  if (prev.transport === 'stdio') {
                    return { ...prev, command };
                  }
                  return prev;
                });
              }
            }}
            transport={localConfig.transport as 'stdio' | 'websocket'}
            setTransport={handleTransportChange}
            websocketUrl={websocketUrl}
            setWebsocketUrl={setWebsocketUrl}
            onRun={onRun}
            isRunning={isRunning}
            runCompleted={runCompleted}
            env={localConfig.env}
            onEnvChange={handleEnvChange}
            serverName={localConfig.name}
            consoleOutput={consoleOutput}
            message={message}
            setMessage={setMessage}
            handleArgChange={handleArgChange}
            addArgField={addArgField}
            removeArgField={removeArgField}
            onFolderSelect={onFolderSelect}
            onParseReadme={onParseReadme}
            onParseClipboard={onParseClipboard}
            isParsingReadme={isParsingReadme}
            isExpanded={expandedSections.run}
            toggleSection={() => toggleSection('run')}
          />
        </div>
        
        {isConsoleVisible && (
          <div className="w-1/3 pl-4">
            {/* Right column with console output */}
            <ConsoleOutput
              output={consoleOutput}
              isVisible={true}
              toggleVisibility={toggleConsoleVisibility}
              title={consoleTitle}
            />
          </div>
        )}
      </div>

      {message && (
        <div className="mb-4">
          <Alert severity={message.type}>
            {message.text}
          </Alert>
        </div>
      )}

      <div className="flex justify-end space-x-2">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 border rounded-lg"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="px-4 py-2 bg-blue-500 text-white rounded-lg"
        >
          {initialConfig ? 'Update Server' : 'Add Server'}
        </button>
      </div>
    </form>
  );
};

export default LocalServerTab;
