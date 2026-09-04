import { transcribe } from '@/frontend/services/transcription';
import {
  startLiveTranscription,
} from '@/frontend/services/transcription/webSpeech';

describe('live Web Speech transcription', () => {
  class MockSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: ((event: any) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    startCount = 0;
    stopCount = 0;
    abortCount = 0;

    start() {
      this.startCount += 1;
    }

    stop() {
      this.stopCount += 1;
      queueMicrotask(() => this.onend?.());
    }

    abort() {
      this.abortCount += 1;
      queueMicrotask(() => this.onend?.());
    }
  }

  let recognition!: MockSpeechRecognition;

  beforeEach(() => {
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: class extends MockSpeechRecognition {
        constructor() {
          super();
          recognition = this;
        }
      },
    });
  });

  afterEach(() => {
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
  });

  it('accumulates final results and preserves the configured language', async () => {
    const interimResult = jest.fn();
    const session = startLiveTranscription({
      language: 'en-US',
      onInterimResult: interimResult,
    });

    recognition.onresult?.({
      resultIndex: 0,
      results: [
        {
          isFinal: true,
          0: { transcript: 'hello' },
        },
        {
          isFinal: false,
          0: { transcript: ' wor' },
        },
      ],
    });
    recognition.onresult?.({
      resultIndex: 0,
      results: [
        {
          isFinal: true,
          0: { transcript: 'world' },
        },
      ],
    });

    await expect(session.stop()).resolves.toBe('hello world');
    await expect(session.stop()).resolves.toBe('hello world');
    expect(recognition.lang).toBe('en-US');
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    expect(interimResult).toHaveBeenCalledWith('hello  wor');
    expect(recognition.startCount).toBe(1);
    expect(recognition.stopCount).toBe(1);
    expect(recognition.onresult).toBeNull();
    expect(recognition.onend).toBeNull();
    expect(recognition.onerror).toBeNull();
  });

  it('resolves an empty transcript when no final result is detected', async () => {
    const session = startLiveTranscription();

    await expect(session.stop()).resolves.toBe('');
  });

  it('restarts recognition if the browser ends it while recording', async () => {
    const session = startLiveTranscription();

    recognition.onend?.();

    expect(recognition.startCount).toBe(2);
    await expect(session.stop()).resolves.toBe('');
  });

  it('rejects a terminal recognition error', async () => {
    const session = startLiveTranscription();

    recognition.onerror?.({ error: 'not-allowed' });

    expect(recognition.abortCount).toBe(1);
    await expect(session.stop()).rejects.toThrow(
      'Speech recognition error: not-allowed',
    );
  });

  it('keeps listening after a no-speech event', async () => {
    const session = startLiveTranscription();

    recognition.onerror?.({ error: 'no-speech' });

    expect(recognition.abortCount).toBe(0);
    await expect(session.stop()).resolves.toBe('');
  });

  it('cancels recognition without reporting an error', async () => {
    const session = startLiveTranscription();

    session.cancel();

    expect(recognition.abortCount).toBe(1);
    await expect(session.stop()).resolves.toBe('');
  });
});

describe('prerecorded transcription boundary', () => {
  it('does not report a prerecorded Blob as a successful Web Speech transcript', async () => {
    const onStatusChange = jest.fn();

    await expect(
      transcribe(new Blob(['audio'], { type: 'audio/webm' }), {
        onStatusChange,
      }),
    ).resolves.toEqual({
      text: '',
      success: false,
      error: 'Pre-recorded audio transcription requires a file-capable provider',
    });
    expect(onStatusChange).toHaveBeenCalledWith('Transcription unavailable');
  });

  it('returns a rejected promise when a callback fails', async () => {
    const callbackError = new Error('status callback failed');

    await expect(
      transcribe(new Blob(['audio']), {
        onStatusChange: () => {
          throw callbackError;
        },
      }),
    ).rejects.toBe(callbackError);
  });
});
