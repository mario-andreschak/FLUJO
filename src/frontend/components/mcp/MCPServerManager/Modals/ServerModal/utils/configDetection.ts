'use client';

import { MessageState } from '../types';
import { parseRepositoryConfig } from '@/utils/mcp/configparse';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/configDetection');

/**
 * Detect and parse configuration from a cloned repository
 */
export async function detectRepositoryConfig(
  repoPath: string,
  repoName: string,
  owner?: string
): Promise<{
  config: Partial<MCPServerConfig>;
  message: MessageState;
  success: boolean;
  language?: string;
}> {
  try {
    log.debug(`Detecting configuration for repository: ${repoPath}`);
    
    // Parse repository configuration
    const result = await parseRepositoryConfig({
      repoPath,
      repoName,
      owner
    });
    
    if (result.detected && result.config) {
      log.debug(`Configuration detected for ${repoPath}`, { language: result.language });
      
      return {
        config: result.config,
        message: result.message || {
          type: 'success',
          text: `Configuration detected successfully.`
        },
        success: true,
        language: result.language
      };
    } else {
      log.debug(`No configuration detected for ${repoPath}`);
      
      // Return a default configuration with a warning message
      return {
        config: {
          name: repoName,
          transport: 'stdio',
          command: '',
          args: [],
          env: {},
          disabled: false,
          autoApprove: [],
          rootPath: repoPath,
          _buildCommand: '',
          _installCommand: '',
        },
        message: result.message || {
          type: 'warning',
          text: 'Could not detect repository configuration. Please configure manually.'
        },
        success: false,
        language: result.language
      };
    }
  } catch (error) {
    log.error(`Error detecting configuration for ${repoPath}:`, error);
    
    // Return a default configuration with an error message
    return {
      config: {
        name: repoName,
        transport: 'stdio',
        command: '',
        args: [],
        env: {},
        disabled: false,
        autoApprove: [],
        rootPath: repoPath,
        _buildCommand: '',
        _installCommand: '',
      },
      message: {
        type: 'error',
        text: `Error detecting configuration: ${error instanceof Error ? error.message : 'Unknown error'}`
      },
      success: false
    };
  }
}
