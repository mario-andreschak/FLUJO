import { createLogger } from '@/utils/logger';
import { transcribeWithWebSpeech, checkWebSpeechSupport } from './webSpeech';

const log = createLogger('frontend/services/transcription');

export interface TranscriptionOptions {
  onProgress?: (progress: number) => void;
  onStatusChange?: (status: string) => void;
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  success: boolean;
  error?: string;
  engine?: 'webspeech';
}

/**
 * Transcribes audio data to text using Web Speech API
 */
// Check if Web Speech API is supported
export const isSpeechSupported = checkWebSpeechSupport;

/**
 * Use this function to check if speech recognition is available
 * on the current browser before attempting transcription
 */
export function checkSpeechSupport() {
  return checkWebSpeechSupport();
}

export async function transcribe(
  audioBlob: Blob,
  options: TranscriptionOptions = {}
): Promise<TranscriptionResult> {
  // Check if we're in a browser environment
  if (typeof window === 'undefined') {
    return {
      text: 'Speech recognition is only available in browser environments',
      success: false,
      error: 'Server-side transcription is not supported'
    };
  }

  const {
    onProgress,
    onStatusChange,
    language
  } = options;
  
  try {
    log.debug('Starting transcription service');
    
    if (onStatusChange) {
      onStatusChange('Initializing transcription...');
    }
    
    // Check if Web Speech API is supported
    const webSpeechStatus = checkWebSpeechSupport();
    if (!webSpeechStatus.supported) {
      throw new Error('Web Speech API is not supported in this browser');
    }
    
    if (onStatusChange) {
      onStatusChange('Using browser speech recognition...');
    }
    
    // Using Web Speech API
    const text = await transcribeWithWebSpeech(audioBlob, {
      language,
      onInterimResult: (interim) => {
        if (onStatusChange) {
          onStatusChange(`Transcribing: ${interim}`);
        }
        
        if (onProgress) {
          // Simulate progress for Web Speech API (doesn't have real progress)
          onProgress(50);
        }
      }
    });
    
    if (onStatusChange) {
      onStatusChange('Transcription completed');
    }
    
    log.debug('Web Speech API transcription completed successfully', { textLength: text.length });
    
    return {
      text,
      success: true,
      engine: 'webspeech'
    };
  } catch (error) {
    log.error('Transcription failed', { error });
    
    if (onStatusChange) {
      onStatusChange('Transcription failed');
    }
    
    return {
      text: 'Transcription failed. Please check if your browser supports speech recognition.',
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}