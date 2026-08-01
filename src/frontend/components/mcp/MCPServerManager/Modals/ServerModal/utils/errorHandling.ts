'use client';

import { MessageState } from '../types';
import { createLogger } from '@/utils/logger';
import { translate, type Translator } from '@/frontend/i18n';

const log = createLogger('frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/errorHandling');
const englishTranslator: Translator = (key, values) => translate('en', key, values);

/**
 * Create a user-friendly error message for configuration detection failures
 */
export function createConfigDetectionErrorMessage(error: unknown, t: Translator = englishTranslator): MessageState {
  log.error('Configuration detection error:', error);
  
  const details = error instanceof Error ? error.message : typeof error === 'string' ? error : t('mcp.server.unknownError');
  
  return {
    type: 'error',
    text: t('mcp.github.detectionError', { error: details })
  };
}

/**
 * Create a user-friendly error message for repository cloning failures
 */
export function createCloneErrorMessage(error: unknown, t: Translator = englishTranslator): MessageState {
  log.error('Repository cloning error:', error);
  
  const details = error instanceof Error ? error.message : typeof error === 'string' ? error : t('mcp.server.unknownError');
  
  return {
    type: 'error',
    text: t('mcp.github.cloneError', { error: details })
  };
}

/**
 * Create a user-friendly warning message for empty configuration
 */
export function createEmptyConfigWarningMessage(language?: string, t: Translator = englishTranslator): MessageState {
  return {
    type: 'warning',
    text: language
      ? t('mcp.github.noConfigLanguage', { language })
      : t('mcp.github.noConfig')
  };
}

/**
 * Create a user-friendly success message for configuration detection
 */
export function createConfigDetectionSuccessMessage(language?: string, t: Translator = englishTranslator): MessageState {
  return {
    type: 'success',
    text: t('mcp.github.detectionSuccess')
  };
}
