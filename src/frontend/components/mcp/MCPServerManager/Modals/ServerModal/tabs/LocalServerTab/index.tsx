'use client';

import React from 'react';
import { TabProps } from '../../types';
import { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp/mcp';
import ConsoleOutput from './ConsoleOutput';
import { useLocalServerState } from './hooks/useLocalServerState';
import { useConsoleOutput } from './hooks/useConsoleOutput';
import LocalServerForm from './LocalServerForm';
import BuildTools from './BuildTools';
import RunTools from './RunTools';
import ArgumentsManager from './ArgumentsManager';
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
import {
  Alert,
  Box,
  Button,
  Grid,
  Paper,
  Stack,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

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
    buildMessage,
    setBuildMessage,
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
    setExpandedSections,
    handleTransportChange,
    handleArgChange,
    addArgField,
    removeArgField,
    handleEnvChange
  } = useLocalServerState({ initialConfig });
  
  // Handle accordion expansion
  const handleAccordionChange = (panel: string) => (event: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedSections({
      ...expandedSections,
      [panel]: isExpanded
    });
  };

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
  
  // Helper function to get accordion status color
  const getAccordionStatusColor = (status: 'default' | 'error' | 'success' | 'warning' | 'loading') => {
    switch (status) {
      case 'error':
        return 'error.main';
      case 'success':
        return 'success.main';
      case 'warning':
        return 'warning.main';
      case 'loading':
        return 'info.main';
      default:
        return 'text.primary';
    }
  };
  
  // Determine section statuses
  const getDefineStatus = () => {
    if (!localConfig.name || !localConfig.rootPath) {
      return 'error';
    }
    return 'default';
  };
  
  const getBuildStatus = () => {
    if (buildMessage?.type === 'error') {
      return 'error';
    } else if (installCompleted && buildCompleted) {
      return 'success';
    } else if (installCompleted || buildCompleted) {
      return 'warning';
    } else if (isInstalling || isBuilding) {
      return 'loading';
    }
    return 'default';
  };
  
  const getRunStatus = () => {
    if (message?.type === 'error' && !isRunning) {
      return 'error';
    } else if (runCompleted) {
      return 'success';
    } else if (isRunning) {
      return 'loading';
    }
    return 'default';
  };

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
      setBuildMessage,
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
      setBuildMessage,
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
    <Box component="form" onSubmit={onSubmit} sx={{ width: '100%' }}>
      <Grid container spacing={2}>
        <Grid item xs={isConsoleVisible ? 8 : 12}>
          <Stack spacing={3}>
            {/* Define Server Section */}
            <Accordion 
              expanded={expandedSections.define} 
              onChange={handleAccordionChange('define')}
              sx={{
                border: 1,
                borderColor: !localConfig.name || !localConfig.rootPath 
                  ? 'error.main' 
                  : 'divider',
                bgcolor: !localConfig.name || !localConfig.rootPath
                  ? 'error.lighter'
                  : 'background.paper',
                '&:before': { display: 'none' },
                borderRadius: 1,
                boxShadow: theme => theme.palette.mode === 'dark' ? 1 : 0,
                mb: 2,
                overflow: 'hidden'
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                aria-controls="define-server-content"
                id="define-server-header"
                sx={{
                  '& .MuiAccordionSummary-content': {
                    alignItems: 'center'
                  },
                  minHeight: 56,
                  px: 2
                }}
              >
                <Typography 
                  variant="h6" 
                  sx={{ 
                    color: getAccordionStatusColor(getDefineStatus()),
                    fontWeight: 500
                  }}
                >
                  First, define your server
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 3, py: 2 }}>
                <LocalServerForm
                  name={localConfig.name}
                  setName={(name) => setLocalConfig({ ...localConfig, name })}
                  rootPath={localConfig.rootPath || ''}
                  setRootPath={(rootPath) => setLocalConfig({ ...localConfig, rootPath })}
                  onRootPathSelect={onRootPathSelect}
                />
              </AccordionDetails>
            </Accordion>
            
            {/* Build Section */}
            <Accordion 
              expanded={expandedSections.build} 
              onChange={handleAccordionChange('build')}
              sx={{
                border: 1,
                borderColor: buildMessage?.type === 'error'
                  ? 'error.main'
                  : installCompleted && buildCompleted 
                  ? 'success.main' 
                  : installCompleted || buildCompleted 
                  ? 'warning.main' 
                  : isInstalling || isBuilding 
                  ? 'info.main' 
                  : 'divider',
                bgcolor: buildMessage?.type === 'error'
                  ? 'error.lighter'
                  : installCompleted && buildCompleted 
                  ? 'success.lighter' 
                  : installCompleted || buildCompleted 
                  ? 'warning.lighter' 
                  : isInstalling || isBuilding 
                  ? 'info.lighter' 
                  : 'background.paper',
                '&:before': { display: 'none' },
                borderRadius: 1,
                boxShadow: theme => theme.palette.mode === 'dark' ? 1 : 0,
                mb: 2,
                overflow: 'hidden'
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                aria-controls="build-content"
                id="build-header"
                sx={{
                  '& .MuiAccordionSummary-content': {
                    alignItems: 'center'
                  },
                  minHeight: 56,
                  px: 2
                }}
              >
                <Typography 
                  variant="h6" 
                  sx={{ 
                    color: getAccordionStatusColor(getBuildStatus()),
                    fontWeight: 500
                  }}
                >
                  Second, install and build
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 3, py: 2 }}>
                <BuildTools
                  installCommand={installCommand}
                  setinstallCommand={setInstallCommand}
                  buildCommand={buildCommand}
                  setBuildCommand={setBuildCommand}
                  onInstall={onInstall}
                  onBuild={onBuild}
                  isInstalling={isInstalling}
                  isBuilding={isBuilding}
                  installCompleted={installCompleted}
                  buildCompleted={buildCompleted}
                  buildMessage={buildMessage}
                />
              </AccordionDetails>
            </Accordion>
            
            {/* Run Section */}
            <Accordion 
              expanded={expandedSections.run} 
              onChange={handleAccordionChange('run')}
              sx={{
                border: 1,
                borderColor: message?.type === 'error' && !isRunning 
                  ? 'error.main' 
                  : runCompleted 
                  ? 'success.main' 
                  : isRunning 
                  ? 'info.main' 
                  : 'divider',
                bgcolor: message?.type === 'error' && !isRunning 
                  ? 'error.lighter' 
                  : runCompleted 
                  ? 'success.lighter' 
                  : isRunning 
                  ? 'info.lighter' 
                  : 'background.paper',
                '&:before': { display: 'none' },
                borderRadius: 1,
                boxShadow: theme => theme.palette.mode === 'dark' ? 1 : 0,
                mb: 2,
                overflow: 'hidden'
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                aria-controls="run-content"
                id="run-header"
                sx={{
                  '& .MuiAccordionSummary-content': {
                    alignItems: 'center'
                  },
                  minHeight: 56,
                  px: 2
                }}
              >
                <Typography 
                  variant="h6" 
                  sx={{ 
                    color: getAccordionStatusColor(getRunStatus()),
                    fontWeight: 500
                  }}
                >
                  Third, define how to run your server
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 3, py: 2 }}>
                <Stack spacing={4}>
                  <RunTools
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
                  />
                  
                  <Box>
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
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </Grid>
        
        {isConsoleVisible && (
          <Grid item xs={4}>
            {/* Right column with console output */}
            <ConsoleOutput
              output={consoleOutput}
              isVisible={true}
              toggleVisibility={toggleConsoleVisibility}
              title={consoleTitle}
            />
          </Grid>
        )}
      </Grid>

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

export default LocalServerTab;
