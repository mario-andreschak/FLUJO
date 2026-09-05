import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/transcription/webSpeech');

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const isSpeechRecognitionSupported = () => {
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
};

const getSpeechRecognition = () => {
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
};

export interface LiveTranscriptionOptions {
  language?: string;
  onInterimResult?: (text: string) => void;
}

export interface LiveTranscriptionSession {
  stop(): Promise<string>;
  cancel(): void;
}

/**
 * Starts browser speech recognition against the live microphone input.
 *
 * The Web Speech API cannot consume a prerecorded Blob. Callers must start this
 * session while MediaRecorder is recording and stop both at the same time.
 */
export function startLiveTranscription(
  options: LiveTranscriptionOptions = {},
): LiveTranscriptionSession {
  if (typeof window === 'undefined') {
    throw new Error('Web Speech API is only available in browser environments');
  }

  if (!isSpeechRecognitionSupported()) {
    throw new Error('Web Speech API is not supported in this browser');
  }

  const SpeechRecognition = getSpeechRecognition();
  if (!SpeechRecognition) {
    throw new Error('Web Speech API is not supported in this browser');
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  if (options.language) {
    recognition.lang = options.language;
  }

  let finalTranscript = '';
  let state: 'running' | 'stopping' | 'ended' | 'failed' | 'cancelled' = 'running';
  let recognitionError: Error | null = null;
  let stopPromise: Promise<string> | null = null;
  let resolveStop: ((text: string) => void) | null = null;
  let rejectStop: ((error: Error) => void) | null = null;

  const detachHandlers = () => {
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
  };

  const settleStop = () => {
    if (!stopPromise) return;

    detachHandlers();
    if (recognitionError) {
      rejectStop?.(recognitionError);
    } else {
      resolveStop?.(state === 'cancelled' ? '' : finalTranscript.trim());
    }
    resolveStop = null;
    rejectStop = null;
  };

  recognition.onresult = (event) => {
    if (state !== 'running' && state !== 'stopping') return;

    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += `${transcript} `;
      } else {
        interimTranscript += transcript;
      }
    }

    options.onInterimResult?.(
      `${finalTranscript}${interimTranscript}`.trim(),
    );

    log.debug('Recognition result received', {
      finalLength: finalTranscript.length,
      interimLength: interimTranscript.length,
    });
  };

  recognition.onerror = (event) => {
    if (state === 'cancelled' || state === 'failed' || state === 'ended') return;

    if (event.error === 'no-speech') {
      log.debug('No speech detected before recognition ended');
      return;
    }

    recognitionError = new Error(`Speech recognition error: ${event.error}`);
    state = 'failed';
    log.error('Recognition error', { error: event.error });

    try {
      if (recognition.abort) {
        recognition.abort();
      } else {
        recognition.stop();
      }
    } catch (error) {
      log.debug('Speech recognition was already stopped after an error', {
        error,
      });
    }

    settleStop();
  };

  recognition.onend = () => {
    if (state === 'running') {
      try {
        recognition.start();
        log.debug('Live speech recognition restarted');
        return;
      } catch (error) {
        recognitionError = error instanceof Error
          ? error
          : new Error(String(error));
        state = 'failed';
      }
    } else if (state !== 'cancelled' && state !== 'failed') {
      state = 'ended';
    }

    settleStop();
  };

  try {
    recognition.start();
    log.debug('Live speech recognition started');
  } catch (error) {
    detachHandlers();
    throw error;
  }

  return {
    stop: () => {
      if (stopPromise) return stopPromise;

      stopPromise = new Promise<string>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });

      if (state === 'ended' || state === 'failed' || state === 'cancelled') {
        Promise.resolve().then(settleStop);
        return stopPromise;
      }

      state = 'stopping';
      try {
        recognition.stop();
      } catch (error) {
        log.debug('Speech recognition was already stopped', { error });
        state = 'ended';
        settleStop();
      }

      return stopPromise;
    },
    cancel: () => {
      if (state === 'cancelled') return;

      state = 'cancelled';
      try {
        if (recognition.abort) {
          recognition.abort();
        } else {
          recognition.stop();
        }
      } catch (error) {
        log.debug('Speech recognition was already stopped', { error });
      }
      detachHandlers();
      resolveStop?.('');
      resolveStop = null;
      rejectStop = null;
    },
  };
}

/**
 * Simple check to see if Web Speech API is working in this browser.
 */
export function checkWebSpeechSupport(): { supported: boolean; message?: string } {
  if (typeof window === 'undefined') {
    return { supported: false, message: 'Not in browser environment' };
  }

  return {
    supported: isSpeechRecognitionSupported(),
    message: isSpeechRecognitionSupported()
      ? 'Web Speech API is supported'
      : 'Web Speech API is not supported in this browser',
  };
}
