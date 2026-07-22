'use client';

import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig, MCPSSEConfig, MCPStreamableConfig } from '@/shared/types/mcp/mcp';
import { MessageState } from '../../../types';
import { parseConfigFromClipboard, parseConfigFromReadme, parseEnvFromClipboard, parseEnvFromFile } from '../../../utils/configUtils';
import { installDependencies, buildServer } from '../../../utils/buildUtils';
import { isStdioConfig, isWebSocketConfig, isSSEConfig, isStreamableConfig } from '../hooks/useLocalServerState';
import { mcpService } from '@/frontend/services/mcp';
import { TestConnectionEvent } from '@/shared/types/streaming';
import { getTestConnectionTimeoutMs, isRunnerStdioConfig } from '@/utils/mcp/testConnectionTimeout';

/**
 * Assemble the final, saveable server config from the current form state, applying the
 * transport-specific fields exactly the way the Add/Update submit does. Shared by
 * handleSubmit and the "Save & Authenticate" flow so both persist an identical shape.
 */
export const buildFinalConfig = (
  localConfig: MCPServerConfig,
  websocketUrl: string,
  serverUrl: string,
  buildCommand: string,
  installCommand: string
): MCPServerConfig => {
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

  // Install-origin (#193): every upstream tab (GitHub/Remote/Reference/Marketplace/
  // Spotlight) hands its config off through here, so preserve any `source` it set and
  // default to `local` only for a genuinely hand-configured server.
  return { ...finalConfig, source: finalConfig.source ?? { type: 'local' } } as MCPServerConfig;
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
  const finalConfig = buildFinalConfig(localConfig, websocketUrl, serverUrl, buildCommand, installCommand);

  if (initialConfig && onUpdate) {
    onUpdate(finalConfig);
  } else {
    onAdd(finalConfig);
  }
  
  if (onClose) {
    onClose();
  }
};

// The old handleFolderSelect/handleRootPathSelect helpers (browser
// File System Access API) were removed: the browser cannot browse the
// BACKEND's filesystem (which may be a different machine) nor return real
// absolute paths — it synthesized "<mcpServersDir>/<name>" regardless of what
// the user picked. Folder selection now goes through the shared
// FolderPickerDialog, which browses server-side via /api/browse.

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
          ...(localConfig as MCPServerConfig),
          env: mergedEnv
        } as MCPServerConfig;
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
          ...(localConfig as MCPServerConfig),
          env: mergedEnv
        } as MCPServerConfig;
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

  // Show the console up front and stream output into it as it arrives (#65).
  setConsoleTitle('Install Dependencies Output');
  setIsConsoleVisible(true);
  setConsoleOutput(`Executing: ${installCommand}\n\n`);

  console.log('DEBUG - Installing dependencies for server:', localConfig.name);
  // Use rootPath if available, otherwise fall back to name
  const serverPath = localConfig.rootPath || `mcp-servers/${localConfig.name}`;
  let streamedAny = false;
  const result = await installDependencies(serverPath, installCommand, (chunk) => {
    streamedAny = true;
    setConsoleOutput((prev: string) => prev + chunk);
  });

  // If nothing streamed (e.g. the non-streaming fallback ran), append the final blob so
  // the console is never left with only the "Executing:" header.
  if (!streamedAny) {
    setConsoleOutput((prev: string) => prev +
      (result.output || 'Command completed successfully, but no output was returned.'));
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

  // Show the console up front and stream output into it as it arrives (#65).
  setConsoleTitle('Build Server Output');
  setIsConsoleVisible(true);
  setConsoleOutput(`Executing: ${buildCommand}\n\n`);

  console.log('DEBUG - Building server:', localConfig.name);
  // Use rootPath if available, otherwise fall back to name with mcp-servers prefix
  const serverPath = localConfig.rootPath || `mcp-servers/${localConfig.name}`;
  // CRITICAL FIX: Use savePath parameter name for consistency with API
  let streamedAny = false;
  const result = await buildServer(serverPath, buildCommand, (chunk) => {
    streamedAny = true;
    setConsoleOutput((prev: string) => prev + chunk);
  });

  // If nothing streamed (e.g. the non-streaming fallback ran), append the final blob so
  // the console is never left with only the "Executing:" header.
  if (!streamedAny) {
    setConsoleOutput((prev: string) => prev +
      (result.output || 'Command completed successfully, but no output was returned.'));
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

export const handleRun = async (
  localConfig: MCPServerConfig,
  websocketUrl: string,
  serverUrl: string,
  setIsRunning: (isRunning: boolean) => void,
  setConsoleTitle: (title: string) => void,
  setConsoleOutput: (output: string | ((prev: string) => string)) => void,
  setIsConsoleVisible: (isVisible: boolean) => void,
  setMessage: (message: MessageState | null) => void,
  setRunCompleted: (completed: boolean) => void,
  // The pre-edit server name (initialConfig?.name). Sent with the test request so the
  // backend can hydrate masked secret headers from the saved config, even after a rename
  // (#137). Undefined for a brand-new server (nothing stored to hydrate from).
  storedName?: string,
  // Reports whether a reachable-but-unauthenticated remote server advertises OAuth (RFC
  // 9728), so the modal can offer "Save & Authenticate" instead of only a header hint.
  setOauthCapable?: (capable: boolean) => void
) => {
  // A fresh run supersedes any earlier auth verdict.
  setOauthCapable?.(false);
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

  // Forward live probe output (server stderr + lifecycle markers) to the console as it
  // arrives (#64), so a slow cold npx/uvx start no longer looks frozen. The final
  // success/auth/failure messaging is still driven off the returned result below.
  const onStreamEvent = (event: TestConnectionEvent) => {
    if (event.type === 'stderr' || event.type === 'stdout') {
      setConsoleOutput((prev: string) => prev + event.data);
    } else if (event.type === 'status' && event.message) {
      setConsoleOutput((prev: string) => prev + event.message + '\n');
    }
  };
  
  // For HTTP streaming transports (SSE and Streamable), test the connection through the
  // FLUJO backend rather than a browser fetch. The browser runs in a different process
  // that does not share Node's TLS trust (custom CA) and cannot send the configured
  // custom headers, so a browser-side fetch fails with an opaque "Failed to fetch".
  if (localConfig.transport === 'sse' || localConfig.transport === 'streamable') {
    try {
      setConsoleOutput((prev: string) => prev + `Attempting to connect (via FLUJO backend) to: ${serverUrl}\n`);

      // Build the config to test from the current form state (serverUrl may be newer than
      // what is stored on localConfig). Custom headers already live on localConfig.
      const testConfig = { ...localConfig, serverUrl } as MCPServerConfig;
      const headerCount = Object.keys((localConfig as MCPStreamableConfig | MCPSSEConfig).headers || {}).length;
      if (headerCount > 0) {
        setConsoleOutput((prev: string) => prev + `Sending ${headerCount} custom header(s).\n`);
      }

      const testResult = await mcpService.testConnectionStreaming(testConfig, onStreamEvent, storedName);

      if (testResult.success) {
        setRunCompleted(true);
        const toolCount = testResult.data?.toolCount;
        setMessage({
          type: 'success',
          text: 'Connection test successful! Server is reachable.'
        });
        setConsoleOutput((prev: string) => prev +
          `Connection test result: MCP handshake successful${typeof toolCount === 'number' ? ` (${toolCount} tool${toolCount === 1 ? '' : 's'} discovered)` : ''}\n`);
        setConsoleOutput((prev: string) => prev + '\n✅ Server connection test passed!\n');
      } else if (testResult.requiresAuthentication) {
        // Reachable, but needs auth — surface as actionable info rather than a hard failure.
        setConsoleOutput((prev: string) => prev + `Connection test result: authentication required\n`);
        if (testResult.error) {
          setConsoleOutput((prev: string) => prev + `Details: ${testResult.error}\n`);
        }

        // OAuth-capable (RFC 9728) streamable servers get an in-modal "Save & Authenticate"
        // path — no manual header needed. Others (static bearer) keep the header hint.
        if (testResult.oauthCapable && localConfig.transport === 'streamable') {
          setOauthCapable?.(true);
          setMessage({
            type: 'warning',
            text: 'Server reachable — it uses OAuth. Click "Save & Authenticate" to sign in.'
          });
          setConsoleOutput((prev: string) => prev + '\n🔑 Server uses OAuth. Click "Save & Authenticate" to complete sign-in.\n');
        } else {
          setMessage({
            type: 'warning',
            text: 'Server reachable but requires authentication.'
          });
          setConsoleOutput((prev: string) => prev + '\n⚠️ Server requires authentication. Add the required headers (e.g. Authorization) and test again.\n');
        }
      } else {
        setMessage({
          type: 'error',
          text: 'Connection test failed. Check the console for details.'
        });
        setConsoleOutput((prev: string) => prev + `Connection test result: Connection failed\n`);
        setConsoleOutput((prev: string) => prev + `Details: ${testResult.error || 'Unknown error'}\n`);
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
  
  // For WebSocket transport, run the SAME real MCP handshake the live connection uses
  // (FLUJO backend → WebSocketClientTransport → initialize + listTools), rather than a
  // browser-side WebSocket probe. A raw WS open only proves the socket connects — not
  // that the server speaks MCP — and the browser doesn't share Node's TLS trust or
  // custom headers, so its result could diverge from real usage.
  if (localConfig.transport === 'websocket') {
    try {
      setConsoleOutput((prev: string) => prev + `Attempting to connect (via FLUJO backend) to: ${websocketUrl}\n`);

      // websocketUrl from form state may be newer than what's on localConfig.
      const testConfig = { ...localConfig, websocketUrl } as MCPServerConfig;
      const testResult = await mcpService.testConnectionStreaming(testConfig, onStreamEvent);

      if (testResult.success) {
        setRunCompleted(true);
        const toolCount = testResult.data?.toolCount;
        setMessage({
          type: 'success',
          text: 'Connection test successful! Server completed the MCP handshake.'
        });
        setConsoleOutput((prev: string) => prev +
          `Connection test result: MCP handshake successful${typeof toolCount === 'number' ? ` (${toolCount} tool${toolCount === 1 ? '' : 's'} discovered)` : ''}\n`);
        setConsoleOutput((prev: string) => prev + '\n✅ Server connection test passed!\n');
      } else if (testResult.requiresAuthentication) {
        setMessage({
          type: 'warning',
          text: 'Server reachable but requires authentication.'
        });
        setConsoleOutput((prev: string) => prev + `Connection test result: authentication required\n`);
        if (testResult.error) {
          setConsoleOutput((prev: string) => prev + `Details: ${testResult.error}\n`);
        }
        setConsoleOutput((prev: string) => prev + '\n⚠️ Server requires authentication. Add the required credentials and test again.\n');
      } else {
        setMessage({
          type: 'error',
          text: 'Connection test failed. Check the console for details.'
        });
        setConsoleOutput((prev: string) => prev + `Connection test result: Connection failed\n`);
        setConsoleOutput((prev: string) => prev + `Details: ${testResult.error || 'Unknown error'}\n`);
        setConsoleOutput((prev: string) => prev + '\n❌ Server connection test failed.\n');
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
  
  // For stdio transport, run the SAME real MCP handshake the live connection uses
  // (FLUJO backend → createStdioTransport → cross-spawn → initialize + listTools).
  // Going through the production path is deliberate: the test cannot pass or fail
  // differently from actual usage, because argument handling, cwd resolution (#40),
  // Node-path resolution (#36) and env are all identical. (This previously used a
  // one-off `execSync` string via /api/git, which diverged from how the server is
  // really launched and produced "works in test, fails live" confusion.)
  try {
    if (isStdioConfig(localConfig)) {
      const argString = (localConfig.args || []).join(' ');
      setConsoleOutput((prev: string) => prev +
        `Launching (via FLUJO backend): ${localConfig.command}${argString ? ' ' + argString : ''}\n`);

      // Package-runner commands (npx/uvx/bunx/pnpm dlx) may have to download the package
      // on first run, so the backend allows a longer handshake window (issue #43). Tell
      // the user up front so a slow first start doesn't look frozen.
      if (isRunnerStdioConfig(localConfig)) {
        const timeoutSeconds = Math.round(getTestConnectionTimeoutMs(localConfig) / 1000);
        setConsoleOutput((prev: string) => prev +
          `This looks like a package-runner command (npx/uvx). The first run may need to download the package, ` +
          `so the test waits up to ${timeoutSeconds}s before timing out — please wait...\n`);
      }
    }

    const testResult = await mcpService.testConnectionStreaming(localConfig, onStreamEvent);

    if (testResult.success) {
      setRunCompleted(true);
      const toolCount = testResult.data?.toolCount;
      setMessage({
        type: 'success',
        text: 'Connection test successful! Server started and completed the MCP handshake.'
      });
      setConsoleOutput((prev: string) => prev +
        `Connection test result: MCP handshake successful${typeof toolCount === 'number' ? ` (${toolCount} tool${toolCount === 1 ? '' : 's'} discovered)` : ''}\n`);
      setConsoleOutput((prev: string) => prev + '\n✅ Server connection test passed!\n');
    } else if (testResult.requiresAuthentication) {
      setMessage({
        type: 'warning',
        text: 'Server started but requires authentication.'
      });
      setConsoleOutput((prev: string) => prev + `Connection test result: authentication required\n`);
      if (testResult.error) {
        setConsoleOutput((prev: string) => prev + `Details: ${testResult.error}\n`);
      }
      setConsoleOutput((prev: string) => prev + '\n⚠️ Server requires authentication. Add the required credentials (env/headers) and test again.\n');
    } else {
      setMessage({
        type: 'error',
        text: 'Connection test failed. Check the console for details.'
      });
      setConsoleOutput((prev: string) => prev + `Connection test result: Connection failed\n`);
      setConsoleOutput((prev: string) => prev + `Details: ${testResult.error || 'Unknown error'}\n`);
      setConsoleOutput((prev: string) => prev + '\n❌ Server connection test failed.\n');
    }
  } catch (error) {
    console.error('Error testing stdio connection:', error);
    setConsoleOutput((prev: string) => prev + `\nError during connection test: ${(error as Error).message}\n`);
    setMessage({
      type: 'error',
      text: 'Connection test failed with an error.'
    });
  } finally {
    setIsRunning(false);
  }
};
