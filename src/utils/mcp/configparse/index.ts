'use client';

import { ConfigParseOptions, ConfigParseResult } from './types';
import { parseTypeScriptConfig } from './typescript';
import { parsePythonConfig } from './python';
import { parseJavaConfig } from './java';
import { parseKotlinConfig } from './kotlin';
import { createLogger } from '@/utils/logger';
import { parseConfigFromReadme } from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/configUtils';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';

const log = createLogger('utils/mcp/configparse/index');

/**
 * Parse repository configuration by trying different language-specific parsers
 * and falling back to README parsing if needed
 */
export async function parseRepositoryConfig(options: ConfigParseOptions): Promise<ConfigParseResult> {
  const { repoPath, repoName } = options;
  
  log.debug(`Parsing repository configuration for ${repoPath}`);
  
  // Try TypeScript/JavaScript parser first
  log.debug(`Trying TypeScript/JavaScript parser for ${repoPath}`);
  const tsResult = await parseTypeScriptConfig(options);
  if (tsResult.detected) {
    log.debug(`TypeScript/JavaScript configuration detected for ${repoPath}`);
    return tsResult;
  }
  
  // Try Python parser
  log.debug(`Trying Python parser for ${repoPath}`);
  const pythonResult = await parsePythonConfig(options);
  if (pythonResult.detected) {
    log.debug(`Python configuration detected for ${repoPath}`);
    return pythonResult;
  }
  
  // Try Java parser
  log.debug(`Trying Java parser for ${repoPath}`);
  const javaResult = await parseJavaConfig(options);
  if (javaResult.detected) {
    log.debug(`Java configuration detected for ${repoPath}`);
    return javaResult;
  }
  
  // Try Kotlin parser
  log.debug(`Trying Kotlin parser for ${repoPath}`);
  const kotlinResult = await parseKotlinConfig(options);
  if (kotlinResult.detected) {
    log.debug(`Kotlin configuration detected for ${repoPath}`);
    return kotlinResult;
  }
  
  // If no language-specific configuration was detected, try parsing README
  log.debug(`No language-specific configuration detected, trying README parsing for ${repoPath}`);
  const readmeResult = await parseReadmeConfig(repoPath, repoName);
  
  if (readmeResult.detected) {
    log.debug(`Configuration extracted from README for ${repoPath}`);
    return readmeResult;
  }
  
  // If all else fails, return a default configuration with an error message
  log.debug(`No configuration detected for ${repoPath}, returning default configuration`);
  return {
    detected: false,
    language: 'unknown',
    message: {
      type: 'error',
      text: 'Could not detect repository configuration. Please configure manually.'
    },
    config: {
      name: repoName,
      transport: 'stdio',
      command: '',
      args: [],
      env: {},
      _buildCommand: '',
      _installCommand: ''
    }
  };
}

/**
 * Parse repository configuration from README
 */
async function parseReadmeConfig(repoPath: string, repoName: string): Promise<ConfigParseResult> {
  try {
    // Construct the README path
    const readmePath = `${repoPath}/README.md`;
    
    // Prepare request body with savePath parameter
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
    
    if (!readmeResponse.ok) {
      log.debug(`Failed to read README file from ${repoPath}`);
      return {
        detected: false,
        language: 'unknown',
        message: {
          type: 'warning',
          text: 'No README file found in the repository.'
        }
      };
    }
    
    const readmeResult = await readmeResponse.json();
    if (!readmeResult.content) {
      log.debug(`README file is empty in ${repoPath}`);
      return {
        detected: false,
        language: 'unknown',
        message: {
          type: 'warning',
          text: 'README file is empty.'
        }
      };
    }
    
    // Default config to use for README parsing
    const defaultConfig = {
      name: repoName,
      transport: 'stdio' as const,
      command: '',
      args: [],
      env: {},
      disabled: false,
      autoApprove: [],
      rootPath: repoPath,
      _buildCommand: '',
      _installCommand: '',
    };
    
    // Parse README content
    const parseResult = await parseConfigFromReadme(
      readmeResult.content,
      defaultConfig,
      repoName
    );
    
    if (parseResult.config && 
        ((parseResult.config.transport === 'stdio' && parseResult.config.command) || 
         parseResult.config._buildCommand || 
         parseResult.config._installCommand)) {
      return {
        detected: true,
        language: 'unknown',
        installCommand: parseResult.config._installCommand || '',
        buildCommand: parseResult.config._buildCommand || '',
        runCommand: parseResult.config.transport === 'stdio' ? parseResult.config.command || '' : '',
        args: parseResult.config.transport === 'stdio' ? parseResult.config.args || [] : [],
        env: parseResult.config.env || {},
        message: parseResult.message || {
          type: 'success',
          text: 'Configuration extracted from README.'
        },
        config: parseResult.config
      };
    }
    
    return {
      detected: false,
      language: 'unknown',
      message: {
        type: 'warning',
        text: 'No configuration found in README.'
      }
    };
  } catch (error) {
    log.error(`Error parsing README from ${repoPath}:`, error);
    return {
      detected: false,
      language: 'unknown',
      message: {
        type: 'error',
        text: `Error parsing README: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    };
  }
}

// Export all parsers and types
export * from './types';
export * from './utils';
export * from './typescript';
export * from './python';
export * from './java';
export * from './kotlin';
