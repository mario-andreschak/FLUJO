'use client';

import { useState, useEffect } from 'react';
import { 
  MCPServerConfig, 
  MCPStdioConfig, 
  MCPWebSocketConfig, 
  MCPStreamableHttpConfig, 
  MCPHttpSseConfig, 
  EnvVarValue 
} from '@/shared/types/mcp/mcp';
import { MessageState } from '../../../types';

// Type guards
export const isStdioConfig = (config: MCPServerConfig): config is MCPStdioConfig => {
  return config.transport === 'stdio';
};

export const isWebSocketConfig = (config: MCPServerConfig): config is MCPWebSocketConfig => {
  return config.transport === 'websocket';
};

export const isStreamableHttpConfig = (config: MCPServerConfig): config is MCPStreamableHttpConfig => {
  return config.transport === 'streamableHttp';
};

export const isHttpSseConfig = (config: MCPServerConfig): config is MCPHttpSseConfig => {
  return config.transport === 'httpSse';
};

interface UseLocalServerStateProps {
  initialConfig?: MCPServerConfig | null;
  isOpen?: boolean;
}

export const useLocalServerState = ({ initialConfig, isOpen = true }: UseLocalServerStateProps) => {
  // Track which sections are expanded
  const [expandedSections, setExpandedSections] = useState({
    define: true,
    build: true,
    run: true
  });

  // Initialize with stdio transport by default
  const [localConfig, setLocalConfig] = useState<MCPServerConfig>({
    name: '',
    command: '',
    args: [],
    env: {},
    disabled: false,
    autoApprove: [],
    rootPath: '',
    transport: 'stdio',
    _buildCommand: '',
    _installCommand: ''
  } as MCPStdioConfig);
  
  // State for websocket URL (only used when transport is 'websocket')
  const [websocketUrl, setWebsocketUrl] = useState<string>('');
  
  const [buildCommand, setBuildCommand] = useState<string>('');
  const [installCommand, setInstallCommand] = useState<string>('');
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
  const [consoleTitle, setConsoleTitle] = useState<string>('Command Output');

  // Update expanded sections
  const setExpandedSection = (section: 'define' | 'build' | 'run', isExpanded: boolean) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: isExpanded
    }));
  };

  // State for HTTP endpoints
  const [endpoint, setEndpoint] = useState<string>('');
  const [sseEndpoint, setSseEndpoint] = useState<string>('');
  const [messageEndpoint, setMessageEndpoint] = useState<string>('');

  // Handle transport type change
  const handleTransportChange = (transport: 'stdio' | 'websocket' | 'streamableHttp' | 'httpSse') => {
    const commonConfig = {
      name: localConfig.name,
      disabled: localConfig.disabled,
      autoApprove: localConfig.autoApprove,
      rootPath: localConfig.rootPath,
      env: localConfig.env,
      _buildCommand: localConfig._buildCommand,
      _installCommand: localConfig._installCommand,
    };

    switch (transport) {
      case 'websocket':
        // Convert to websocket config
        setLocalConfig({
          ...commonConfig,
          transport: 'websocket',
          websocketUrl: websocketUrl
        } as MCPWebSocketConfig);
        break;
      
      case 'streamableHttp':
        // Convert to streamable HTTP config
        setLocalConfig({
          ...commonConfig,
          transport: 'streamableHttp',
          endpoint: endpoint
        } as MCPStreamableHttpConfig);
        break;
      
      case 'httpSse':
        // Convert to HTTP+SSE config
        setLocalConfig({
          ...commonConfig,
          transport: 'httpSse',
          sseEndpoint: sseEndpoint,
          messageEndpoint: messageEndpoint
        } as MCPHttpSseConfig);
        break;
      
      default:
        // Convert to stdio config (default)
        setLocalConfig({
          ...commonConfig,
          transport: 'stdio',
          command: isStdioConfig(localConfig) ? localConfig.command : '',
          args: isStdioConfig(localConfig) ? localConfig.args : []
        } as MCPStdioConfig);
        break;
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
  useEffect(() => {
    // Default state for a new server
    const defaultConfig: MCPStdioConfig = {
      name: '',
      command: '',
      args: [],
      env: {},
      disabled: false,
      autoApprove: [],
      rootPath: '',
      transport: 'stdio',
      _buildCommand: '',
      _installCommand: ''
    };
    
    // Reset all state values when modal is opened
    if (isOpen) {
      if (initialConfig) {
        // Extract rootPath if it exists
        const rootPath = initialConfig.rootPath || '';
              
        // Create a new config with the extracted rootPath
        const configWithRootPath = {
          ...initialConfig,
          rootPath
        };
        
        setLocalConfig(configWithRootPath);
        
        // Set build and install commands from config if available
        setBuildCommand(initialConfig._buildCommand || '');
        setInstallCommand(initialConfig._installCommand || '');
        
        // Set transport-specific fields based on the transport type
        if (initialConfig.transport === 'websocket') {
          setWebsocketUrl((initialConfig as MCPWebSocketConfig).websocketUrl || '');
          setEndpoint('');
          setSseEndpoint('');
          setMessageEndpoint('');
        } else if (initialConfig.transport === 'streamableHttp') {
          setWebsocketUrl('');
          setEndpoint((initialConfig as MCPStreamableHttpConfig).endpoint || '');
          setSseEndpoint('');
          setMessageEndpoint('');
        } else if (initialConfig.transport === 'httpSse') {
          setWebsocketUrl('');
          setEndpoint('');
          setSseEndpoint((initialConfig as MCPHttpSseConfig).sseEndpoint || '');
          setMessageEndpoint((initialConfig as MCPHttpSseConfig).messageEndpoint || '');
        } else {
          // Default to stdio
          setWebsocketUrl('');
          setEndpoint('');
          setSseEndpoint('');
          setMessageEndpoint('');
        }
      } else {
        // Reset to default values if no initialConfig
        setLocalConfig(defaultConfig);
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
        setConsoleTitle('Command Output');
        setExpandedSections({
          define: true,
          build: true,
          run: true
        });
      }
    }
  }, [isOpen, initialConfig]);

  return {
    // State
    localConfig,
    setLocalConfig,
    websocketUrl,
    setWebsocketUrl,
    endpoint,
    setEndpoint,
    sseEndpoint,
    setSseEndpoint,
    messageEndpoint,
    setMessageEndpoint,
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
