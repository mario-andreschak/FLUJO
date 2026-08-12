'use client';

import { MessageState } from '../types';
import { parseRepositoryConfig } from '@/utils/mcp/configparse';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';
import { createLogger } from '@/utils/logger';
import { translate, type Translator } from '@/frontend/i18n';

const log = createLogger('frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/configDetection');
const englishTranslator: Translator = (key, values) => translate('en', key, values);

/**
 * Detect and parse configuration from a cloned repository
 */
export async function detectRepositoryConfig(
  repoPath: string,
  repoName: string,
  owner?: string,
  t: Translator = englishTranslator
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
        message: {
          type: 'success',
          text: t('mcp.github.detectionSuccess')
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
          rootPath: repoPath,
          _buildCommand: '',
          _installCommand: '',
        },
        message: {
          type: 'warning',
          text: t('mcp.github.detectionFailed')
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
        rootPath: repoPath,
        _buildCommand: '',
        _installCommand: '',
      },
      message: {
        type: 'error',
        text: t('mcp.github.detectionError', { error: error instanceof Error ? error.message : t('mcp.server.unknownError') })
      },
      success: false
    };
  }
}
