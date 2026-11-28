'use client';

import { useState } from 'react';
import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig, MCPSSEConfig, MCPStreamableConfig, EnvVarValue } from '@/shared/types/mcp/mcp';
import { MessageState } from '../../../types';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useResetOnChange } from '@/frontend/hooks/useResetOnChange';

// Type guards
export const isStdioConfig = (config: MCPServerConfig): config is MCPStdioConfig => {
  return config.transport === 'stdio';
};

export const isWebSocketConfig = (config: MCPServerConfig): config is MCPWebSocketConfig => {
  return config.transport === 'websocket';
};

export const isSSEConfig = (config: MCPServerConfig): config is MCPSSEConfig => {
  return config.transport === 'sse';
};

export const isStreamableConfig = (config: MCPServerConfig): config is MCPStreamableConfig => {
  return config.transport === 'streamable';
};

const defaultServerConfig = (): MCPStdioConfig => ({
  name: '',
  command: '',
  args: [],
  env: {},
  disabled: false,
  rootPath: '',
  transport: 'stdio',
  _buildCommand: '',
  _installCommand: ''
});

/** The form fields for an existing server's config. */
function fieldsFromConfig(config: MCPServerConfig) {
  return {
    localConfig: { ...config, rootPath: config.rootPath || '' },
    buildCommand: config._buildCommand || '',
    installCommand: config._installCommand || '',
    websocketUrl: config.transport === 'websocket' ? config.websocketUrl || '' : '',
    serverUrl: config.transport === 'sse' || config.transport === 'streamable' ? config.serverUrl || '' : '',
  };
}

interface UseLocalServerStateProps {
  initialConfig?: MCPServerConfig | null;
  isOpen?: boolean;
}

export const useLocalServerState = ({ initialConfig, isOpen = true }: UseLocalServerStateProps) => {
  const { t, locale } = useI18n();
  // Track which sections are expanded
  const [expandedSections, setExpandedSections] = useState({
    define: true,
    build: true,
    run: true
  });

  // A server opened for editing starts from its config, a new one from the stdio defaults.
  const [openedFields] = useState(() => isOpen && initialConfig ? fieldsFromConfig(initialConfig) : null);
  const [localConfig, setLocalConfig] = useState<MCPServerConfig>(() => openedFields?.localConfig ?? defaultServerConfig());

  // State for URLs
  const [websocketUrl, setWebsocketUrl] = useState<string>(openedFields?.websocketUrl ?? '');
  const [serverUrl, setServerUrl] = useState<string>(openedFields?.serverUrl ?? '');

  const [buildCommand, setBuildCommand] = useState<string>(openedFields?.buildCommand ?? '');
  const [installCommand, setInstallCommand] = useState<string>(openedFields?.installCommand ?? '');
  const [message, setMessage] = useState<MessageState | null>(null);
  const [buildMessage, setBuildMessage] = useState<MessageState | null>(null);
  const [isBuilding, setIsBuilding] = useState<boolean>(false);
  const [isInstalling, setIsInstalling] = useState<boolean>(false);
  const [buildCompleted, setBuildCompleted] = useState<boolean>(false);
  const [installCompleted, setInstallCompleted] = useState<boolean>(false);
  const [isParsingReadme, setIsParsingReadme] = useState<boolean>(false);
  const [isParsingEnv, setIsParsingEnv] = useState<boolean>(false);

  // State for console output
  const [consoleOutput, setConsoleOutput] = useState<string>('');
  const [isConsoleVisible, setIsConsoleVisible] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [runCompleted, setRunCompleted] = useState<boolean>(false);
  const [consoleTitle, setConsoleTitle] = useState<string>(() => t('mcp.local.console.output'));

  // Update expanded sections
  const setExpandedSection = (section: 'define' | 'build' | 'run', isExpanded: boolean) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: isExpanded
    }));
  };

  // Handle transport type change
  const handleTransportChange = (transport: 'stdio' | 'websocket' | 'sse' | 'streamable') => {
    if (transport === 'websocket') {
      // Convert to websocket config
      setLocalConfig(prev => ({
        name: prev.name,
        disabled: prev.disabled,
        rootPath: prev.rootPath,
        env: prev.env,
        _buildCommand: prev._buildCommand,
        _installCommand: prev._installCommand,
        // Preserve transport-independent settings across a transport switch.
        roots: prev.roots,
        exposeAsMcpServer: prev.exposeAsMcpServer,
        sampling: prev.sampling,
        toolParameterPresets: prev.toolParameterPresets,
        runtimeHomeMode: prev.runtimeHomeMode,
        transport: 'websocket',
        websocketUrl: websocketUrl
      } as MCPWebSocketConfig));
    } else if (transport === 'sse') {
      // Convert to SSE config
      setLocalConfig(prev => ({
        name: prev.name,
        disabled: prev.disabled,
        rootPath: prev.rootPath,
        env: prev.env,
        _buildCommand: prev._buildCommand,
        _installCommand: prev._installCommand,
        // Preserve transport-independent settings across a transport switch.
        roots: prev.roots,
        exposeAsMcpServer: prev.exposeAsMcpServer,
        sampling: prev.sampling,
        toolParameterPresets: prev.toolParameterPresets,
        runtimeHomeMode: prev.runtimeHomeMode,
        transport: 'sse',
        serverUrl: serverUrl,
        // Preserve any custom headers when switching between HTTP-based transports
        headers: (prev as MCPSSEConfig | MCPStreamableConfig).headers || {}
      } as MCPSSEConfig));
    } else if (transport === 'streamable') {
      // Convert to Streamable config
      setLocalConfig(prev => ({
        name: prev.name,
        disabled: prev.disabled,
        rootPath: prev.rootPath,
        env: prev.env,
        _buildCommand: prev._buildCommand,
        _installCommand: prev._installCommand,
        // Preserve transport-independent settings across a transport switch.
        roots: prev.roots,
        exposeAsMcpServer: prev.exposeAsMcpServer,
        sampling: prev.sampling,
        toolParameterPresets: prev.toolParameterPresets,
        runtimeHomeMode: prev.runtimeHomeMode,
        transport: 'streamable',
        serverUrl: serverUrl,
        // Preserve any custom headers when switching between HTTP-based transports
        headers: (prev as MCPSSEConfig | MCPStreamableConfig).headers || {}
      } as MCPStreamableConfig));
    } else {
      // Convert to stdio config
      setLocalConfig(prev => ({
        name: prev.name,
        command: isStdioConfig(prev) ? prev.command : '',
        args: isStdioConfig(prev) ? prev.args : [],
        disabled: prev.disabled,
        rootPath: prev.rootPath,
        env: prev.env,
        _buildCommand: prev._buildCommand,
        _installCommand: prev._installCommand,
        // Preserve transport-independent settings across a transport switch.
        roots: prev.roots,
        exposeAsMcpServer: prev.exposeAsMcpServer,
        sampling: prev.sampling,
        toolParameterPresets: prev.toolParameterPresets,
        runtimeHomeMode: prev.runtimeHomeMode,
        transport: 'stdio'
      } as MCPStdioConfig));
    }
  };

  // Handle argument changes
  const handleArgChange = (index: number, value: string) => {
    if (isStdioConfig(localConfig)) {
      setLocalConfig(prev => {
        if (isStdioConfig(prev) && prev.args) {
          return {
            ...prev,
            args: prev.args.map((arg, i) => i === index ? value : arg)
          };
        }
        return prev;
      });
    }
  };

  const addArgField = () => {
    if (isStdioConfig(localConfig)) {
      setLocalConfig(prev => {
        if (isStdioConfig(prev)) {
          const currentArgs = prev.args || [];
          return {
            ...prev,
            args: [...currentArgs, '']
          };
        }
        return prev;
      });
    }
  };

  const removeArgField = (index: number) => {
    if (isStdioConfig(localConfig)) {
      setLocalConfig(prev => {
        if (isStdioConfig(prev) && prev.args) {
          return {
            ...prev,
            args: prev.args.filter((_, i) => i !== index)
          };
        }
        return prev;
      });
    }
  };

  // Handle environment variable changes
  const handleEnvChange = (env: Record<string, EnvVarValue>) => {
    setLocalConfig(prev => {
      // Create a copy of the previous config with the updated env
      const updatedConfig = { ...prev, env };
      
      // Ensure we maintain the correct type
      if (isStdioConfig(prev)) {
        return updatedConfig as MCPStdioConfig;
      } else if (isWebSocketConfig(prev)) {
        return updatedConfig as MCPWebSocketConfig;
      }
      
      return prev;
    });
  };

  // Reset state when modal is opened or initialConfig changes
  const resetForOpening = () => {
    if (!isOpen) return;
    if (initialConfig) {
      const fields = fieldsFromConfig(initialConfig);
      setLocalConfig(fields.localConfig);
      // Set build and install commands from config if available
      setBuildCommand(fields.buildCommand);
      setInstallCommand(fields.installCommand);
      // Set URLs based on transport type
      setWebsocketUrl(fields.websocketUrl);
      setServerUrl(fields.serverUrl);
      return;
    }
    // Reset to default values if no initialConfig
    setLocalConfig(defaultServerConfig());
    setBuildCommand('');
    setInstallCommand('');
    setWebsocketUrl('');
    setMessage(null);
    setBuildMessage(null);
    setIsBuilding(false);
    setIsInstalling(false);
    setBuildCompleted(false);
    setInstallCompleted(false);
    setIsParsingReadme(false);
    setIsParsingEnv(false);
    setConsoleOutput('');
    setIsConsoleVisible(false);
    setIsRunning(false);
    setRunCompleted(false);
    setConsoleTitle(t('mcp.local.console.output'));
    setExpandedSections({
      define: true,
      build: true,
      run: true
    });
  };
  useResetOnChange(isOpen, resetForOpening);
  useResetOnChange(initialConfig, resetForOpening);
  useResetOnChange(locale, resetForOpening);

  return {
    // State
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
    consoleOutput,
    setConsoleOutput,
    isConsoleVisible,
    setIsConsoleVisible,
    isRunning,
    setIsRunning,
    runCompleted,
    setRunCompleted,
    consoleTitle,
    setConsoleTitle,
    expandedSections,
    setExpandedSections,
    
    // Methods
    handleTransportChange,
    handleArgChange,
    addArgField,
    removeArgField,
    handleEnvChange
  };
};
