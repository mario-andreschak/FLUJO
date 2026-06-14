'use client';

import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig, MCPSSEConfig, MCPStreamableConfig } from '@/shared/types/mcp/mcp';
import { MessageState } from '../../../types';
import { parseConfigFromClipboard, parseConfigFromReadme, parseEnvFromClipboard, parseEnvFromFile } from '../../../utils/configUtils';
import { installDependencies, buildServer } from '../../../utils/buildUtils';
import { isStdioConfig, isWebSocketConfig, isSSEConfig, isStreamableConfig } from '../hooks/useLocalServerState';

// Function to get the MCP servers directory from the CWD API
export const getMCPServersDir = async (): Promise<string> => {
  try {
    const response = await fetch('/api/cwd');
    const data = await response.json();
    
    if (!data.success) {
      console.error('Failed to get MCP servers directory:', data.error);
      return 'mcp-servers'; // Fallback to relative path if API fails
    }
    
    return data.mcpServersDir;
  } catch (error) {
    console.error('Error fetching MCP servers directory:', error);
    return 'mcp-servers'; // Fallback to relative path if API fails
  }
};

export const handleSubmit = (
  e: React.FormEvent,
  localConfig: MCPServerConfig,
  websocketUrl: string,
  serverUrl: string,
  buildCommand: string,
  installCommand: string,
  setMessage: (message: MessageState | null) => void,
  onAdd: (config: MCPServerConfig) => void,
  onUpdate?: (config: MCPServerConfig) => void,
  initialConfig?: MCPServerConfig | null,
  onClose?: () => void
) => {
  e.preventDefault();
  if (!localConfig.name || (isStdioConfig(localConfig) && !localConfig.command)) {
    setMessage({
      type: 'error',
      text: 'Please fill in all required fields'
    });
    return;
  }
  
  // Validate URLs based on transport type
  if (localConfig.transport === 'websocket' && !websocketUrl) {
    setMessage({
      type: 'error',
      text: 'Please enter a valid WebSocket URL'
    });
    return;
  }
  
  if ((localConfig.transport === 'sse' || localConfig.transport === 'streamable') && !serverUrl) {
    setMessage({
      type: 'error',
      text: 'Please enter a valid Server URL'
    });
    return;
  }
  
  // Create the final config based on transport type
  let finalConfig: MCPServerConfig;
  
  if (localConfig.transport === 'websocket') {
    // For websocket transport
    finalConfig = {
      ...localConfig,
      transport: 'websocket',
      websocketUrl,
      _buildCommand: buildCommand,
      _installCommand: installCommand
    } as MCPWebSocketConfig;
  } else if (localConfig.transport === 'sse') {
    // For SSE transport
    finalConfig = {
      ...localConfig,
      transport: 'sse',
      serverUrl,
      _buildCommand: buildCommand,
      _installCommand: installCommand
    } as MCPSSEConfig;
  } else if (localConfig.transport === 'streamable') {
    // For Streamable transport
    finalConfig = {
      ...localConfig,
      transport: 'streamable',
      serverUrl,
      _buildCommand: buildCommand,
      _installCommand: installCommand
    } as MCPStreamableConfig;
  } else {
    // For stdio transport (default)
    finalConfig = {
      ...localConfig,
      transport: 'stdio',
      _buildCommand: buildCommand,
      _installCommand: installCommand
    } as MCPStdioConfig;
  }
  
  if (initialConfig && onUpdate) {
    onUpdate(finalConfig);
  } else {
    onAdd(finalConfig);
  }
  
  if (onClose) {
    onClose();
  }
};

export const handleFolderSelect = async (
  index: number,
  localConfig: MCPServerConfig,
  handleArgChange: (index: number, value: string) => void
) => {
  try {
    // Note: We can't directly specify a custom starting directory due to security restrictions
    // The File System Access API only allows starting in well-known directories
    
    // @ts-ignore - window.showDirectoryPicker is experimental
    const dirHandle = await window.showDirectoryPicker();
    
    // Due to browser security restrictions, we can't directly get the absolute path
    // Instead, we'll construct it based on the project structure
    
    // Get the MCP servers directory from the API
    const basePath = await getMCPServersDir();
    const dirName = localConfig.name || dirHandle.name;
    const absolutePath = `${basePath}/${dirName}`;
    
    // Normalize path by replacing backslashes with forward slashes
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    handleArgChange(index, normalizedPath);
  } catch (error) {
    console.error('Failed to select folder:', error);
  }
};

export const handleRootPathSelect = async (
  localConfig: MCPServerConfig,
  setLocalConfig: (config: MCPServerConfig) => void
) => {
  try {
    // Note: We can't directly specify a custom starting directory due to security restrictions
    // The File System Access API only allows starting in well-known directories
    
    // @ts-ignore - window.showDirectoryPicker is experimental
    const dirHandle = await window.showDirectoryPicker();
    
    // Due to browser security restrictions, we can't directly get the absolute path
    // Instead, we'll construct it based on the project structure
    
    // Get the MCP servers directory from the API
    const basePath = await getMCPServersDir();
    const dirName = localConfig.name || dirHandle.name;
    const absolutePath = `${basePath}/${dirName}`;
    
    // Normalize path by replacing backslashes with forward slashes
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    setLocalConfig({
      ...localConfig,
      rootPath: normalizedPath
    });
  } catch (error) {
    console.error('Failed to select folder:', error);
  }
};

export const handleParseClipboard = async (
  localConfig: MCPServerConfig,
  setLocalConfig: (config: MCPServerConfig) => void,
  setMessage: (message: MessageState | null) => void,
  setBuildCommand: (command: string) => void,
  setInstallCommand: (command: string) => void,
  setWebsocketUrl: (url: string) => void,
  websocketUrl: string
) => {
  // Parse only server config from clipboard (not env variables)
  // Pass the server name for path processing
  const result = await parseConfigFromClipboard(localConfig, localConfig.name);
  
  if (result.message) {
    setMessage(result.message);
  }
  
  if (result.config) {
    // Create a new config object without overriding existing env variables
    // We need to ensure the config has the correct type
    if (result.config.transport === 'websocket') {
      setLocalConfig({
        ...result.config,
        env: localConfig.env, // Keep existing env variables
        transport: 'websocket',
        websocketUrl: (result.config as MCPWebSocketConfig).websocketUrl || websocketUrl
      } as MCPWebSocketConfig);
    } else {
      // Default to stdio transport
      setLocalConfig({
        ...result.config,
        env: localConfig.env, // Keep existing env variables
        transport: 'stdio',
        command: (result.config as MCPStdioConfig).command || '',
        args: (result.config as MCPStdioConfig).args || []
      } as MCPStdioConfig);
    }
    
    // Set build and install commands if found in clipboard
    if (result.config._buildCommand) {
      setBuildCommand(result.config._buildCommand);
    }
    if (result.config._installCommand) {
      setInstallCommand(result.config._installCommand);
    }
  }
};

export const handleParseEnvClipboard = async (
  localConfig: MCPServerConfig,
  setLocalConfig: (config: MCPServerConfig) => void,
  setMessage: (message: MessageState | null) => void,
  setIsParsingEnv: (isParsingEnv: boolean) => void
) => {
  setIsParsingEnv(true);
  setMessage({
    type: 'success',
    text: 'Parsing environment variables from clipboard...'
  });
  
  try {
    const result = await parseEnvFromClipboard();
    
    if (result.message) {
      setMessage(result.message);
    }
    
    if (result.env && Object.keys(result.env).length > 0) {
      // Merge with existing env variables
      const mergedEnv = { ...localConfig.env, ...result.env };
      
      // Create a new config with the merged env
      let updatedConfig: MCPServerConfig;
      
      if (isStdioConfig(localConfig)) {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        } as MCPStdioConfig;
      } else if (isWebSocketConfig(localConfig)) {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        } as MCPWebSocketConfig;
      } else if (isSSEConfig(localConfig)) {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        } as MCPSSEConfig;
      } else if (isStreamableConfig(localConfig)) {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        } as MCPStreamableConfig;
      } else {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        };
      }
      
      setLocalConfig(updatedConfig);
    }
  } catch (error) {
    console.error('Error parsing env variables from clipboard:', error);
    setMessage({
      type: 'error',
      text: `Error parsing env variables: ${(error as Error).message || 'Unknown error'}`
    });
  } finally {
    setIsParsingEnv(false);
  }
};

export const handleParseEnvExample = async (
  localConfig: MCPServerConfig,
  setLocalConfig: (config: MCPServerConfig) => void,
  setMessage: (message: MessageState | null) => void,
  setIsParsingEnv: (isParsingEnv: boolean) => void
) => {
  setIsParsingEnv(true);
  setMessage({
    type: 'success',
    text: 'Parsing environment variables from .env.example...'
  });
  
  try {
    if (!localConfig.name) {
      throw new Error('Please specify a server name first');
    }
    
    // Construct the .env.example path
    const serverName = localConfig.name;
    const envPath = `${serverName}/.env.example`;
    
    const result = await parseEnvFromFile(envPath);
    
    if (result.message) {
      setMessage(result.message);
    }
    
    if (result.env && Object.keys(result.env).length > 0) {
      // Merge with existing env variables
      const mergedEnv = { ...localConfig.env, ...result.env };
      
      // Create a new config with the merged env
      let updatedConfig: MCPServerConfig;
      
      if (isStdioConfig(localConfig)) {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        } as MCPStdioConfig;
      } else if (isWebSocketConfig(localConfig)) {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        } as MCPWebSocketConfig;
      } else if (isSSEConfig(localConfig)) {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        } as MCPSSEConfig;
      } else if (isStreamableConfig(localConfig)) {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        } as MCPStreamableConfig;
      } else {
        updatedConfig = {
          ...localConfig,
          env: mergedEnv
        };
      }
      
      setLocalConfig(updatedConfig);
    }
  } catch (error) {
    console.error('Error parsing .env.example file:', error);
    setMessage({
      type: 'error',
      text: `Error parsing .env.example: ${(error as Error).message || 'Unknown error'}`
    });
  } finally {
    setIsParsingEnv(false);
  }
};

export const handleParseReadme = async (
  localConfig: MCPServerConfig,
  setLocalConfig: (config: MCPServerConfig) => void,
  setMessage: (message: MessageState | null) => void,
  setIsParsingReadme: (isParsingReadme: boolean) => void,
  setBuildCommand: (command: string) => void,
  setInstallCommand: (command: string) => void,
  setWebsocketUrl: (url: string) => void,
  websocketUrl: string
) => {
  setIsParsingReadme(true);
  setMessage({
    type: 'success',
    text: 'Parsing README.md from repository root...'
  });
  
  try {
    if (!localConfig.name) {
      throw new Error('Please specify a server name first');
    }
    
    // Construct the README path - just the server name and README.md
    const serverName = localConfig.name;
    const readmePath = `${serverName}/README.md`;
    
    // Prepare request body with savePath parameter (not path)
    const requestBody = {
      action: 'readFile',
      savePath: readmePath,
    };
    
    // Call the server-side API to read the README file
    const readmeResponse = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    console.log('DEBUG - API response status:', readmeResponse.status);
    
    if (!readmeResponse.ok) {
      throw new Error('Failed to read README file from repository root');
    }
    
    const readmeResult = await readmeResponse.json();
    if (!readmeResult.content) {
      throw new Error('README file is empty');
    }
    
    // Parse README content
    const parseResult = await parseConfigFromReadme(
      readmeResult.content,
      localConfig,
      localConfig.name  // Pass the server name for path processing
    );
    console.log('DEBUG - Parsing README content with repository root path:', localConfig.name);
    
    if (parseResult.message) {
      setMessage(parseResult.message);
    }
    
    if (parseResult.config) {
      // We need to ensure the config has the correct type
      if (parseResult.config.transport === 'websocket') {
        setLocalConfig({
          ...parseResult.config,
          transport: 'websocket',
          websocketUrl: (parseResult.config as MCPWebSocketConfig).websocketUrl || websocketUrl
        } as MCPWebSocketConfig);
        
        // Update websocketUrl state if it's in the parsed config
        if ((parseResult.config as MCPWebSocketConfig).websocketUrl) {
          setWebsocketUrl((parseResult.config as MCPWebSocketConfig).websocketUrl);
        }
      } else {
        // Default to stdio transport
        setLocalConfig({
          ...parseResult.config,
          transport: 'stdio',
          command: (parseResult.config as MCPStdioConfig).command || '',
          args: (parseResult.config as MCPStdioConfig).args || []
        } as MCPStdioConfig);
      }
      
      // Set build and install commands if found in README
      if (parseResult.config._buildCommand) {
        setBuildCommand(parseResult.config._buildCommand);
      }
      if (parseResult.config._installCommand) {
        setInstallCommand(parseResult.config._installCommand);
      }
    }
  } catch (error) {
    console.error('Error parsing README:', error);
    setMessage({
      type: 'error',
      text: `Error parsing README: ${(error as Error).message || 'Unknown error'}`
    });
  } finally {
    setIsParsingReadme(false);
  }
};

export const handleInstall = async (
  localConfig: MCPServerConfig,
  installCommand: string,
  setIsInstalling: (isInstalling: boolean) => void,
  setBuildMessage: (message: MessageState | null) => void,
  setConsoleTitle: (title: string) => void,
  setIsConsoleVisible: (isVisible: boolean) => void,
  setConsoleOutput: (output: string | ((prev: string) => string)) => void,
  setInstallCompleted: (completed: boolean) => void
) => {
  if (!localConfig.name) {
    setBuildMessage({
      type: 'error',
      text: 'Please specify a server name first'
    });
    return;
  }
  
  setIsInstalling(true);
  setBuildMessage({
    type: 'success',
    text: 'Installing dependencies...'
  });
  
  console.log('DEBUG - Installing dependencies for server:', localConfig.name);
  // Use rootPath if available, otherwise fall back to name
  const serverPath = localConfig.rootPath || `mcp-servers/${localConfig.name}`;
  const result = await installDependencies(serverPath, installCommand);
  
  // Set console title and make it visible
  setConsoleTitle('Install Dependencies Output');
  setIsConsoleVisible(true);
  
  // Update console output with the command result
  if (result.output) {
    setConsoleOutput(result.output);
  } else {
    setConsoleOutput(`Executing: ${installCommand}\n\nCommand completed successfully, but no output was returned.`);
  }
  
  // Set a brief message with instructions to check the console
  if (result.success) {
    setInstallCompleted(true);
    setBuildMessage({
      type: 'success',
      text: 'Dependencies installed successfully. Check the console for more information.'
    });
  } else {
    setBuildMessage({
      type: 'error',
      text: `Failed to install dependencies. Check the console for more information.`
    });
  }
  
  setIsInstalling(false);
};

export const handleBuild = async (
  localConfig: MCPServerConfig,
  buildCommand: string,
  setIsBuilding: (isBuilding: boolean) => void,
  setBuildMessage: (message: MessageState | null) => void,
  setConsoleTitle: (title: string) => void,
  setIsConsoleVisible: (isVisible: boolean) => void,
  setConsoleOutput: (output: string | ((prev: string) => string)) => void,
  setBuildCompleted: (completed: boolean) => void
) => {
  if (!localConfig.name) {
    setBuildMessage({
      type: 'error',
      text: 'Please specify a server name first'
    });
    return;
  }
  
  setIsBuilding(true);
  setBuildMessage({
    type: 'success',
    text: 'Building server...'
  });
  
  console.log('DEBUG - Building server:', localConfig.name);
  // Use rootPath if available, otherwise fall back to name with mcp-servers prefix
  const serverPath = localConfig.rootPath || `mcp-servers/${localConfig.name}`;
  // CRITICAL FIX: Use savePath parameter name for consistency with API
  const result = await buildServer(serverPath, buildCommand);
  
  // Set console title and make it visible
  setConsoleTitle('Build Server Output');
  setIsConsoleVisible(true);
  
  // Update console output with the command result
  if (result.output) {
    setConsoleOutput(result.output);
  } else {
    setConsoleOutput(`Executing: ${buildCommand}\n\nCommand completed successfully, but no output was returned.`);
  }
  
  // Set a brief message with instructions to check the console
  if (result.success) {
    setBuildCompleted(true);
    setBuildMessage({
      type: 'success',
      text: 'Server built successfully. Check the console for more information.'
    });
  } else {
    setBuildMessage({
      type: 'error',
      text: `Failed to build server. Check the console for more information.`
    });
  }
  
  setIsBuilding(false);
};

// MCP Protocol connection test utilities
// These functions test actual MCP protocol compatibility, not just HTTP reachability

interface TestResult {
  success: boolean;
  message: string;
  details?: string;
}

/**
 * Test Streamable HTTP connection by sending a proper MCP initialize request
 */
const testStreamableConnection = async (serverUrl: string): Promise<TestResult> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    // Send a proper MCP initialize request (JSON-RPC 2.0)
    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'FLUJO-MCP-Test',
          version: '1.0.0'
        }
      }
    };
    
    const response = await fetch(serverUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'User-Agent': 'FLUJO-MCP-Client/1.0'
      },
      body: JSON.stringify(initializeRequest)
    });
    
    clearTimeout(timeoutId);
    
    // Check if we got a valid JSON-RPC response
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const isEventStream = contentType.includes('text/event-stream');
    
    if (!response.ok) {
      // For streamable HTTP, non-2xx responses might still be valid MCP responses
      // (e.g., 401 for auth required, 400 for malformed request but server is reachable)
      if (response.status === 401) {
        return {
          success: true,
          message: 'Server reachable - requires authentication (401)',
          details: 'This server requires OAuth authentication. Save the configuration to initiate the OAuth flow.'
        };
      }
      
      // Try to parse response as JSON-RPC error
      if (isJson) {
        try {
          const json = await response.json();
          if (json && json.jsonrpc === '2.0' && (json.error || json.result)) {
            return {
              success: true,
              message: `Server reachable - MCP endpoint responded with ${json.error ? 'error' : 'result'}`,
              details: `Status: ${response.status} ${response.statusText}`
            };
          }
        } catch {
          // Not valid JSON, fall through
        }
      }
      
      return {
        success: false,
        message: `Server responded with HTTP ${response.status}`,
        details: `Status: ${response.status} ${response.statusText}. This may indicate the endpoint is not a valid MCP streamable HTTP server.`
      };
    }
    
    // For successful responses, try to parse as JSON-RPC
    if (isJson) {
      try {
        const json = await response.json();
        if (json && json.jsonrpc === '2.0' && (json.result || json.error)) {
          return {
            success: true,
            message: json.result ? 'MCP connection test successful!' : 'MCP endpoint responded with error',
            details: json.result 
              ? `Server capabilities: ${JSON.stringify(json.result.capabilities || {})}`
              : `MCP Error: ${json.error?.message || 'Unknown error'}`
          };
        }
      } catch {
        // Not valid JSON-RPC
      }
    }
    
    // If we got a 2xx but not valid JSON-RPC, it might be an SSE stream
    if (isEventStream) {
      return {
        success: true,
        message: 'Server reachable - appears to be an SSE endpoint',
        details: 'Received text/event-stream response. This may be an SSE transport endpoint.'
      };
    }
    
    return {
      success: false,
      message: 'Server responded but not with valid MCP protocol',
      details: `Status: ${response.status} ${response.statusText}, Content-Type: ${contentType}`
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          message: 'Connection timeout',
          details: 'Server did not respond within 10 seconds'
        };
      }
      return {
        success: false,
        message: 'Connection failed',
        details: error.message
      };
    }
    return {
      success: false,
      message: 'Connection failed',
      details: 'Unknown error occurred'
    };
  }
};

/**
 * Test SSE connection by attempting to establish an EventSource
 */
const testSSEConnection = async (serverUrl: string): Promise<TestResult> => {
  return new Promise((resolve) => {
    let eventSource: EventSource | null = null;
    let resolved = false;
    
    const timeoutId = setTimeout(() => {
      if (!resolved && eventSource) {
        eventSource.close();
        resolved = true;
        resolve({
          success: false,
          message: 'Connection timeout',
          details: 'SSE connection did not establish within 10 seconds'
        });
      }
    }, 10000);
    
    try {
      eventSource = new EventSource(serverUrl);
      
      eventSource.onopen = () => {
        if (!resolved) {
          clearTimeout(timeoutId);
          eventSource?.close();
          resolved = true;
          resolve({
            success: true,
            message: 'SSE connection test successful!',
            details: 'EventSource connection established successfully'
          });
        }
      };
      
      eventSource.onerror = (error) => {
        if (!resolved) {
          clearTimeout(timeoutId);
          eventSource?.close();
          resolved = true;
          
          // Check if it's a 401 (auth required) - EventSource doesn't expose status codes directly
          // but we can infer from the error
          resolve({
            success: true, // Connection was established, just auth issue
            message: 'Server reachable - SSE connection established (may require auth)',
            details: 'SSE endpoint is reachable. If authentication is required, save the configuration to initiate OAuth flow.'
          });
        }
      };
    } catch (error) {
      if (!resolved) {
        clearTimeout(timeoutId);
        resolved = true;
        resolve({
          success: false,
          message: 'Connection failed',
          details: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      }
    }
  });
};

/**
 * Test WebSocket connection by attempting to establish a WebSocket
 */
const testWebSocketConnection = async (websocketUrl: string): Promise<TestResult> => {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let resolved = false;
    
    const timeoutId = setTimeout(() => {
      if (!resolved && ws) {
        ws.close();
        resolved = true;
        resolve({
          success: false,
          message: 'Connection timeout',
          details: 'WebSocket connection did not establish within 10 seconds'
        });
      }
    }, 10000);
    
    try {
      ws = new WebSocket(websocketUrl);
      
      ws.onopen = () => {
        if (!resolved) {
          clearTimeout(timeoutId);
          ws?.close();
          resolved = true;
          resolve({
            success: true,
            message: 'WebSocket connection test successful!',
            details: 'WebSocket connection established successfully'
          });
        }
      };
      
      ws.onerror = (error) => {
        if (!resolved) {
          clearTimeout(timeoutId);
          ws?.close();
          resolved = true;
          resolve({
            success: false,
            message: 'WebSocket connection failed',
            details: 'Failed to establish WebSocket connection. Check the URL and ensure the server is running.'
          });
        }
      };
      
      ws.onclose = (event) => {
        if (!resolved) {
          clearTimeout(timeoutId);
          resolved = true;
          if (event.code === 1000 || event.code === 1001) {
            resolve({
              success: true,
              message: 'WebSocket connection test successful!',
              details: 'WebSocket connection was established and closed normally'
            });
          } else {
            resolve({
              success: false,
              message: 'WebSocket connection closed unexpectedly',
              details: `Close code: ${event.code}, Reason: ${event.reason || 'No reason provided'}`
            });
          }
        }
      };
    } catch (error) {
      if (!resolved) {
        clearTimeout(timeoutId);
        resolved = true;
        resolve({
          success: false,
          message: 'Connection failed',
          details: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      }
    }
  });
};

export const handleRun = async (
  localConfig: MCPServerConfig,
  websocketUrl: string,
  serverUrl: string,
  setIsRunning: (isRunning: boolean) => void,
  setConsoleTitle: (title: string) => void,
  setConsoleOutput: (output: string | ((prev: string) => string)) => void,
  setIsConsoleVisible: (isVisible: boolean) => void,
  setMessage: (message: MessageState | null) => void,
  setRunCompleted: (completed: boolean) => void
) => {
  if (!localConfig.name) {
    setMessage({
      type: 'error',
      text: 'Please specify a server name first'
    });
    return;
  }
  
  if (isStdioConfig(localConfig) && !localConfig.command) {
    setMessage({
      type: 'error',
      text: 'Please specify a run command first'
    });
    return;
  }
  
  // Validate URLs based on transport type
  if (localConfig.transport === 'websocket' && !websocketUrl) {
    setMessage({
      type: 'error',
      text: 'Please enter a valid WebSocket URL'
    });
    return;
  }
  
  if ((localConfig.transport === 'sse' || localConfig.transport === 'streamable') && !serverUrl) {
    setMessage({
      type: 'error',
      text: 'Please enter a valid Server URL'
    });
    return;
  }
  
  setIsRunning(true);
  setConsoleTitle('Test Server Connection');
  setConsoleOutput('Testing server connection...\n');
  setIsConsoleVisible(true);
  setMessage({
    type: 'success',
    text: 'Testing server connection...'
  });
  
  // For HTTP streaming transports (SSE and Streamable), test the connection instead of spawning a process
  if (localConfig.transport === 'sse' || localConfig.transport === 'streamable') {
    try {
      setConsoleOutput((prev: string) => prev + `Attempting to connect to: ${serverUrl}\n`);
      
      // Use transport-specific test function
      const testResult = localConfig.transport === 'streamable'
        ? await testStreamableConnection(serverUrl)
        : await testSSEConnection(serverUrl);
      
      setConsoleOutput((prev: string) => prev + `Connection test result: ${testResult.message}\n`);
      if (testResult.details) {
        setConsoleOutput((prev: string) => prev + `Details: ${testResult.details}\n`);
      }
      
      if (testResult.success) {
        setRunCompleted(true);
        setMessage({
          type: 'success',
          text: 'Connection test successful! Server is reachable.'
        });
        setConsoleOutput((prev: string) => prev + '\n✅ Server connection test passed!\n');
      } else {
        setMessage({
          type: 'error',
          text: 'Connection test failed. Check the console for details.'
        });
        setConsoleOutput((prev: string) => prev + '\n❌ Server connection test failed.\n');
      }
    } catch (error) {
      console.error('Error testing connection:', error);
      setConsoleOutput((prev: string) => prev + `\nError during connection test: ${(error as Error).message}\n`);
      setMessage({
        type: 'error',
        text: 'Connection test failed with an error.'
      });
    } finally {
      setIsRunning(false);
    }
    return;
  }
  
  // For WebSocket transport, test the connection
  if (localConfig.transport === 'websocket') {
    try {
      setConsoleOutput((prev: string) => prev + `WebSocket URL: ${websocketUrl}\n`);
      
      const testResult = await testWebSocketConnection(websocketUrl);
      
      setConsoleOutput((prev: string) => prev + `Connection test result: ${testResult.message}\n`);
      if (testResult.details) {
        setConsoleOutput((prev: string) => prev + `Details: ${testResult.details}\n`);
      }
      
      if (testResult.success) {
        setRunCompleted(true);
        setMessage({
          type: 'success',
          text: 'WebSocket connection test successful!'
        });
        setConsoleOutput((prev: string) => prev + '\n✅ WebSocket connection test passed!\n');
      } else {
        setMessage({
          type: 'error',
          text: 'WebSocket connection test failed. Check the console for details.'
        });
        setConsoleOutput((prev: string) => prev + '\n❌ WebSocket connection test failed.\n');
      }
    } catch (error) {
      console.error('Error testing WebSocket connection:', error);
      setConsoleOutput((prev: string) => prev + `\nError during connection test: ${(error as Error).message}\n`);
      setMessage({
        type: 'error',
        text: 'Connection test failed with an error.'
      });
    } finally {
      setIsRunning(false);
    }
    return;
  }
  
  // For stdio transport, use the original process spawning logic
  const serverPath = localConfig.rootPath || `mcp-servers/${localConfig.name}`;
  
  try {
    setConsoleOutput((prev: string) => prev + 'Starting server process...\n');
    
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'run',
        savePath: serverPath,
        runCommand: isStdioConfig(localConfig) ? localConfig.command : '',
        args: isStdioConfig(localConfig) ? localConfig.args || [] : [],
        env: isStdioConfig(localConfig) ? localConfig.env || {} : {}
      }),
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(result.error || 'Failed to run server');
    }
    
    // Check if result has commandOutput
    if (result.commandOutput) {
      setConsoleOutput((consoleOutput: string) => consoleOutput + result.commandOutput + '\n');
    } else {
      setConsoleOutput((consoleOutput: string) => consoleOutput + 'Command executed successfully, but no output was returned.\n');
    }
    setRunCompleted(true);
    setMessage({
      type: 'success',
      text: 'Server running successfully. Check the console for more information.'
    });
  } catch (error) {
    console.error('Error running server:', error);
    
    // Add more detailed error information to console output
    setConsoleOutput((consoleOutput: string) => consoleOutput + `Error: ${(error as Error).message}\n`);
    
    // Try to extract more details if available
    let errorDetails = '';
    if (error instanceof Response) {
      errorDetails = ` (Status: ${error.status})`;
    } else if (typeof error === 'object' && error !== null) {
      errorDetails = ` (${JSON.stringify(error)})`;
    }
    
    // this error is now handled in RunTools 
  } finally {
    setIsRunning(false);
  }
};
