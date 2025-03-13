'use client';

import { MessageState } from '../types';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/errorHandling');

/**
 * Create a user-friendly error message for configuration detection failures
 */
export function createConfigDetectionErrorMessage(error: unknown): MessageState {
  log.error('Configuration detection error:', error);
  
  let errorMessage = 'Failed to detect repository configuration.';
  
  if (error instanceof Error) {
    errorMessage = `${errorMessage} ${error.message}`;
  } else if (typeof error === 'string') {
    errorMessage = `${errorMessage} ${error}`;
  }
  
  return {
    type: 'error',
    text: errorMessage
  };
}

/**
 * Create a user-friendly error message for repository cloning failures
 */
export function createCloneErrorMessage(error: unknown): MessageState {
  log.error('Repository cloning error:', error);
  
  let errorMessage = 'Failed to clone repository.';
  
  if (error instanceof Error) {
    errorMessage = `${errorMessage} ${error.message}`;
  } else if (typeof error === 'string') {
    errorMessage = `${errorMessage} ${error}`;
  }
  
  return {
    type: 'error',
    text: errorMessage
  };
}

/**
 * Create a user-friendly warning message for empty configuration
 */
export function createEmptyConfigWarningMessage(language?: string): MessageState {
  const languageText = language ? ` for ${language}` : '';
  
  return {
    type: 'warning',
    text: `No configuration detected${languageText}. Please configure manually.`
  };
}

/**
 * Create a user-friendly success message for configuration detection
 */
export function createConfigDetectionSuccessMessage(language?: string): MessageState {
  const languageText = language ? ` for ${language}` : '';
  
  return {
    type: 'success',
    text: `Configuration detected successfully${languageText}.`
  };
}
