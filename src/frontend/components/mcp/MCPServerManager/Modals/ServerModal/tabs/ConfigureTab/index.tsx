'use client';

import React, { useEffect, useRef, useState } from 'react';
import { TabProps, MessageState } from '../../types';
import { MCPServerConfig, MCPStdioConfig, MCPSSEConfig, MCPStreamableConfig } from '@/shared/types/mcp/mcp';
import ConsoleOutput from './ConsoleOutput';
import { useLocalServerState } from './hooks/useLocalServerState';
import { useConsoleOutput } from './hooks/useConsoleOutput';
import LocalServerForm from './LocalServerForm';
import BuildTools from './BuildTools';
import RunTools from './RunTools';
import ArgumentsManager from './ArgumentsManager';
import RootsManager from './RootsManager';
import SamplingManager from './SamplingManager';
import ElicitationManager from './ElicitationManager';
import FolderPickerDialog from '@/frontend/components/shared/FolderPickerDialog';
import {
  handleSubmit,
  handleParseClipboard,
  handleParseEnvClipboard,
  handleParseEnvExample,
  handleParseReadme,
  handleInstall,
  handleBuild,
  handleRun,
  buildFinalConfig
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
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { McpTroubleshootPatch } from '@/shared/types/mcp/assistant';
import McpInstallTroubleshooter from './McpInstallTroubleshooter';
import ToolParameterPresetsEditor from '@/frontend/components/mcp/ToolParameterPresetsEditor';
import { useServerTools } from '@/frontend/hooks/useServerTools';

/**
 * The single configure-and-verify sink for every transport and every
 * acquisition source (#392) — and the edit form for existing servers.
 *
 * Spotlight, Marketplace, GitHub, Reference and Remote are all thin producers
 * of a `Partial<MCPServerConfig>`; this is the only place a server config is
 * finalised, test-run and saved. It owns the env/args editors, `serverUrl`,
 * `HeadersEditor`, `OAuthCredentialsEditor`, and the Roots/Sampling/Elicitation
 * policies. `ServerModal` renders it directly (tab bar hidden) whenever
 * `initialConfig` is set, which is why it was renamed away from "LocalServerTab":
 * it was never the local tab.
 *
 * NOTE: `MCPServerSource = { type: 'local' }` is deliberately NOT renamed — that
 * is persisted install-origin metadata, not a tab identity.
 */
const ConfigureTab: React.FC<TabProps> = ({
  initialConfig,
  onAdd,
  onUpdate,
  onClose,
  autoTestRun,
  handoffId,
  onSaveAndAuthenticate
}) => {
  const { t } = useI18n();
  // Use custom hooks for state management first
  const {
    localConfig,
    setLocalConfig,
    websocketUrl,
    setWebsocketUrl,
    serverUrl,
    setServerUrl,
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
  } = useLocalServerState({ 
    initialConfig,
    isOpen: true // Always pass true here since we're already in the component
  });
  const presetServerName = initialConfig?.name || (runCompleted ? localConfig.name : '');
  const { tools: presetTools, isLoading: isLoadingPresetTools } = useServerTools(presetServerName);
  
  // Check if we're coming from GitHub tab with empty fields
  useEffect(() => {
    // If we have a name but no command or build/install commands, show a warning
    if (
      initialConfig && 
      initialConfig.name && 
      initialConfig.rootPath && 
      initialConfig.transport === 'stdio' &&
      (!initialConfig.command || initialConfig.command === '') &&
      (!initialConfig._buildCommand || initialConfig._buildCommand === '') &&
      (!initialConfig._installCommand || initialConfig._installCommand === '')
    ) {
      setMessage({
        type: 'warning',
        text: t('mcp.local.detectionFailed')
      });
      
      // Expand all sections to make it easier for the user to configure
      setExpandedSections({
        define: true,
        build: true,
        run: true
      });
    }
  }, [initialConfig, setExpandedSections, setMessage, t]);

  // Folder pickers browse the BACKEND filesystem (the machine running FLUJO
  // and the MCP servers) via /api/browse — the browser's own directory picker
  // can neither browse a remote backend nor return real absolute paths.
  const [rootPickerOpen, setRootPickerOpen] = useState(false);
  const [argPickerIndex, setArgPickerIndex] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [testRunError, setTestRunError] = useState<string | null>(null);

  // A new handoff/configuration must not inherit failures from the server that
  // previously occupied this tab (including repeat Marketplace installs).
  useEffect(() => {
    setFormError(null);
    setAuthError(null);
    setInstallError(null);
    setBuildError(null);
    setTestRunError(null);
  }, [handoffId, initialConfig?.name]);

  const setFormOperationMessage = (nextMessage: MessageState | null) => {
    setMessage(nextMessage);
    setFormError(nextMessage?.type === 'error' ? nextMessage.text : null);
  };

  // Event handlers that use the form handlers utility functions
  const onSubmit = (e: React.FormEvent) => {
    setFormError(null);
    handleSubmit(
      e,
      localConfig,
      websocketUrl,
      serverUrl,
      buildCommand,
      installCommand,
      setFormOperationMessage,
      onAdd,
      onUpdate,
      initialConfig,
      onClose,
      t
    );
  };

  const onRootPathSelect = async () => {
    setRootPickerOpen(true);
  };

  const onFolderSelect = async (index: number) => {
    setArgPickerIndex(index);
  };

  const onParseClipboard = async () => {
    setFormError(null);
    await handleParseClipboard(
      localConfig,
      setLocalConfig,
      setFormOperationMessage,
      setBuildCommand,
      setInstallCommand,
      setWebsocketUrl,
      websocketUrl,
      t
    );
  };

  const onParseEnvClipboard = async () => {
    setFormError(null);
    await handleParseEnvClipboard(
      localConfig,
      setLocalConfig,
      setFormOperationMessage,
      setIsParsingEnv,
      t
    );
  };

  const onParseEnvExample = async () => {
    setFormError(null);
    await handleParseEnvExample(
      localConfig,
      setLocalConfig,
      setFormOperationMessage,
      setIsParsingEnv,
      t
    );
  };

  const onParseReadme = async () => {
    setFormError(null);
    await handleParseReadme(
      localConfig,
      setLocalConfig,
      setFormOperationMessage,
      setIsParsingReadme,
      setBuildCommand,
      setInstallCommand,
      setWebsocketUrl,
      websocketUrl,
      t
    );
  };

  const runInstall = async (): Promise<boolean> => {
    setInstallError(null);
    return handleInstall(
      localConfig,
      installCommand,
      setIsInstalling,
      (nextMessage) => {
        setBuildMessage(nextMessage);
        setInstallError(nextMessage?.type === 'error' ? nextMessage.text : null);
      },
      setConsoleTitle,
      setIsConsoleVisible,
      setConsoleOutput,
      setInstallCompleted,
      t
    );
  };

  const onInstall = async (): Promise<void> => {
    await runInstall();
  };

  const runBuild = async (): Promise<boolean> => {
    setBuildError(null);
    return handleBuild(
      localConfig,
      buildCommand,
      setIsBuilding,
      (nextMessage) => {
        setBuildMessage(nextMessage);
        setBuildError(nextMessage?.type === 'error' ? nextMessage.text : null);
      },
      setConsoleTitle,
      setIsConsoleVisible,
      setConsoleOutput,
      setBuildCompleted,
      t
    );
  };

  const onBuild = async (): Promise<void> => {
    await runBuild();
  };

  // Whether the last Test Run found a reachable OAuth (RFC 9728) streamable server, and
  // whether a Save & Authenticate round-trip is currently in flight.
  const [oauthCapable, setOauthCapable] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const onRun = async () => {
    // A new attempt is no longer the previously completed green run. Resetting
    // this also lets a later success transition collapse the section again.
    setRunCompleted(false);
    setTestRunError(null);
    await handleRun(
      localConfig,
      websocketUrl,
      serverUrl,
      setIsRunning,
      setConsoleTitle,
      setConsoleOutput,
      setIsConsoleVisible,
      (nextMessage) => {
        setMessage(nextMessage);
        setTestRunError(nextMessage?.type === 'error' ? nextMessage.text : null);
      },
      setRunCompleted,
      // Pass the pre-edit server name so masked secret headers hydrate from the saved
      // config on Test Connection, even after a rename (#137).
      initialConfig?.name,
      setOauthCapable,
      t
    );
  };

  // "Save & Authenticate": persist the server (OAuth binds tokens by server name, so it
  // must exist on disk) and start its OAuth flow via the manager, which keeps the modal
  // open until the popup resolves. Collapses save → find-the-card → click-Authenticate.
  const onSaveAndAuthenticateClick = async () => {
    if (!onSaveAndAuthenticate) return;
    setAuthError(null);
    if (!localConfig.name || !serverUrl) {
      const errorText = t('mcp.local.auth.missingDetails');
      setMessage({ type: 'error', text: errorText });
      setAuthError(errorText);
      return;
    }
    const finalConfig = buildFinalConfig(localConfig, websocketUrl, serverUrl, buildCommand, installCommand);
    setIsAuthenticating(true);
    setMessage({ type: 'success', text: t('mcp.local.auth.starting', { server: finalConfig.name }) });
    try {
      const result = await onSaveAndAuthenticate(finalConfig);
      if (result.status === 'needs_client_credentials') {
        setMessage({
          type: 'warning',
          text: result.error || t('mcp.local.auth.credentialsRequired')
        });
      } else if (result.status === 'error') {
        const errorText = result.error || t('mcp.local.auth.failed');
        setMessage({ type: 'error', text: errorText });
        setAuthError(errorText);
      }
      // 'authorized' → the manager closes the modal; nothing more to do here.
    } catch (error) {
      const errorText = t('mcp.local.auth.failedWithError', { error: error instanceof Error ? error.message : t('mcp.server.unknownError') });
      setMessage({ type: 'error', text: errorText });
      setAuthError(errorText);
    } finally {
      setIsAuthenticating(false);
    }
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
  
  // Streamlined source handoff: collapse configuration the source already supplied
  // and advance automatically until something needs attention. Registry/remote
  // configs are runnable as-is. A cloned GitHub source first runs its detected
  // install/build commands, keeping those details collapsed unless a command fails.
  // Once preparation succeeds, Test Run opens only while active and its success
  // effect below collapses it again, leaving Save as the primary remaining action.
  // Keyed by handoff identity, not a bare boolean: installing the same server
  // twice in a row is two handoffs and must auto-run twice (#392).
  const autoRunStartedForRef = useRef<number | null>(null);
  useEffect(() => {
    if (!autoTestRun) return;
    const handoffKey = handoffId ?? 0;
    if (autoRunStartedForRef.current === handoffKey) return;
    if (!initialConfig?.name) return;
    // Wait until useLocalServerState has hydrated the form from initialConfig,
    // otherwise the run would see the empty default config
    if (localConfig.name !== initialConfig.name) return;
    autoRunStartedForRef.current = handoffKey;
    const prepareGitHubSource = initialConfig.source?.type === 'github';
    setExpandedSections({
      define: false,
      build: false,
      run: !prepareGitHubSource
    });

    const prepareAndRun = async () => {
      if (prepareGitHubSource) {
        const installSucceeded = installCommand.trim()
          ? await runInstall()
          : true;
        setInstallCompleted(installSucceeded);
        if (!installSucceeded) {
          setExpandedSections(current => ({ ...current, build: true }));
          return;
        }

        const buildSucceeded = buildCommand.trim()
          ? await runBuild()
          : true;
        setBuildCompleted(buildSucceeded);
        if (!buildSucceeded) {
          setExpandedSections(current => ({ ...current, build: true }));
          return;
        }

        setExpandedSections(current => ({ ...current, run: true }));
      } else {
        // Remote and registry handoffs have no local preparation stage.
        setInstallCompleted(true);
        setBuildCompleted(true);
      }

      await onRun();
    };

    void prepareAndRun();
  }, [autoTestRun, handoffId, initialConfig, localConfig.name, installCommand, buildCommand]);

  // Successful runs are already summarized by the green accordion header. Keep
  // the detailed controls out of the way after the transition, including runs
  // started by source handoffs. Users can still reopen it.
  useEffect(() => {
    if (!runCompleted) return;
    setExpandedSections((current) => current.run
      ? { ...current, run: false }
      : current);
  }, [runCompleted, setExpandedSections]);

  // Handle accordion expansion
  const handleAccordionChange = (panel: string) => (event: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedSections({
      ...expandedSections,
      [panel]: isExpanded
    });
  };
  
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
    // Marketplace handoff: the definition came prefilled and complete
    if (autoTestRun) {
      return 'success';
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

  // Launch-and-connect servers (#392) carry the process that has to be running
  // behind their URL. Shown read-only: Phase 2 owns actually spawning it.
  const launchSpec = (localConfig as { launch?: { command: string; args?: string[] } }).launch;

  const applyTroubleshootPatch = (patch: McpTroubleshootPatch) => {
    setLocalConfig((current) => {
      const env = { ...(current.env || {}) };
      for (const name of patch.addEnvNames ?? []) {
        if (!(name in env)) env[name] = '';
      }
      const next = { ...current, env, ...(patch.rootPath ? { rootPath: patch.rootPath } : {}) } as MCPServerConfig;
      if (current.transport === 'stdio') {
        return {
          ...next,
          ...(patch.command ? { command: patch.command } : {}),
          ...(patch.args ? { args: patch.args } : {}),
        } as MCPStdioConfig;
      }
      if (current.transport === 'sse' || current.transport === 'streamable') {
        const headers = { ...((current as MCPSSEConfig | MCPStreamableConfig).headers || {}) };
        for (const name of patch.addHeaderNames ?? []) {
          if (!(name in headers)) headers[name] = '';
        }
        return { ...next, headers } as MCPSSEConfig | MCPStreamableConfig;
      }
      return next;
    });
    if (patch.serverUrl) setServerUrl(patch.serverUrl);
    if (patch.installCommand !== undefined) setInstallCommand(patch.installCommand);
    if (patch.buildCommand !== undefined) setBuildCommand(patch.buildCommand);
    setMessage({ type: 'warning', text: t('mcp.troubleshoot.reviewApplied') });
  };

  const troubleshootErrors = [
    formError ? `Form/configuration: ${formError}` : null,
    authError ? `Authentication: ${authError}` : null,
    installError ? `Install: ${installError}` : null,
    buildError ? `Build: ${buildError}` : null,
    testRunError ? `Test run: ${testRunError}` : null,
  ].filter((error): error is string => Boolean(error));
  const showTroubleshooter = troubleshootErrors.length > 0;
  const troubleshootError = troubleshootErrors.join('\n');
  
  return (
    <Box component="form" onSubmit={onSubmit} sx={{ width: '100%' }}>
      {showTroubleshooter && (
        <McpInstallTroubleshooter
          context={{
            config: {
              name: localConfig.name,
              transport: localConfig.transport,
              ...(localConfig.transport === 'stdio'
                ? { command: localConfig.command, args: localConfig.args }
                : {}),
              ...(localConfig.transport === 'sse' || localConfig.transport === 'streamable'
                ? { serverUrl, headerNames: Object.keys((localConfig as MCPSSEConfig | MCPStreamableConfig).headers || {}) }
                : {}),
              rootPath: localConfig.rootPath,
              envNames: Object.keys(localConfig.env || {}),
              installCommand,
              buildCommand,
            },
            error: troubleshootError,
            consoleOutput,
          }}
          onApplyPatch={applyTroubleshootPatch}
        />
      )}

      <Grid container spacing={2}>
        {/* Phone/tablet layouts keep the form full width and push the console
            below it; the 8/4 split only applies from `md` up (#394). */}
        <Grid item xs={12} md={isConsoleVisible ? 8 : 12}>
          <Stack spacing={3}>
            {/* Launch-and-connect (#392): read-only. FLUJO does not start this
                process yet — the user does, then FLUJO connects to serverUrl. */}
            {launchSpec && (
              <Alert severity="info">
                <Typography variant="body2">{t('mcp.registry.manualLaunch.description')}</Typography>
                <Typography
                  variant="caption"
                  component="code"
                  sx={{ display: 'block', mt: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}
                >
                  {[launchSpec.command, ...(launchSpec.args ?? [])].join(' ')}
                </Typography>
              </Alert>
            )}

            {/* Define Server Section */}
            <Accordion 
              expanded={expandedSections.define} 
              onChange={handleAccordionChange('define')}
              sx={{
                border: 1,
                borderColor: !localConfig.name || !localConfig.rootPath
                  ? 'error.main'
                  : autoTestRun
                  ? 'success.main'
                  : 'divider',
                bgcolor: !localConfig.name || !localConfig.rootPath
                  ? 'error.lighter'
                  : autoTestRun
                  ? 'success.lighter'
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
                  {t('mcp.local.section.define')}
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
                  {t('mcp.local.section.build')}
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
                  {t('mcp.local.section.run')}
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
                    transport={localConfig.transport as 'stdio' | 'websocket' | 'sse' | 'streamable'}
                    setTransport={handleTransportChange}
                    websocketUrl={websocketUrl}
                    setWebsocketUrl={setWebsocketUrl}
                    serverUrl={serverUrl}
                    setServerUrl={setServerUrl}
                    onRun={onRun}
                    isRunning={isRunning}
                    runCompleted={runCompleted}
                    env={localConfig.env}
                    onEnvChange={handleEnvChange}
                    headers={(localConfig.transport === 'sse' || localConfig.transport === 'streamable')
                      ? ((localConfig as MCPSSEConfig | MCPStreamableConfig).headers || {})
                      : {}}
                    onHeadersChange={(headers) => setLocalConfig(prev => ({ ...prev, headers }))}
                    oauthClientId={(localConfig as MCPStreamableConfig).oauthClientId || ''}
                    oauthClientSecret={(localConfig as MCPStreamableConfig).oauthClientSecret || ''}
                    onOAuthClientIdChange={(oauthClientId) => setLocalConfig(prev => ({ ...prev, oauthClientId }))}
                    // The backend delivers the secret masked (MASKED_API_KEY) and interprets
                    // that value on save as "keep the stored secret", so we can store whatever
                    // the editor emits verbatim (masked, a ${global:} binding, or a new value).
                    onOAuthClientSecretChange={(oauthClientSecret) => setLocalConfig(prev => ({ ...prev, oauthClientSecret }))}
                    serverName={localConfig.name}
                    consoleOutput={consoleOutput}
                    message={message}
                    setMessage={(nextMessage) => {
                      setMessage(nextMessage);
                      setTestRunError(nextMessage?.type === 'error' ? nextMessage.text : null);
                    }}
                    oauthCapable={oauthCapable}
                    onSaveAndAuthenticate={onSaveAndAuthenticate ? onSaveAndAuthenticateClick : undefined}
                    isAuthenticating={isAuthenticating}
                  />
                  
                  <Box>
                    <ArgumentsManager
                      args={localConfig.transport === 'stdio' ? localConfig.args || [] : []}
                      onArgChange={handleArgChange}
                      onAddArg={addArgField}
                      onRemoveArg={removeArgField}
                      onFolderSelect={onFolderSelect}
                      onParseReadme={onParseReadme}
                      onParseClipboard={onParseClipboard}
                      isParsingReadme={isParsingReadme}
                    />
                  </Box>

                  <Box>
                    <RootsManager
                      roots={localConfig.roots || []}
                      onChange={(roots) => setLocalConfig(prev => ({ ...prev, roots }))}
                    />
                  </Box>

                  <Box>
                    {isLoadingPresetTools ? (
                      <Typography variant="body2" color="text.secondary">Loading tool parameters…</Typography>
                    ) : (
                      <ToolParameterPresetsEditor
                        tools={presetTools}
                        value={localConfig.toolParameterPresets}
                        onChange={(toolParameterPresets) => setLocalConfig((previous) => ({ ...previous, toolParameterPresets }))}
                        workspaceRoots={localConfig.roots?.length ? localConfig.roots : [localConfig.rootPath]}
                        title="Server-wide tool parameters"
                        description="These fixed values apply everywhere this server is used. An MCP node can override individual parameters."
                      />
                    )}
                  </Box>

                  <Box>
                    <SamplingManager
                      policy={localConfig.sampling}
                      onChange={(sampling) => setLocalConfig(prev => ({ ...prev, sampling }))}
                    />
                  </Box>

                  <Box>
                    <ElicitationManager
                      policy={localConfig.elicitation}
                      onChange={(elicitation) => setLocalConfig(prev => ({ ...prev, elicitation }))}
                    />
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </Grid>
        
        {isConsoleVisible && (
          <Grid
            item
            xs={12}
            md={4}
            // Stacked below the form the console has no row height to fill, so
            // give it a bounded mobile height and let it scroll internally.
            sx={{ height: { xs: 320, md: 'auto' }, minHeight: { xs: 240, md: 0 } }}
          >
            {/* Right column (desktop) / stacked panel (mobile) with console output */}
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

      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button
          variant="outlined"
          onClick={onClose}
        >
          {t('mcp.local.cancel')}
        </Button>
        <Button
          type="submit"
          variant="contained"
          color="primary"
        >
          {initialConfig ? t('mcp.local.updateServer') : t('mcp.local.addServer')}
        </Button>
      </Box>

      <FolderPickerDialog
        open={rootPickerOpen}
        title={t('mcp.local.chooseServerFolder')}
        initialPath={localConfig.rootPath || undefined}
        onClose={() => setRootPickerOpen(false)}
        onSelect={(path) => setLocalConfig({ ...localConfig, rootPath: path })}
      />
      <FolderPickerDialog
        open={argPickerIndex !== null}
        title={t('mcp.local.chooseFolderOrFile')}
        selectFiles
        onClose={() => setArgPickerIndex(null)}
        onSelect={(path) => {
          if (argPickerIndex !== null) {
            handleArgChange(argPickerIndex, path);
          }
        }}
      />
    </Box>
  );
};

export default ConfigureTab;
