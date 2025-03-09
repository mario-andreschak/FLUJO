import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/transcription/webSpeech');

// Check if the Web Speech API is available
const isSpeechRecognitionSupported = () => {
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
};

// Get the appropriate SpeechRecognition constructor based on browser support
const getSpeechRecognition = () => {
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
};

/**
 * Transcribes audio data using the Web Speech API
 * This is a fallback when Whisper.js isn't working
 */
export async function transcribeWithWebSpeech(
  audioBlob: Blob,
  options?: {
    language?: string;
    onInterimResult?: (text: string) => void;
  }
): Promise<string> {
  // Check if we're in a browser environment
  if (typeof window === 'undefined') {
    throw new Error('Web Speech API is only available in browser environments');
  }
  
  // Check if the browser supports the Web Speech API
  if (!isSpeechRecognitionSupported()) {
    throw new Error('Web Speech API is not supported in this browser');
  }

  log.debug('Starting Web Speech API transcription');
  
  try {
    // Create a URL for the audio blob
    const audioUrl = URL.createObjectURL(audioBlob);
    
    // Create an audio element to play the recording
    const audio = new Audio(audioUrl);
    
    // Create a SpeechRecognition instance
    const SpeechRecognition = getSpeechRecognition();
    const recognition = new SpeechRecognition();
    
    // Configure recognition
    recognition.continuous = true;
    recognition.interimResults = true;
    
    // Set language if provided, otherwise use browser default
    if (options?.language) {
      recognition.lang = options.language;
    }
    
    // Promise to handle the recognition process
    return new Promise((resolve, reject) => {
      let finalTranscript = '';
      
      // Handle recognition results
      recognition.onresult = (event: any) => {
        let interimTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          
          if (event.results[i].isFinal) {
            finalTranscript += transcript + ' ';
          } else {
            interimTranscript += transcript;
          }
        }
        
        // Call interim result callback if provided
        if (options?.onInterimResult) {
          options.onInterimResult(finalTranscript + interimTranscript);
        }
        
        log.debug('Recognition interim result', { 
          finalLength: finalTranscript.length,
          interimLength: interimTranscript.length
        });
      };
      
      // Handle recognition end
      recognition.onend = () => {
        log.debug('Recognition ended', { transcriptLength: finalTranscript.length });
        resolve(finalTranscript.trim());
      };
      
      // Handle errors
      recognition.onerror = (event: any) => {
        log.error('Recognition error', { error: event.error });
        reject(new Error(`Speech recognition error: ${event.error}`));
      };
      
      // Start recognition as we play the audio
      audio.onplay = () => {
        recognition.start();
        log.debug('Recognition started');
      };
      
      // End recognition when audio ends
      audio.onended = () => {
        recognition.stop();
        log.debug('Audio playback ended');
      };
      
      // Handle audio errors
      audio.onerror = (err) => {
        log.error('Audio playback error', { error: err });
        recognition.stop();
        reject(new Error('Error playing audio'));
      };
      
      // Start playing the audio
      audio.play().catch(err => {
        log.error('Error starting audio playback', { error: err });
        reject(err);
      });
    });
  } catch (error) {
    log.error('Error in Web Speech API transcription', { error });
    throw error;
  }
}

/**
 * Simple check to see if Web Speech API is working in this browser
 */
export function checkWebSpeechSupport(): { supported: boolean; message?: string } {
  if (typeof window === 'undefined') {
    return { supported: false, message: 'Not in browser environment' };
  }
  
  return { 
    supported: isSpeechRecognitionSupported(),
    message: isSpeechRecognitionSupported() 
      ? 'Web Speech API is supported' 
      : 'Web Speech API is not supported in this browser'
  };
}