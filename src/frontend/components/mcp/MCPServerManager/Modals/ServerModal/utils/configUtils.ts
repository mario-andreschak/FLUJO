import { parseServerConfig, parseServerConfigFromClipboard } from '@/utils/mcp';
import { MessageState } from '../types';
import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig } from '@/shared/types/mcp';

// Type guard to check if a config is a StdioConfig
function isStdioConfig(config: Partial<MCPServerConfig>): config is Partial<MCPStdioConfig> {
  return config.transport === 'stdio';
}

// Type guard to check if a config is a WebSocketConfig
function isWebSocketConfig(config: Partial<MCPServerConfig>): config is Partial<MCPWebSocketConfig> {
  return config.transport === 'websocket';
}
export const parseConfigFromReadme = async (
  readmeContent: string,
  defaultConfig: MCPServerConfig,
  serverName?: string
): Promise<{
  config: MCPServerConfig;
  message: MessageState | null;
}> => {
  try {
    // Parse README content using the server config parser
    // Set parseEnvVars to false to only parse server config (not env variables)
    // Pass the server name for path processing
    const serverNameToUse = serverName || defaultConfig.name;
    const parseResult = parseServerConfig(readmeContent, false, serverNameToUse);
    
    if (parseResult.config && Object.keys(parseResult.config).length > 0) {
      // Use the parsed config to pre-fill the form
      // Create a base merged config without the command property
      const baseConfig = {
        ...defaultConfig,
        ...parseResult.config,
        // Always use the repository name from defaultConfig instead of the parsed name
        name: defaultConfig.name,
        // Merge env variables
        env: { ...defaultConfig.env, ...parseResult.config.env },
      };
      
      // Add command property only if it's a stdio transport or if command exists in parsed config
      const hasCommand = 'command' in parseResult.config;
      const mergedConfig: MCPServerConfig = isStdioConfig(baseConfig) || hasCommand
        ? {
            ...baseConfig,
            command: hasCommand ? (parseResult.config as any).command || '' : '',
            transport: baseConfig.transport || 'stdio'
          } as MCPStdioConfig
        : {
            ...baseConfig,
            transport: baseConfig.transport || 'websocket',
            websocketUrl: (baseConfig as Partial<MCPWebSocketConfig>).websocketUrl || ''
          } as MCPWebSocketConfig;
      
      return {
        config: mergedConfig,
        message: {
          type: 'success',
          text: `Server configuration extracted from README.`
        }
      };
    } else {
      return {
        config: defaultConfig,
        message: {
          type: 'warning',
          text: 'No server configuration found in README.'
        }
      };
    }
  } catch (error) {
    console.error('Error parsing README:', error);
    return {
      config: defaultConfig,
      message: {
        type: 'error',
        text: `Error parsing README: ${(error as Error).message || 'Unknown error'}`
      }
    };
  }
};

export const parseConfigFromClipboard = async (
  defaultConfig: Partial<MCPServerConfig>,
  serverName?: string
): Promise<{
  config: Partial<MCPServerConfig>;
  message: MessageState | null;
}> => {
  try {
    // Use the existing parseServerConfig function with clipboard text
    // Set parseEnvVars to false to only parse server config (not env variables)
    // Pass the server name for path processing
    const serverNameToUse = serverName || defaultConfig.name;
    const result = await window.navigator.clipboard.readText()
      .then(text => parseServerConfig(text, false, serverNameToUse));
    
    if (result.config && Object.keys(result.config).length > 0) {
      // Use the parsed config to pre-fill the form
      // Create a base merged config without the command property
      const baseConfig = {
        ...defaultConfig,
        ...result.config,
        // Always use the name from defaultConfig instead of the parsed name
        name: defaultConfig.name,
        // Ensure env is merged correctly
        env: { ...defaultConfig.env, ...result.config.env },
      };
      
      // Add command property only if it's a stdio transport or if command exists in parsed config
      const hasCommand = 'command' in result.config;
      const mergedConfig: MCPServerConfig = isStdioConfig(baseConfig) || hasCommand
        ? {
            ...baseConfig,
            command: hasCommand ? (result.config as any).command || '' : '',
            transport: baseConfig.transport || 'stdio'
          } as MCPStdioConfig
        : {
            ...baseConfig,
            transport: baseConfig.transport || 'websocket',
            websocketUrl: (baseConfig as Partial<MCPWebSocketConfig>).websocketUrl || ''
          } as MCPWebSocketConfig;
      
      return {
        config: mergedConfig,
        message: result.message || {
          type: 'success',
          text: 'Configuration parsed from clipboard.'
        }
      };
    } else {
      return {
        config: defaultConfig,
        message: result.message || {
          type: 'warning',
          text: 'No valid configuration found in clipboard.'
        }
      };
    }
  } catch (error) {
    console.error('Error parsing clipboard:', error);
    return {
      config: defaultConfig,
      message: {
        type: 'error',
        text: `Error parsing clipboard: ${(error as Error).message || 'Unknown error'}`
      }
    };
  }
};

export const parseEnvVariables = (
  envText: string
): Record<string, string> => {
  try {
    return envText.split('\n')
      .filter(line => line.trim() !== '')
      .reduce((acc, line) => {
        const [key, val] = line.split('=').map(s => s.trim());
        if (key && val) {
          acc[key] = val;
        }
        return acc;
      }, {} as Record<string, string>);
  } catch (error) {
    console.error('Failed to parse env variables:', error);
    return {};
  }
};

export const formatEnvVariables = (
  env: Record<string, string>
): string => {
  return Object.entries(env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
};

/**
 * Parse environment variables from a .env file content
 */
export const parseEnvFromFile = async (
  filePath: string
): Promise<{
  env: Record<string, string>;
  message: MessageState | null;
}> => {
  try {
    // Prepare request body with savePath parameter
    const requestBody = {
      action: 'readFile',
      savePath: filePath,
    };
    
    // Call the server-side API to read the file
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to read file: ${filePath}`);
    }
    
    const result = await response.json();
    if (!result.content) {
      throw new Error('File is empty');
    }
    
    // Parse the env variables from the file content
    const env = parseEnvVariables(result.content);
    
    if (Object.keys(env).length === 0) {
      return {
        env: {},
        message: {
          type: 'warning',
          text: 'No environment variables found in the file.'
        }
      };
    }
    
    return {
      env,
      message: {
        type: 'success',
        text: `${Object.keys(env).length} environment variables extracted from file.`
      }
    };
  } catch (error) {
    console.error('Error parsing env file:', error);
    return {
      env: {},
      message: {
        type: 'error',
        text: `Error parsing env file: ${(error as Error).message || 'Unknown error'}`
      }
    };
  }
};

/**
 * Parse environment variables from clipboard content
 */
export const parseEnvFromClipboard = async (): Promise<{
  env: Record<string, string>;
  message: MessageState | null;
}> => {
  try {
    const clipboardText = await window.navigator.clipboard.readText();
    
    // Parse the env variables from the clipboard content
    const env = parseEnvVariables(clipboardText);
    
    if (Object.keys(env).length === 0) {
      return {
        env: {},
        message: {
          type: 'warning',
          text: 'No environment variables found in clipboard content.'
        }
      };
    }
    
    return {
      env,
      message: {
        type: 'success',
        text: `${Object.keys(env).length} environment variables extracted from clipboard.`
      }
    };
  } catch (error) {
    console.error('Error parsing clipboard for env variables:', error);
    return {
      env: {},
      message: {
        type: 'error',
        text: `Error parsing clipboard: ${(error as Error).message || 'Unknown error'}`
      }
    };
  }
};
